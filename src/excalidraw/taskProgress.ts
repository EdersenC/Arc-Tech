import type { CodexActivityEvent, TaskMessageStatusCounts } from "../stores.js";
import type { Task } from "../types.js";
import type { PullRequestFeedbackSummary } from "../github/PullRequestFeedbackTypes.js";
import { oneLine, type ExcalidrawPullRequestFeedbackProgress, type ExcalidrawTaskProgress } from "./types.js";

export function buildTaskProgress(
  task: Task,
  events: CodexActivityEvent[],
  messageCounts: TaskMessageStatusCounts,
  feedbackSummary: PullRequestFeedbackSummary | null = null,
): ExcalidrawTaskProgress {
  const latest = events[0] ?? null;
  const latestCommand = events.find((event) => event.itemType === "command_execution") ?? null;
  const changedFiles = unique(
    events
      .filter((event) => event.itemType === "file_change")
      .map((event) => fileChangePath(parsePayload(event)))
      .filter((path) => path && path !== "unknown file"),
  ).slice(0, 5);
  const summary = task.completionSummary || task.finalSummary;
  const feedback = feedbackSummary ? feedbackProgress(feedbackSummary) : null;

  return {
    rawStatus: task.status,
    phase: phaseFor(task, latest, events, feedback),
    activity: activityFor(task, latest, messageCounts, summary, feedback),
    currentCommand: latestCommand ? commandEventText(latestCommand) : null,
    changedFiles,
    recentEvents: events.slice(0, 4).map(eventLabel),
    messageCounts,
    error: task.error,
    summary: summary ? oneLine(summary, 180) : null,
    pullRequestUrl: task.pullRequestUrl ?? task.prUrl,
    pullRequestFeedback: feedback,
    lastActivityAt: latest?.createdAt ?? task.updatedAt,
  };
}

function phaseFor(
  task: Task,
  latest: CodexActivityEvent | null,
  events: CodexActivityEvent[],
  feedback: ExcalidrawPullRequestFeedbackProgress | null,
): string {
  if (feedback?.state === "resolving") return "Resolving PR feedback";
  if (feedback?.state === "queued") return "PR feedback queued";
  if (task.status === "PENDING_START") return "Waiting for start";
  if (task.status === "WAITING_REMOTE") return "Waiting for repository setup";
  if (task.status === "QUEUED") return "Queued for Codex";
  if (task.status === "WAITING_REVIEW") return "Waiting for review";
  if (task.status === "DONE" || task.status === "MERGED") return "Completed";
  if (task.status === "FAILED") return "Failed";
  if (task.status === "CANCELED") return "Canceled";
  if (task.status === "ABANDONED") return "Abandoned";
  if (!latest && task.status === "RUNNING") return "Codex process starting";
  if (!latest) return task.status;

  if (latest.eventType === "thread.started") return "Codex thread started";
  if (latest.eventType === "turn.started") return "Codex turn running";
  if (latest.eventType === "turn.completed") return "Codex turn completed";
  if (latest.eventType === "pr_feedback.queued") return "PR feedback queued";
  if (latest.eventType === "turn.failed" || latest.eventType === "error") return "Codex error";
  if (latest.eventType === "stderr") return "Codex stderr";
  if (latest.eventType === "item.started" && latest.itemType === "command_execution") return "Running command";
  if (latest.eventType === "item.completed" && latest.itemType === "command_execution") return "Command completed";
  if (latest.eventType === "item.completed" && latest.itemType === "file_change") return "Editing files";
  if (latest.eventType === "item.completed" && latest.itemType === "agent_message") return "Agent reported progress";
  if (latest.itemType === "plan_update" || events.some((event) => event.itemType === "plan_update")) return "Plan updated";
  return eventLabel(latest);
}

