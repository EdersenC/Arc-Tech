import path from "node:path";
import type Database from "better-sqlite3";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODE,
  DEFAULT_MODEL,
  type Project,
  type ProjectRemoteStatus,
  type SandboxMode,
  type Task,
  type TaskMode,
  type TaskMessage,
  type TaskMessageStatus,
  type TaskStatus,
} from "./types.js";

type ProjectRow = {
  id: number;
  guild_id: string;
  channel_id: string;
  project_channel_id: string;
  project_channel_name: string;
  project_name: string;
  project_slug: string;
  repo_path: string;
  worktrees_path: string;
  remote_url: string | null;
  remote_status: ProjectRemoteStatus;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: number;
  project_id: number;
  project_task_number: number;
  guild_id: string;
  channel_id: string;
  discord_thread_id: string | null;
  status: TaskStatus;
  merge_status: string;
  prompt: string;
  requested_by: string | null;
  mode: TaskMode;
  sandbox: SandboxMode;
  model: string;
  effort: "low" | "medium" | "high";
  base_branch: string | null;
  task_branch: string | null;
  worktree_path: string | null;
  codex_thread_id: string | null;
  live_status_message_id: string | null;
  control_panel_message_id: string | null;
  pull_request_url: string | null;
  final_summary: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type TaskMessageRow = {
  id: number;
  task_id: number;
  discord_message_id: string | null;
  discord_author_id: string | null;
  role: "user";
  content: string;
  status: TaskMessageStatus;
  created_at: string;
  processed_at: string | null;
};

export class ProjectStore {
  constructor(private readonly db: Database.Database, private readonly workspacesDir: string) {}

  getOrCreate(input: { guildId: string; channelId: string; channelName: string }): Project {
    const projectSlug = slugifyChannelName(input.channelName);
    const projectRoot = path.join(this.workspacesDir, input.guildId, `${projectSlug}-${input.channelId}`);
    const repoPath = path.join(projectRoot, "repo");
    const worktreesPath = path.join(projectRoot, "worktrees");

    this.db
      .prepare(
        `
        INSERT INTO projects (
          guild_id,
          channel_id,
          project_channel_id,
          project_channel_name,
          project_name,
          project_slug,
          repo_path,
          worktrees_path,
          remote_status
        )
        VALUES (
          @guildId,
          @channelId,
          @channelId,
          @channelName,
          @channelName,
          @projectSlug,
          @repoPath,
          @worktreesPath,
          'missing'
        )
        ON CONFLICT(guild_id, channel_id) DO UPDATE SET
          project_channel_id = excluded.project_channel_id,
          project_channel_name = excluded.project_channel_name,
          project_name = excluded.project_name,
          project_slug = excluded.project_slug,
          repo_path = excluded.repo_path,
          worktrees_path = excluded.worktrees_path,
          updated_at = CURRENT_TIMESTAMP
      `,
      )
      .run({
        guildId: input.guildId,
        channelId: input.channelId,
        channelName: input.channelName,
        projectSlug,
        repoPath,
        worktreesPath,
      });

    const row = this.db
      .prepare("SELECT * FROM projects WHERE guild_id = ? AND channel_id = ?")
      .get(input.guildId, input.channelId) as ProjectRow | undefined;
    if (!row) {
      throw new Error("Project could not be loaded after insert.");
    }
    return mapProject(row);
  }

  getByGuildChannel(guildId: string, channelId: string): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE guild_id = ? AND channel_id = ?")
      .get(guildId, channelId) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  getById(id: number): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  updateRemote(projectId: number, input: { remoteUrl: string | null; remoteStatus: ProjectRemoteStatus }): Project {
    this.db
      .prepare(
        `
        UPDATE projects
        SET remote_url = @remoteUrl,
            remote_status = @remoteStatus,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @projectId
      `,
      )
      .run({ projectId, remoteUrl: input.remoteUrl, remoteStatus: input.remoteStatus });
    const project = this.getById(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found after remote update.`);
    }
    return project;
  }
}

export class TaskStore {
  constructor(private readonly db: Database.Database) {}

  create(project: Project, prompt: string, requestedBy: string | null): Task {
    const insert = this.db.transaction(() => {
      const nextTaskNumber = (
        this.db
          .prepare("SELECT COALESCE(MAX(project_task_number), 0) + 1 AS next_task_number FROM tasks WHERE project_id = ?")
          .get(project.id) as { next_task_number: number }
      ).next_task_number;
      const result = this.db
        .prepare(
          `
          INSERT INTO tasks (
            project_id,
            project_task_number,
            guild_id,
            channel_id,
            status,
            prompt,
            requested_by,
            mode,
            sandbox,
            model,
            effort
          )
          VALUES (?, ?, ?, ?, 'PENDING_START', ?, ?, ?, 'workspace-write', ?, ?)
        `,
        )
        .run(
          project.id,
          nextTaskNumber,
          project.guildId,
          project.channelId,
          prompt,
          requestedBy,
          DEFAULT_MODE,
          DEFAULT_MODEL,
          DEFAULT_EFFORT,
        );
      return Number(result.lastInsertRowid);
    });
    const task = this.getById(insert());
    if (!task) {
      throw new Error("Task could not be loaded after insert.");
    }
    return task;
  }

  getById(id: number): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  getByThreadId(threadId: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE discord_thread_id = ?").get(threadId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  listTasksNeedingPump(): Task[] {
    const rows = this.db
      .prepare(
        `
        SELECT DISTINCT t.*
        FROM tasks t
        JOIN task_messages m ON m.task_id = t.id
        WHERE m.status = 'queued' AND t.status NOT IN ('PENDING_START', 'WAITING_REMOTE', 'CANCELED', 'FAILED', 'MERGED', 'ABANDONED')
        ORDER BY t.created_at ASC
      `,
      )
      .all() as TaskRow[];
    return rows.map(mapTask);
  }

  listByProject(projectId: number, limit = 10): Task[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM tasks
        WHERE project_id = ?
        ORDER BY project_task_number DESC
        LIMIT ?
      `,
      )
      .all(projectId, limit) as TaskRow[];
    return rows.map(mapTask);
  }

  update(
    id: number,
    fields: Partial<
      Pick<
        Task,
        | "discordThreadId"
        | "status"
        | "mergeStatus"
        | "baseBranch"
        | "taskBranch"
        | "worktreePath"
        | "codexThreadId"
        | "liveStatusMessageId"
        | "controlPanelMessageId"
        | "pullRequestUrl"
        | "finalSummary"
        | "error"
        | "model"
        | "effort"
        | "mode"
        | "sandbox"
      >
    >,
  ): Task {
    const columnMap = {
      discordThreadId: "discord_thread_id",
      status: "status",
      mergeStatus: "merge_status",
      baseBranch: "base_branch",
      taskBranch: "task_branch",
      worktreePath: "worktree_path",
      codexThreadId: "codex_thread_id",
      liveStatusMessageId: "live_status_message_id",
      controlPanelMessageId: "control_panel_message_id",
      pullRequestUrl: "pull_request_url",
      finalSummary: "final_summary",
      error: "error",
      model: "model",
      effort: "effort",
      mode: "mode",
      sandbox: "sandbox",
    } as const;
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      const task = this.getById(id);
      if (!task) throw new Error(`Task ${id} not found.`);
      return task;
    }
    const params: Record<string, unknown> = { id };
    const assignments = entries.map(([key, value]) => {
      params[key] = value;
      return `${columnMap[key as keyof typeof columnMap]} = @${key}`;
    });
    assignments.push("updated_at = CURRENT_TIMESTAMP");
    this.db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = @id`).run(params);
    const task = this.getById(id);
    if (!task) throw new Error(`Task ${id} not found after update.`);
    return task;
  }

  enqueueUserMessage(input: {
    taskId: number;
    discordMessageId: string | null;
    discordAuthorId: string | null;
    content: string;
  }): TaskMessage {
    const result = this.db
      .prepare(
        `
        INSERT INTO task_messages (task_id, discord_message_id, discord_author_id, role, content, status)
        VALUES (?, ?, ?, 'user', ?, 'queued')
      `,
      )
      .run(input.taskId, input.discordMessageId, input.discordAuthorId, input.content);
    const message = this.getMessageById(Number(result.lastInsertRowid));
    if (!message) {
      throw new Error("Task message could not be loaded after insert.");
    }
    return message;
  }

  listQueuedMessages(taskId: number): TaskMessage[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM task_messages
        WHERE task_id = ? AND status = 'queued'
        ORDER BY datetime(created_at) ASC, id ASC
      `,
      )
      .all(taskId) as TaskMessageRow[];
    return rows.map(mapTaskMessage);
  }

  updateMessagesStatus(ids: number[], status: TaskMessageStatus): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    const processedAt = status === "processed" || status === "failed" ? new Date().toISOString() : null;
    this.db
      .prepare(`UPDATE task_messages SET status = ?, processed_at = COALESCE(?, processed_at) WHERE id IN (${placeholders})`)
      .run(status, processedAt, ...ids);
  }

  failQueuedMessages(taskId: number): void {
    this.db
      .prepare(
        `
        UPDATE task_messages
        SET status = 'failed', processed_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND status IN ('queued', 'processing')
      `,
      )
      .run(taskId);
  }

  addCodexEvent(taskId: number, eventType: string, itemType: string | null, payload: unknown): void {
    this.db
      .prepare("INSERT INTO codex_events (task_id, event_type, item_type, payload_json) VALUES (?, ?, ?, ?)")
      .run(taskId, eventType, itemType, JSON.stringify(payload));
  }

  getRecentCodexEvents(taskId: number, eventTypes: string[], limit: number): Array<{ eventType: string; payloadJson: string; createdAt: string }> {
    if (eventTypes.length === 0) return [];
    const placeholders = eventTypes.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `
        SELECT event_type, payload_json, created_at
        FROM codex_events
        WHERE task_id = ? AND event_type IN (${placeholders})
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?
      `,
      )
      .all(taskId, ...eventTypes, limit) as Array<{ event_type: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ eventType: row.event_type, payloadJson: row.payload_json, createdAt: row.created_at }));
  }

  private getMessageById(id: number): TaskMessage | null {
    const row = this.db.prepare("SELECT * FROM task_messages WHERE id = ?").get(id) as TaskMessageRow | undefined;
    return row ? mapTaskMessage(row) : null;
  }
}

