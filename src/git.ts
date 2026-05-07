import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { taskLabel } from "./taskLabels.js";
import type { Project, Task } from "./types.js";

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

    await this.git(["config", "user.name", "Discord Codex Bot"], project.repoPath, { allowFailure: true });
    await this.git(["config", "user.email", "discord-codex-bot@example.local"], project.repoPath, { allowFailure: true });
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
    options: { reset?: boolean } = {},
  ): Promise<{ baseBranch: string; taskBranch: string; worktreePath: string }> {
    const baseBranch = await this.ensureProjectRepo(project);
    const taskBranch = `codex/task-${task.projectTaskNumber}`;
    const worktreePath = path.join(project.worktreesPath, `task-${task.projectTaskNumber}`);

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
    await this.git(["config", "user.name", "Discord Codex Bot"], worktreePath, { allowFailure: true });
    await this.git(["config", "user.email", "discord-codex-bot@example.local"], worktreePath, { allowFailure: true });
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
    if (changed.length === 0) {
      return "No file changes.";
    }
    await this.git(["add", "-A"], worktreePath);
    const stat = await this.gitOutput(["diff", "--cached", "--stat", "HEAD"], worktreePath, { allowFailure: true });
    if (!stat.trim()) {
      return "No file changes.";
    }
    await this.git(["commit", "-m", message], worktreePath);
    return stat.trim() || `${changed.length} changed file(s).`;
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
