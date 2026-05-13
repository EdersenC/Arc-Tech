import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { taskLabel } from "./taskLabels.js";
import type { Project, Task } from "./types.js";
import type { GitDiffFacts, GitDiffFile } from "./pr-stager/Types.js";

interface GitHubRepoRef {
  owner: string;
  repo: string;
}

interface GitHubPullRequestResponse {
  number: number;
  html_url?: string | null;
}

const ARC_TECH_BOT_NAME = "Arc-Tech Bot";
const ARC_TECH_BOT_EMAIL = "arc-tech-bot@example.local";

export class GitManager {
  async ensureProjectRepo(project: Project): Promise<string> {
    await fs.mkdir(project.repoPath, { recursive: true });
    await fs.mkdir(project.worktreesPath, { recursive: true });

    if (!(await this.isGitRepo(project.repoPath))) {
      await execa("git", ["init", "-b", "main"], { cwd: project.repoPath, reject: false });
      if (!(await this.branchExists(project.repoPath, "main"))) {
        await this.git(["checkout", "-B", "main"], project.repoPath);
      }
    }

    await this.git(["config", "user.name", ARC_TECH_BOT_NAME], project.repoPath, { allowFailure: true });
    await this.git(["config", "user.email", ARC_TECH_BOT_EMAIL], project.repoPath, { allowFailure: true });
    if ((await this.git(["rev-parse", "--verify", "HEAD"], project.repoPath, { allowFailure: true })).exitCode !== 0) {
      await this.git(["commit", "--allow-empty", "-m", "Initial project workspace"], project.repoPath);
    }

    const remoteDefault = await this.detectRemoteDefaultBranch(project.repoPath);
    if (remoteDefault && (await this.branchExists(project.repoPath, remoteDefault))) {
      return remoteDefault;
    }
    return (await this.branchExists(project.repoPath, "main")) ? "main" : "master";
  }

  async createTaskWorktree(
    project: Project,
    task: Task,
    options: { reset?: boolean; branchName?: string; worktreeName?: string } = {},
  ): Promise<{ baseBranch: string; taskBranch: string; worktreePath: string }> {
    const baseBranch = await this.ensureProjectRepo(project);
    const taskBranch = options.branchName ?? `codex/task-${task.projectTaskNumber}`;
    const worktreePath = path.join(project.worktreesPath, options.worktreeName ?? `task-${task.projectTaskNumber}`);

    if (!options.reset && (await this.isGitRepo(worktreePath))) {
      return { baseBranch, taskBranch, worktreePath };
    }

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    if (options.reset) {
      await this.git(["worktree", "remove", "--force", worktreePath], project.repoPath, { allowFailure: true });
      await this.git(["branch", "-D", taskBranch], project.repoPath, { allowFailure: true });
    }
    await fs.rm(worktreePath, { recursive: true, force: true });
    if (await this.branchExists(project.repoPath, taskBranch)) {
      await this.git(["worktree", "add", worktreePath, taskBranch], project.repoPath);
    } else {
      await this.git(["worktree", "add", "-b", taskBranch, worktreePath, baseBranch], project.repoPath);
    }
    await this.git(["config", "user.name", ARC_TECH_BOT_NAME], worktreePath, { allowFailure: true });
    await this.git(["config", "user.email", ARC_TECH_BOT_EMAIL], worktreePath, { allowFailure: true });
    await this.ensureWorktreeExclude(worktreePath, ".codex-tmp/");
    return { baseBranch, taskBranch, worktreePath };
  }

  async getProjectOrigin(project: Project): Promise<string | null> {
    await this.ensureProjectRepo(project);
    const result = await this.git(["remote", "get-url", "origin"], project.repoPath, { allowFailure: true });
    if (result.exitCode !== 0) {
      return null;
    }
    const remote = String(result.stdout ?? "").trim();
    return remote || null;
  }

  async setProjectOrigin(project: Project, remoteUrl: string): Promise<void> {
    await this.ensureProjectRepo(project);
    const existing = await this.git(["remote", "get-url", "origin"], project.repoPath, { allowFailure: true });
    if (existing.exitCode === 0) {
      await this.git(["remote", "set-url", "origin", remoteUrl], project.repoPath);
      return;
    }
    await this.git(["remote", "add", "origin", remoteUrl], project.repoPath);
  }

