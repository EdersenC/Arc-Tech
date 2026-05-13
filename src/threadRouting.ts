import type { Message } from "discord.js";
import type { Task, TaskStatus } from "./types.js";

export type ThreadShortcut = "status" | "diff" | "cancel" | "check_pr" | null;

export function isMessageInThread(message: Message): boolean {
  return message.channel.isThread();
}

export function taskIdForThread(threadId: string, lookup: (threadId: string) => Task | null): number | null {
  return lookup(threadId)?.id ?? null;
}

export function detectThreadShortcut(content: string): ThreadShortcut {
  const normalized = content.trim().toLowerCase();
  if (normalized === "status") return "status";
  if (normalized === "diff") return "diff";
  if (normalized === "stop" || normalized === "cancel") return "cancel";
  if (/^(check|poll)\s+prs?$/.test(normalized) || /^(check|poll)\s+pull\s+requests?$/.test(normalized)) return "check_pr";
  return null;
}

export function isClosedTaskStatus(status: TaskStatus): boolean {
  return status === "CANCELED" || status === "FAILED" || status === "MERGED" || status === "ABANDONED";
}

export function shouldStartProcessor(activeTaskIds: ReadonlySet<number>, taskId: number): boolean {
  return !activeTaskIds.has(taskId);
}
