import type { CodexActivityEvent, TaskMessageStatusCounts } from "../stores.js";
import type { Task } from "../types.js";
import { oneLine, type ExcalidrawTaskProgress } from "./types.js";

export function buildTaskProgress(
  task: Task,
  events: CodexActivityEvent[],
  messageCounts: TaskMessageStatusCounts,
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

  return {
    rawStatus: task.status,
    phase: phaseFor(task, latest, events),
    activity: activityFor(task, latest, messageCounts, summary),
    currentCommand: latestCommand ? commandEventText(latestCommand) : null,
    changedFiles,
    recentEvents: events.slice(0, 4).map(eventLabel),
    messageCounts,
    error: task.error,
    summary: summary ? oneLine(summary, 180) : null,
    pullRequestUrl: task.pullRequestUrl ?? task.prUrl,
    lastActivityAt: latest?.createdAt ?? task.updatedAt,
  };
}

function phaseFor(task: Task, latest: CodexActivityEvent | null, events: CodexActivityEvent[]): string {
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
): string {
  if (task.error) return oneLine(task.error, 180);
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
