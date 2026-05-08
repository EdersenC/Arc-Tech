import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Task } from "../types.js";
import { mapTaskStatus, taskCardLabel, taskTitle, type ExcalidrawCard, type ExcalidrawCardMode } from "./types.js";

type ExcalidrawCardRow = {
  id: string;
  task_id: number | null;
  project_id: number | null;
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
  created_at: string;
  updated_at: string;
};

export interface CreatePlanCardInput {
  projectId: number | null;
  command: string;
  title: string;
  label: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export class ExcalidrawCardsRepo {
  constructor(private readonly db: Database.Database) {}

  createForTask(task: Task, input: { command: string; x?: number; y?: number }): ExcalidrawCard {
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO excalidraw_cards (
          id, task_id, project_id, source, mode, command, title, label, status, branch, x, y, width, height
        )
        VALUES (
          @id, @taskId, @projectId, 'excalidraw', 'direct_agent', @command, @title, @label, @status, @branch, @x, @y, 360, 180
        )
      `,
      )
      .run({
        id,
        taskId: task.id,
        projectId: task.projectId,
        command: input.command,
        title: taskTitle(task),
        label: taskCardLabel(task),
        status: mapTaskStatus(task.status),
        branch: task.taskBranch,
        x: input.x ?? 80,
        y: input.y ?? 80,
      });
    const card = this.findById(id);
    if (!card) {
      throw new Error("Excalidraw task card could not be loaded after insert.");
    }
    return card;
  }

  createPlanCard(input: CreatePlanCardInput): ExcalidrawCard {
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO excalidraw_cards (
          id, task_id, project_id, source, mode, command, title, label, status, branch, x, y, width, height
        )
        VALUES (
          @id, NULL, @projectId, 'excalidraw', 'plan_card_only', @command, @title, @label, 'planned', NULL, @x, @y, @width, @height
        )
      `,
      )
      .run({
        id,
        projectId: input.projectId,
        command: input.command,
        title: input.title,
        label: input.label,
        x: input.x ?? 80,
        y: input.y ?? 80,
        width: input.width ?? 360,
        height: input.height ?? 180,
      });
    const card = this.findById(id);
    if (!card) {
      throw new Error("Excalidraw plan card could not be loaded after insert.");
    }
    return card;
  }

  findById(id: string): ExcalidrawCard | null {
    const row = this.db.prepare("SELECT * FROM excalidraw_cards WHERE id = ?").get(id) as ExcalidrawCardRow | undefined;
    return row ? mapCard(row) : null;
  }

  findByTaskId(taskId: number): ExcalidrawCard | null {
    const row = this.db.prepare("SELECT * FROM excalidraw_cards WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1").get(taskId) as
      | ExcalidrawCardRow
      | undefined;
    return row ? mapCard(row) : null;
  }

  listRecent(limit = 50): ExcalidrawCard[] {
    const rows = this.db.prepare("SELECT * FROM excalidraw_cards ORDER BY datetime(updated_at) DESC, id DESC LIMIT ?").all(limit) as ExcalidrawCardRow[];
    return rows.map(mapCard);
  }

  updateFromTask(task: Task): ExcalidrawCard | null {
    const existing = this.findByTaskId(task.id);
    if (!existing) {
      return null;
    }
    this.db
      .prepare(
        `
        UPDATE excalidraw_cards
        SET title = @title,
            label = @label,
            status = @status,
            branch = @branch,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @id
      `,
      )
      .run({
        id: existing.id,
        title: taskTitle(task),
        label: taskCardLabel(task),
        status: mapTaskStatus(task.status),
        branch: task.taskBranch,
      });
    return this.findById(existing.id);
  }

  updatePosition(id: string, input: { x?: number; y?: number; width?: number; height?: number }): ExcalidrawCard | null {
    const fields = Object.entries(input).filter(([, value]) => typeof value === "number" && Number.isFinite(value));
    if (fields.length === 0) {
      return this.findById(id);
    }
    const columnMap = { x: "x", y: "y", width: "width", height: "height" } as const;
    const params: Record<string, unknown> = { id };
    const assignments = fields.map(([key, value]) => {
      params[key] = value;
      return `${columnMap[key as keyof typeof columnMap]} = @${key}`;
    });
    assignments.push("updated_at = CURRENT_TIMESTAMP");
    this.db.prepare(`UPDATE excalidraw_cards SET ${assignments.join(", ")} WHERE id = @id`).run(params);
    return this.findById(id);
  }
}

function mapCard(row: ExcalidrawCardRow): ExcalidrawCard {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    source: row.source,
    mode: row.mode,
    command: row.command,
    title: row.title,
    label: row.label,
    status: row.status,
    branch: row.branch,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