function mapProject(row: ProjectRow): Project {
  const fallbackName = row.project_name || row.project_channel_name || row.channel_id;
  const fallbackSlug = row.project_slug || slugifyChannelName(fallbackName);
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    projectChannelId: row.project_channel_id || row.channel_id,
    projectChannelName: row.project_channel_name || fallbackName,
    projectName: fallbackName,
    projectSlug: fallbackSlug,
    repoPath: row.repo_path,
    worktreesPath: row.worktrees_path,
    remoteUrl: row.remote_url,
    remoteStatus: row.remote_status || "missing",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    projectTaskNumber: row.project_task_number,
    guildId: row.guild_id,
    channelId: row.channel_id,
    discordThreadId: row.discord_thread_id,
    status: row.status,
    mergeStatus: row.merge_status,
    prompt: row.prompt,
    requestedBy: row.requested_by,
    mode: row.mode,
    sandbox: row.sandbox,
    model: row.model,
    effort: row.effort,
    baseBranch: row.base_branch,
    taskBranch: row.task_branch,
    worktreePath: row.worktree_path,
    codexThreadId: row.codex_thread_id,
    liveStatusMessageId: row.live_status_message_id,
    controlPanelMessageId: row.control_panel_message_id,
    pullRequestUrl: row.pull_request_url,
    finalSummary: row.final_summary,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function slugifyChannelName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "project";
}

function mapTaskMessage(row: TaskMessageRow): TaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    discordMessageId: row.discord_message_id,
    discordAuthorId: row.discord_author_id,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}