  async setProjectOriginAndPull(project: Project, remoteUrl: string): Promise<{ baseBranch: string; summary: string }> {
    await this.setProjectOrigin(project, remoteUrl);
    return this.pullProjectOrigin(project);
  }

  async pullProjectOrigin(project: Project): Promise<{ baseBranch: string; summary: string }> {
    await this.ensureProjectRepo(project);
    await this.git(["fetch", "--prune", "origin"], project.repoPath);

    const baseBranch = await this.detectRemoteDefaultBranch(project.repoPath);
    if (!baseBranch) {
      throw new Error("Could not determine the remote default branch after fetching origin.");
    }

    const remoteRef = `origin/${baseBranch}`;
    if (!(await this.branchExists(project.repoPath, baseBranch))) {
      await this.git(["checkout", "-B", baseBranch, remoteRef], project.repoPath);
      await this.git(["branch", "--set-upstream-to", remoteRef, baseBranch], project.repoPath, { allowFailure: true });
      return { baseBranch, summary: `Fetched origin and checked out ${remoteRef}.` };
    }

    await this.git(["checkout", baseBranch], project.repoPath);
    const canFastForward = await this.git(["merge-base", "--is-ancestor", "HEAD", remoteRef], project.repoPath, { allowFailure: true });
    if (canFastForward.exitCode === 0) {
      await this.git(["merge", "--ff-only", remoteRef], project.repoPath);
      await this.git(["branch", "--set-upstream-to", remoteRef, baseBranch], project.repoPath, { allowFailure: true });
      return { baseBranch, summary: `Fetched origin and fast-forwarded ${baseBranch} from ${remoteRef}.` };
    }

    if (await this.isInitialEmptyWorkspaceCommit(project.repoPath)) {
      await this.git(["checkout", "-B", baseBranch, remoteRef], project.repoPath);
      await this.git(["branch", "--set-upstream-to", remoteRef, baseBranch], project.repoPath, { allowFailure: true });
      return { baseBranch, summary: `Fetched origin and replaced the initial empty workspace with ${remoteRef}.` };
    }

    throw new Error(
      `Local ${baseBranch} is not a fast-forward of ${remoteRef}. Resolve the divergence manually before starting a new task.`,
    );
  }

  async commitTaskChanges(task: Task, message: string): Promise<string> {
    const worktreePath = requireWorktree(task);
    await this.removeCodexTempDir(worktreePath);
    const changed = await this.changedFiles(worktreePath);
    if (changed.length > 0) {
      await this.git(["add", "-A"], worktreePath);
      const cachedStat = await this.gitOutput(["diff", "--cached", "--stat", "HEAD"], worktreePath, { allowFailure: true });
      if (cachedStat.trim()) {
        await this.git(["commit", "-m", message], worktreePath);
      }
    }

    const baseBranch = task.baseBranch ?? "main";
    const branchStat = await this.gitOutput(["diff", "--stat", `${baseBranch}...HEAD`], worktreePath, { allowFailure: true });
    return branchStat.trim() || "No file changes.";
  }

  async createTaskPullRequest(
    task: Task,
    title: string,
    body: string,
    options: { remote?: string; baseBranch?: string } = {},
  ): Promise<string> {
    const worktreePath = requireWorktree(task);
    const taskBranch = requireBranch(task);
    const baseBranch = task.baseBranch ?? options.baseBranch ?? "main";
    const remote = options.remote ?? "origin";
    await this.git(["push", "-u", remote, `HEAD:${taskBranch}`], worktreePath);

    const repo = await this.requireGitHubRepoForRemote(worktreePath, remote);
    const existing = await this.findOpenPullRequest(repo, taskBranch, worktreePath);
    if (existing?.html_url) {
      await this.updatePullRequest(repo, existing.number, title, body, worktreePath);
      return existing.html_url;
    }

    const created = await this.createPullRequest(repo, baseBranch, taskBranch, title, body, worktreePath);
    if (!created.html_url) {
      throw new Error(`GitHub API created PR #${created.number}, but did not return html_url.`);
    }
    return created.html_url;
  }

