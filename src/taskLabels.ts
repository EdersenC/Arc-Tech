import type { Task } from "./types.js";

export function taskDisplayNumber(task: Pick<Task, "id" | "projectTaskNumber">): number {
  return task.projectTaskNumber > 0 ? task.projectTaskNumber : task.id;
}

export function taskLabel(task: Pick<Task, "id" | "projectTaskNumber">): string {
  return `#${taskDisplayNumber(task)}`;
}
