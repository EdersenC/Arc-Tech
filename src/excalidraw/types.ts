import type { Task, TaskStatus } from "../types.js";

export type ExcalidrawCardMode =
  | "direct_agent"
  | "plan_card_only"
  | "orchestration_parent"
  | "orchestration_agent"
  | "orchestration_border"
  | "orchestration_question";
export type ExcalidrawTaskStatus = "queued" | "running" | "completed" | "failed" | "planned";

export interface ExcalidrawCardMetadata {
  type?:
    | "task"
    | "plan"
    | "orchestration_parent"
    | "orchestration_agent"
    | "orchestration_border"
    | "orchestration_question";
  cardType?: ExcalidrawCardMode;
  orchestrationId?: number;
  projectId?: number;
  taskId?: number;
  parentCardId?: string;
  parentOrchestrationId?: number;
  agentIndex?: number;
  agentName?: string;
  agentRole?: string;
  source?: "excalidraw" | "discord";
  command?: string;
  status?: string;
  phase?: string;
  activity?: string;
  lastActivityAt?: string;
  feedbackState?: string | null;
  link?: string | null;
  linkLabel?: string | null;
  planSummary?: string;
  readySummary?: string;
  goal?: string;
  questionId?: string;
  title?: string;
}

export interface ExcalidrawCardLink {
  label: string;
  url: string;
}

export interface ExcalidrawCard {
  id: string;
  taskId: number | null;
  projectId: number | null;
  source: "excalidraw";
  mode: ExcalidrawCardMode;
  command: string;
  title: string;
  label: string;
  status: string;
  branch: string | null;
  parentCardId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  links: ExcalidrawCardLink[];
  metadata: ExcalidrawCardMetadata | null;
  progress?: ExcalidrawTaskProgress;
  createdAt: string;
  updatedAt: string;
}

export interface ExcalidrawTaskProgress {
  rawStatus: TaskStatus;
  phase: string;
  activity: string;
  currentCommand: string | null;
  changedFiles: string[];
  recentEvents: string[];
  messageCounts: {
    queued: number;
    processing: number;
    processed: number;
    failed: number;
  };
  error: string | null;
  summary: string | null;
  pullRequestUrl: string | null;
  pullRequestFeedback: ExcalidrawPullRequestFeedbackProgress | null;
  lastActivityAt: string;
}

export interface ExcalidrawPullRequestFeedbackProgress {
  state: "queued" | "resolving" | "resolved" | "failed";
  total: number;
  active: number;
  reacted: number;
  reactionFailed: number;
  latestAt: string | null;
  lastError: string | null;
}

export interface ExcalidrawTaskView {
  taskId: string;
  numericTaskId: number;
  status: ExcalidrawTaskStatus;
  rawStatus: TaskStatus;
  title: string;
  branch: string | null;
  prompt: string;
  progress: ExcalidrawTaskProgress;
  card: ExcalidrawCard | null;
  createdAt: string;
  updatedAt: string;
}

export function mapTaskStatus(status: TaskStatus): ExcalidrawTaskStatus {
  if (status === "RUNNING") return "running";
  if (status === "FAILED" || status === "CANCELED" || status === "ABANDONED") return "failed";
  if (status === "DONE" || status === "MERGED" || status === "WAITING_REVIEW") return "completed";
  return "queued";
}

export function taskTitle(task: Task): string {
  return `Agent Task #${task.projectTaskNumber || task.id}`;
}

export function taskCardLabel(task: Task): string {
  return taskCardLabelWithProgress(task);
}

export function taskCardLabelWithProgress(task: Task, progress?: ExcalidrawTaskProgress): string {
  const status = progress ? `${mapTaskStatus(task.status)} (${task.status})` : mapTaskStatus(task.status);
  const lines = [
    taskTitle(task),
    `Status: ${status}`,
    progress?.phase ? `Phase: ${oneLine(progress.phase, 96)}` : null,
    progress?.activity ? `Activity: ${oneLine(progress.activity, 112)}` : null,
    progress?.pullRequestFeedback ? `PR feedback: ${feedbackLine(progress.pullRequestFeedback)}` : null,
    progress?.currentCommand ? `Command now: ${oneLine(progress.currentCommand, 104)}` : null,
    progress?.changedFiles.length ? `Changed: ${oneLine(progress.changedFiles.join(", "), 112)}` : null,
    progress ? `Messages: ${messageCountsLine(progress.messageCounts)}` : null,
    progress?.recentEvents.length ? `Events: ${oneLine(progress.recentEvents.join(" -> "), 112)}` : null,
    progress?.error ? `Error: ${oneLine(progress.error, 112)}` : null,
    progress?.summary ? `Summary: ${oneLine(progress.summary, 112)}` : null,
    progress?.pullRequestUrl ? "PR: available" : null,
    `Branch: ${task.taskBranch ?? "not created"}`,
    progress?.lastActivityAt ? `Updated: ${compactTimestamp(progress.lastActivityAt)}` : null,
    `Command: ${oneLine(task.prompt, 112)}`,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function taskCardSize(label: string, existing?: Pick<ExcalidrawCard, "width" | "height">): { width: number; height: number } {
  const lines = label.split(/\r?\n/);
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const neededWidth = Math.min(760, Math.max(420, Math.ceil(longest * 7.5 + 52)));
  const neededHeight = Math.min(720, Math.max(210, Math.ceil(lines.length * 25 + 54)));
  return {
    width: Math.max(existing?.width ?? 0, neededWidth),
    height: Math.max(existing?.height ?? 0, neededHeight),
  };
}

function messageCountsLine(counts: ExcalidrawTaskProgress["messageCounts"]): string {
  const parts = [
    counts.queued ? `${counts.queued} queued` : null,
    counts.processing ? `${counts.processing} processing` : null,
    counts.processed ? `${counts.processed} done` : null,
    counts.failed ? `${counts.failed} failed` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "none";
}

function feedbackLine(feedback: ExcalidrawPullRequestFeedbackProgress): string {
  const parts = [
    feedback.state,
    `${feedback.total} item${feedback.total === 1 ? "" : "s"}`,
    feedback.active ? `${feedback.active} active` : null,
    feedback.reacted ? `${feedback.reacted} reacted` : null,
    feedback.reactionFailed ? `${feedback.reactionFailed} reaction failed` : null,
  ].filter(Boolean);
  return parts.join(" / ");
}

function compactTimestamp(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z").slice(0, 19);
}

export function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}
