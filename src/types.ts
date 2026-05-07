export const TASK_STATUSES = [
  "PENDING_START",
  "QUEUED",
  "RUNNING",
  "WAITING_REMOTE",
  "WAITING_REVIEW",
  "DONE",
  "CANCELED",
  "FAILED",
  "MERGED",
  "ABANDONED",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_MESSAGE_STATUSES = ["queued", "processing", "processed", "failed"] as const;
export type TaskMessageStatus = (typeof TASK_MESSAGE_STATUSES)[number];

export type SandboxMode = "workspace-write" | "read-only";
export type Effort = "low" | "medium" | "high";
export type TaskMode = "ask" | "plan_only" | "implement";
export type ProjectRemoteStatus = "missing" | "configured" | "skipped";

export interface Project {
  id: number;
  guildId: string;
  channelId: string;
  projectChannelId: string;
  projectChannelName: string;
  projectName: string;
  projectSlug: string;
  repoPath: string;
  worktreesPath: string;
  remoteUrl: string | null;
  remoteStatus: ProjectRemoteStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: number;
  projectId: number;
  projectTaskNumber: number;
  guildId: string;
  channelId: string;
  discordThreadId: string | null;
  status: TaskStatus;
  mergeStatus: string;
  prompt: string;
  requestedBy: string | null;
  mode: TaskMode;
  sandbox: SandboxMode;
  model: string;
  effort: Effort;
  baseBranch: string | null;
  taskBranch: string | null;
  worktreePath: string | null;
  codexThreadId: string | null;
  liveStatusMessageId: string | null;
  controlPanelMessageId: string | null;
  finalSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMessage {
  id: number;
  taskId: number;
  discordMessageId: string | null;
  discordAuthorId: string | null;
  role: "user";
  content: string;
  status: TaskMessageStatus;
  createdAt: string;
  processedAt: string | null;
}

export const DEFAULT_MODEL = "gpt-5.3-codex";
export const DEFAULT_EFFORT: Effort = "medium";
export const DEFAULT_MODE: TaskMode = "implement";