  async getTaskPullRequestDiffFacts(task: Task, options: { baseBranch?: string } = {}): Promise<GitDiffFacts> {
    const worktreePath = requireWorktree(task);
    const baseBranch = task.baseBranch ?? options.baseBranch ?? "main";
    const headBranch = task.taskBranch ?? "HEAD";
    const range = `${baseBranch}...HEAD`;
    const stat = (await this.gitOutput(["diff", "--stat", range], worktreePath, { allowFailure: true })).trim();
    const nameStatus = await this.gitOutput(["diff", "--name-status", "--find-renames", range], worktreePath, { allowFailure: true });
    const numstat = await this.gitOutput(["diff", "--numstat", range], worktreePath, { allowFailure: true });
    return {
      baseBranch,
      headBranch,
      stat,
      files: mergeDiffFiles(parseNameStatus(nameStatus), parseNumstat(numstat)),
    };
  }

  async getDiffStat(task: Task): Promise<string> {
    const worktreePath = requireWorktree(task);
    await this.removeCodexTempDir(worktreePath);
    const baseBranch = task.baseBranch ?? "main";
    const stat = await this.gitOutput(["diff", "--stat", `${baseBranch}...HEAD`], worktreePath, { allowFailure: true });
    const uncommitted = await this.gitOutput(["diff", "--stat"], worktreePath, { allowFailure: true });
    return [stat.trim(), uncommitted.trim()].filter(Boolean).join("\n") || "No diff.";
  }

  async mergeTaskToMain(project: Project, task: Task): Promise<string> {
    const taskBranch = requireBranch(task);
    const baseBranch = task.baseBranch ?? "main";
    await this.ensureProjectRepo(project);
    await this.git(["checkout", baseBranch], project.repoPath);
    const before = await this.gitOutput(["rev-parse", "HEAD"], project.repoPath);
    await this.git(["merge", "--no-ff", taskBranch, "-m", `Merge Codex task ${taskLabel(task)}`], project.repoPath);
    const stat = await this.gitOutput(["diff", "--stat", `${before.trim()}..HEAD`], project.repoPath, { allowFailure: true });
    return stat.trim() || "Merged with no file changes.";
  }

  async cleanupTaskWorktree(project: Project, task: Task): Promise<void> {
    if (!task.worktreePath) {
      return;
    }
    await this.ensureProjectRepo(project);
    await this.git(["worktree", "remove", "--force", task.worktreePath], project.repoPath, { allowFailure: true });
    await fs.rm(task.worktreePath, { recursive: true, force: true });
  }