function activityFor(
  task: Task,
  latest: CodexActivityEvent | null,
  messageCounts: TaskMessageStatusCounts,
  summary: string | null,
  feedback: ExcalidrawPullRequestFeedbackProgress | null,
): string {
  if (task.error) return oneLine(task.error, 180);
  if (feedback?.state === "resolving") {
    const count = feedback.active || feedback.total;
    return `Resolving ${count} PR feedback item${count === 1 ? "" : "s"}`;
  }
  if (feedback?.state === "queued") {
    const count = feedback.active || feedback.total;
    return `${count} PR feedback item${count === 1 ? "" : "s"} queued for agent`;
  }
  if (latest) {
    const activity = eventActivity(latest);
    if (activity) return activity;
  }
  if (task.status === "RUNNING") return "Codex is running; waiting for the next JSON event";
  if (task.status === "QUEUED") {
    return messageCounts.queued ? `${messageCounts.queued} queued message${messageCounts.queued === 1 ? "" : "s"} waiting` : "Waiting in task queue";
  }
  if (task.status === "PENDING_START") return "Worktree and branch are being prepared";
  if (summary) return oneLine(summary, 180);
  return "No Codex activity recorded yet";
}

function eventActivity(event: CodexActivityEvent): string | null {
  const payload = parsePayload(event);
  if (event.itemType === "command_execution") {
    return commandEventText(event);
  }
  if (event.itemType === "file_change") {
    return `Edited ${fileChangePath(payload)}`;
  }
  if (event.itemType === "agent_message" || event.itemType === "plan_update") {
    const message = messageText(payload);
    return message ? oneLine(message, 180) : eventLabel(event);
  }
  if (event.eventType === "stderr") {
    const message = messageText(payload);
    return message ? `stderr: ${oneLine(message, 150)}` : "stderr output captured";
  }
  if (event.eventType === "turn.started") return "Codex turn started";
  if (event.eventType === "thread.started") return "Codex thread created";
  if (event.eventType === "turn.completed") return "Codex turn completed";
  if (event.eventType === "pr_feedback.queued") return "PR feedback queued for agent";
  return null;
}

function commandEventText(event: CodexActivityEvent): string {
  const payload = parsePayload(event);
  const command = commandText(payload);
  if (event.eventType === "item.completed") {
    return `${command} -> ${commandStatus(payload)}`;
  }
  return command;
}

function eventLabel(event: CodexActivityEvent): string {
  if (event.eventType === "pr_feedback.queued") return "PR feedback queued";
  return event.itemType ? `${event.eventType} ${event.itemType}` : event.eventType;
}

function parsePayload(event: CodexActivityEvent): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.payloadJson) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function commandText(payload: Record<string, unknown>): string {
  const item = asRecord(payload.item) ?? payload;
  const command = item.command ?? item.cmd ?? item.argv;
  if (Array.isArray(command)) return command.map(String).join(" ");
  if (typeof command === "string") return command;
  if (asRecord(command)) return JSON.stringify(command);
  return "unknown command";
}

function commandStatus(payload: Record<string, unknown>): string {
  const item = asRecord(payload.item) ?? payload;
  for (const key of ["exit_code", "exitCode", "status", "result"]) {
    const value = item[key];
    if (value !== undefined) return String(value);
  }
  return "done";
}

function fileChangePath(payload: Record<string, unknown>): string {
  const item = asRecord(payload.item) ?? payload;
  for (const key of ["path", "file", "filename"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "unknown file";
}

function messageText(payload: Record<string, unknown>): string | null {
  for (const key of ["message", "summary", "text", "content"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const item = asRecord(payload.item);
  if (item) {
    for (const key of ["message", "summary", "text", "content"]) {
      const value = item[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function feedbackProgress(summary: PullRequestFeedbackSummary): ExcalidrawPullRequestFeedbackProgress {
  const active = summary.queued + summary.processing;
  return {
    state: feedbackState(summary, active),
    total: summary.total,
    active,
    reacted: summary.reacted,
    reactionFailed: summary.reactionFailed,
    latestAt: summary.latestFeedbackAt,
    lastError: summary.lastError,
  };
}

function feedbackState(summary: PullRequestFeedbackSummary, active: number): ExcalidrawPullRequestFeedbackProgress["state"] {
  if (summary.processing > 0) return "resolving";
  if (active > 0) return "queued";
  if (summary.lastError || summary.failed > 0) return "failed";
  return "resolved";
}
