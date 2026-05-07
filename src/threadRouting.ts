import type { Message } from "discord.js";
import type { Task, TaskStatus } from "./types.js";

export type ThreadShortcut = "status" | "diff" | "cancel" | null;

export function isMessageInThread(message: Message): boolean {
  return message.channel.isThread();
}

export function taskIdForThread(threadId: string, lookup: (threadId: string) => Task | null): number | null {
  return lookup(threadId)?.id ?? null;
}

export function detectThreadShortcut(content: string): ThreadShortcut {
  const normalized = content.trim().toLowerCase();
  const command = normalized.replace(/^[!/.]+/, "");
  if (command === "status") return "status";
  if (command === "diff") return "diff";
  if (command === "stop" || command === "cancel") return "cancel";
  return null;
}

export function isClosedTaskStatus(status: TaskStatus): boolean {
  return status === "CANCELED" || status === "FAILED" || status === "MERGED" || status === "ABANDONED";
}

export function shouldStartProcessor(activeTaskIds: ReadonlySet<number>, taskId: number): boolean {
  return !activeTaskIds.has(taskId);
}