  private async changedFiles(cwd: string): Promise<string[]> {
    const output = await this.gitOutput(["status", "--porcelain=v1"], cwd, { allowFailure: true });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.includes(".codex-tmp/") && !line.endsWith(".codex-tmp"));
  }

  private async isGitRepo(cwd: string): Promise<boolean> {
    const result = await execa("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { reject: false });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  private async branchExists(cwd: string, branch: string): Promise<boolean> {
    const result = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd, { allowFailure: true });
    return result.exitCode === 0;
  }

  private async detectRemoteDefaultBranch(cwd: string): Promise<string | null> {
    const symbolic = await this.gitOutput(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd, { allowFailure: true });
    const symbolicBranch = symbolic.trim().replace(/^origin\//, "");
    if (symbolicBranch) {
      return symbolicBranch;
    }

    const refs = await this.gitOutput(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], cwd, {
      allowFailure: true,
    });
    const branches = refs
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line !== "origin/HEAD")
      .map((line) => line.replace(/^origin\//, ""));
    if (branches.includes("main")) return "main";
    if (branches.includes("master")) return "master";
    return branches[0] ?? null;
  }

  private async isInitialEmptyWorkspaceCommit(cwd: string): Promise<boolean> {
    const subject = (await this.gitOutput(["log", "-1", "--format=%s"], cwd, { allowFailure: true })).trim();
    if (subject !== "Initial project workspace") {
      return false;
    }
    const files = (await this.gitOutput(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], cwd, {
      allowFailure: true,
    })).trim();
    return files.length === 0;
  }

  private async git(args: string[], cwd: string, options: { allowFailure?: boolean } = {}) {
    const result = await execa("git", args, { cwd, reject: false, all: true });
    if (!options.allowFailure && result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${String(result.all ?? result.stderr)}`);
    }
    return result;
  }

  private async gh(args: string[], cwd: string, options: { allowFailure?: boolean } = {}) {
    const result = await execa("gh", args, { cwd, reject: false, all: true });
    if (!options.allowFailure && result.exitCode !== 0) {
      throw new Error(`gh ${args.join(" ")} failed: ${String(result.all ?? result.stderr)}`);
    }
    return result;
  }

  private async requireGitHubRepoForRemote(cwd: string, remote: string): Promise<GitHubRepoRef> {
    const remoteUrl = (await this.gitOutput(["remote", "get-url", remote], cwd)).trim();
    const repo = parseGitHubRemoteUrl(remoteUrl);
    if (!repo) {
      throw new Error(`Remote ${remote} is not a GitHub remote URL: ${remoteUrl}`);
    }
    return repo;
  }

  private async findOpenPullRequest(
    repo: GitHubRepoRef,
    taskBranch: string,
    cwd: string,
  ): Promise<GitHubPullRequestResponse | null> {
    const query = new URLSearchParams({ state: "open", head: `${repo.owner}:${taskBranch}` });
    const pulls = await this.ghApiJson<GitHubPullRequestResponse[]>(`repos/${repo.owner}/${repo.repo}/pulls?${query.toString()}`, cwd);
    return pulls[0] ?? null;
  }

  private async updatePullRequest(repo: GitHubRepoRef, number: number, title: string, body: string, cwd: string): Promise<void> {
    await withTempBodyFile(body, async (bodyFile) => {
      await this.gh(["pr", "edit", String(number), "--title", title, "--body-file", bodyFile], cwd);
    });
  }

  private async createPullRequest(
    repo: GitHubRepoRef,
    baseBranch: string,
    taskBranch: string,
    title: string,
    body: string,
    cwd: string,
  ): Promise<GitHubPullRequestResponse> {
    return withTempBodyFile(body, async (bodyFile) => {
      const result = await this.gh(
        [
          "pr",
          "create",
          "--base",
          baseBranch,
          "--head",
          `${repo.owner}:${taskBranch}`,
          "--title",
          title,
          "--body-file",
          bodyFile,
        ],
        cwd,
      );
      const stdout = String(result.stdout || result.all || "").trim();
      const url = parsePullRequestUrl(stdout);
      const found = await this.findOpenPullRequest(repo, taskBranch, cwd);
      if (found) {
        return { number: found.number, html_url: found.html_url ?? url };
      }
      const number = url ? pullRequestNumberFromUrl(url) : null;
      if (!number) {
        throw new Error(`gh pr create did not return a PR URL: ${stdout}`);
      }
      return { number, html_url: url };
    });
  }

  private async ghApiJson<T>(
    endpoint: string,
    cwd: string,
    options: { method?: "GET" | "POST" | "PATCH"; fields?: Record<string, string> } = {},
  ): Promise<T> {
    const args = ["api"];
    if (options.method && options.method !== "GET") {
      args.push("-X", options.method);
    }
    args.push(endpoint);
    for (const [key, value] of Object.entries(options.fields ?? {})) {
      args.push("-f", `${key}=${value}`);
    }
    const result = await execa("gh", args, { cwd, reject: false, all: true });
    if (result.exitCode !== 0) {
      throw new Error(`gh api ${endpoint} failed: ${String(result.all ?? result.stderr)}`);
    }
    return JSON.parse(String(result.stdout || "null")) as T;
  }

  private async gitOutput(args: string[], cwd: string, options: { allowFailure?: boolean } = {}): Promise<string> {
    const result = await this.git(args, cwd, options);
    return String(result.stdout ?? "");
  }

  private async ensureWorktreeExclude(worktreePath: string, pattern: string): Promise<void> {
    const excludePath = (await this.gitOutput(["rev-parse", "--git-path", "info/exclude"], worktreePath)).trim();
    const current = await fs.readFile(excludePath, "utf8").catch(() => "");
    if (!current.split(/\r?\n/).includes(pattern)) {
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      await fs.appendFile(excludePath, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${pattern}\n`);
    }
  }

  private async removeCodexTempDir(worktreePath: string): Promise<void> {
    await fs.rm(path.join(worktreePath, ".codex-tmp"), { recursive: true, force: true });
  }
}

