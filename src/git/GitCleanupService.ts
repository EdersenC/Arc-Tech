import fs from "node:fs/promises";
import type Database from "better-sqlite3";
import { execa } from "execa";
import type { TaskStatus } from "../types.js";

const SAFE_TERMINAL_STATUSES = new Set<TaskStatus>(["MERGED", "ABANDONED", "CANCELED"]);

type TaskWorktreeRow = {
  task_id: number;
  project_id: number;
  project_task_number: number;
  project_name: string;
  repo_path: string;
  status: TaskStatus;
  task_branch: string | null;
  worktree_path: string;
  updated_at: string;
};

export interface GitCleanupWorktree {
  taskId: number;
  projectId: number;
  projectTaskNumber: number;
  projectName: string;
  repoPath: string;
  status: TaskStatus;
  branch: string | null;
  worktreePath: string;
  exists: boolean;
  stale: boolean;
  missing: boolean;
  hasUncommittedChanges: boolean | null;
  uncommittedSummary: string | null;
  inspectError: string | null;
  updatedAt: string;
}

export interface GitCleanupResult {
  dryRun: true;
  candidates: GitCleanupWorktree[];
  skipped: GitCleanupWorktree[];
  message: string;
}

export interface GitWorktreeDetails extends GitCleanupWorktree {
  currentBranch: string | null;
  head: string | null;
}

export class GitCleanupService {
  constructor(private readonly db: Database.Database) {}

  async listWorktrees(): Promise<GitCleanupWorktree[]> {
    const rows = this.db
      .prepare(
        `
        SELECT
          t.id AS task_id,
          t.project_id,
          t.project_task_number,
          COALESCE(NULLIF(p.project_name, ''), NULLIF(p.project_channel_name, ''), p.channel_id) AS project_name,
          p.repo_path,
          t.status,
          t.task_branch,
          t.worktree_path,
          t.updated_at
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE t.worktree_path IS NOT NULL AND t.worktree_path != ''
        ORDER BY datetime(t.updated_at) DESC, t.id DESC
      `,
      )
      .all() as TaskWorktreeRow[];

    return Promise.all(rows.map((row) => this.inspectRow(row)));
  }

  async findStaleWorktrees(): Promise<GitCleanupWorktree[]> {
    return (await this.listWorktrees()).filter((worktree) => worktree.stale);
  }

  async findMissingWorktrees(): Promise<GitCleanupWorktree[]> {
    return (await this.listWorktrees()).filter((worktree) => worktree.missing);
  }

  async cleanupMergedWorktrees(): Promise<GitCleanupResult> {
    const worktrees = await this.listWorktrees();
    const candidates = worktrees.filter((worktree) => worktree.exists && worktree.status === "MERGED");
    return dryRunResult(candidates, worktrees, "No confirmation flow exists, so merged worktree cleanup is a dry run.");
  }

  async cleanupAbandonedWorktrees(): Promise<GitCleanupResult> {
    const worktrees = await this.listWorktrees();
    const candidates = worktrees.filter(
      (worktree) => worktree.exists && (worktree.status === "ABANDONED" || worktree.status === "CANCELED"),
    );
    return dryRunResult(candidates, worktrees, "No confirmation flow exists, so abandoned/canceled worktree cleanup is a dry run.");
  }

  async pruneMissingWorktreeRecords(): Promise<GitCleanupResult> {
    const worktrees = await this.listWorktrees();
    const candidates = worktrees.filter((worktree) => worktree.missing);
    return dryRunResult(candidates, worktrees, "No confirmation flow exists, so missing worktree pruning is a dry run.");
  }

  async getWorktreeDetails(taskId: number): Promise<GitWorktreeDetails | null> {
    const row = this.db
      .prepare(
        `
        SELECT
          t.id AS task_id,
          t.project_id,
          t.project_task_number,
          COALESCE(NULLIF(p.project_name, ''), NULLIF(p.project_channel_name, ''), p.channel_id) AS project_name,
          p.repo_path,
          t.status,
          t.task_branch,
          t.worktree_path,
          t.updated_at
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE t.id = ? AND t.worktree_path IS NOT NULL AND t.worktree_path != ''
      `,
      )
      .get(taskId) as TaskWorktreeRow | undefined;
    if (!row) {
      return null;
    }

    const worktree = await this.inspectRow(row);
    if (!worktree.exists) {
      return { ...worktree, currentBranch: null, head: null };
    }

    const [currentBranch, head] = await Promise.all([
      gitOutput(["-C", worktree.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]),
      gitOutput(["-C", worktree.worktreePath, "rev-parse", "--short", "HEAD"]),
    ]);
    return {
      ...worktree,
      currentBranch: currentBranch.ok ? currentBranch.output.trim() || null : null,
      head: head.ok ? head.output.trim() || null : null,
      inspectError: worktree.inspectError ?? gitError(currentBranch) ?? gitError(head),
    };
  }

  private async inspectRow(row: TaskWorktreeRow): Promise<GitCleanupWorktree> {
    const exists = await pathExists(row.worktree_path);
    let hasUncommittedChanges: boolean | null = null;
    let uncommittedSummary: string | null = null;
    let inspectError: string | null = null;

    if (exists) {
      const status = await gitOutput(["-C", row.worktree_path, "status", "--porcelain=v1"]);
      if (status.ok) {
        const lines = status.output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line) => !line.includes(".codex-tmp/") && !line.endsWith(".codex-tmp"));
        hasUncommittedChanges = lines.length > 0;
        uncommittedSummary = lines.slice(0, 5).join("\n") || null;
      } else {
        inspectError = status.error;
      }
    }

    const missing = !exists;
    const stale = exists && SAFE_TERMINAL_STATUSES.has(row.status);
    return {
      taskId: row.task_id,
      projectId: row.project_id,
      projectTaskNumber: row.project_task_number,
      projectName: row.project_name,
      repoPath: row.repo_path,
      status: row.status,
      branch: row.task_branch,
      worktreePath: row.worktree_path,
      exists,
      stale,
      missing,
      hasUncommittedChanges,
      uncommittedSummary,
      inspectError,
      updatedAt: row.updated_at,
    };
  }
}

function dryRunResult(candidates: GitCleanupWorktree[], allWorktrees: GitCleanupWorktree[], message: string): GitCleanupResult {
  return {
    dryRun: true,
    candidates,
    skipped: allWorktrees.filter((worktree) => !candidates.includes(worktree)),
    message,
  };
}

async function pathExists(value: string): Promise<boolean> {
  return fs
    .stat(value)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}

async function gitOutput(args: string[]): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const result = await execa("git", args, { reject: false, all: true });
  if (result.exitCode !== 0) {
    return { ok: false, error: String(result.all ?? result.stderr ?? "git failed").trim() };
  }
  return { ok: true, output: String(result.stdout ?? "") };
}

function gitError(result: { ok: true; output: string } | { ok: false; error: string }): string | null {
  return result.ok ? null : result.error;
}
