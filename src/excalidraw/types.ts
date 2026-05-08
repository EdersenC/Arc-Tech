import type { Task, TaskStatus } from "../types.js";

export type ExcalidrawCardMode = "direct_agent" | "plan_card_only";
export type ExcalidrawTaskStatus = "queued" | "running" | "completed" | "failed" | "planned";

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
  x: number;
  y: number;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExcalidrawTaskView {
  taskId: string;
  numericTaskId: number;
  status: ExcalidrawTaskStatus;
  rawStatus: TaskStatus;
  title: string;
  branch: string | null;
  prompt: string;
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
  return [
    taskTitle(task),
    `Status: ${mapTaskStatus(task.status)}`,
    `Branch: ${task.taskBranch ?? "not created"}`,
    `Command: ${oneLine(task.prompt, 96)}`,
  ].join("\n");
}

export function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}