function parsePullRequestUrl(output: string): string | null {
  const match = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/i.exec(output);
  return match?.[0] ?? null;
}

function pullRequestNumberFromUrl(url: string): number | null {
  const value = /\/pull\/(\d+)(?:$|[/?#])/i.exec(url)?.[1];
  if (!value) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function parseNameStatus(output: string): Array<Pick<GitDiffFile, "path" | "status">> {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t+/);
      const status = parts[0] ?? "M";
      const path = parts.length >= 3 ? parts[2] : parts[1] ?? "";
      return { status: normalizeGitStatus(status), path };
    })
    .filter((file) => Boolean(file.path));
}

export function parseNumstat(output: string): Map<string, Pick<GitDiffFile, "additions" | "deletions">> {
  const stats = new Map<string, Pick<GitDiffFile, "additions" | "deletions">>();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\t+/);
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? null : Number(parts[0]);
    const deletions = parts[1] === "-" ? null : Number(parts[1]);
    const filePath = normalizeNumstatPath(parts[parts.length - 1] ?? "");
    if (filePath) {
      stats.set(filePath, {
        additions: Number.isFinite(additions) ? additions : null,
        deletions: Number.isFinite(deletions) ? deletions : null,
      });
    }
  }
  return stats;
}

function normalizeNumstatPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed.includes("=>")) return trimmed;

  const braceNormalized = trimmed.replace(/\{([^{}]*?)\s*=>\s*([^{}]*?)\}/g, "$2");
  if (!braceNormalized.includes("=>")) return braceNormalized.trim();

  return braceNormalized.split("=>").at(-1)?.trim() ?? "";
}

function mergeDiffFiles(
  files: Array<Pick<GitDiffFile, "path" | "status">>,
  stats: Map<string, Pick<GitDiffFile, "additions" | "deletions">>,
): GitDiffFile[] {
  return files.map((file) => {
    const stat = stats.get(file.path) ?? { additions: null, deletions: null };
    return { ...file, ...stat };
  });
}

function normalizeGitStatus(status: string): string {
  const first = status.charAt(0).toUpperCase();
  if (first === "A") return "added";
  if (first === "M") return "modified";
  if (first === "D") return "deleted";
  if (first === "R") return "renamed";
  if (first === "C") return "copied";
  return "changed";
}

async function withTempBodyFile<T>(body: string, fn: (bodyFile: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arc-pr-body-"));
  const bodyFile = path.join(dir, "body.md");
  try {
    await fs.writeFile(bodyFile, body, "utf8");
    return await fn(bodyFile);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function requireWorktree(task: Task): string {
  if (!task.worktreePath) {
    throw new Error(`Task ${taskLabel(task)} does not have a worktree path.`);
  }
  return task.worktreePath;
}

function requireBranch(task: Task): string {
  if (!task.taskBranch) {
    throw new Error(`Task ${taskLabel(task)} does not have a task branch.`);
  }
  return task.taskBranch;
}

function parseGitHubRemoteUrl(value: string): GitHubRepoRef | null {
  const trimmed = value.trim().replace(/\.git$/, "");
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i.exec(trimmed);
  if (https) {
    return { owner: https[1], repo: https[2] };
  }
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(trimmed);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2] };
  }
  const sshUrl = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+)$/i.exec(trimmed);
  if (sshUrl) {
    return { owner: sshUrl[1], repo: sshUrl[2] };
  }
  return null;
}
