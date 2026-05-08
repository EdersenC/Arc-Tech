import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Task } from "../types.js";
import {
  mapTaskStatus,
  taskCardLabel,
  taskCardSize,
  taskTitle,
  type ExcalidrawCard,
  type ExcalidrawCardMetadata,
  type ExcalidrawCardMode,
} from "./types.js";

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
  parent_card_id: string | null;
  metadata_json: string | null;
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
  mode?: ExcalidrawCardMode;
  status?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  taskId?: number | null;
  parentCardId?: string | null;
  metadata?: ExcalidrawCardMetadata | null;
}

export interface CreateTaskCardInput {
  command: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  mode?: ExcalidrawCardMode;
  status?: string;
  branch?: string | null;
  links?: never;
  parentCardId?: string | null;
  metadata?: ExcalidrawCardMetadata | null;
}

const DEFAULT_PLAN_CARD_MODE: ExcalidrawCardMode = "plan_card_only";
const DEFAULT_TASK_CARD_MODE: ExcalidrawCardMode = "direct_agent";

export class ExcalidrawCardsRepo {
  constructor(private readonly db: Database.Database) {}

  createForTask(task: Task, input: { command: string; x?: number; y?: number }): ExcalidrawCard {
    return this.createForTaskWithMode(task, {
      command: input.command,
      x: input.x,
      y: input.y,
      mode: "direct_agent",
    });
  }

  createForTaskWithMode(task: Task, input: CreateTaskCardInput): ExcalidrawCard {
    const id = randomUUID();
    const label = taskCardLabel(task);
    const size = taskCardSize(label);
    const metadata: ExcalidrawCardMetadata = {
      ...input.metadata,
      taskId: task.id,
      source: "excalidraw",
      status: input.status ?? mapTaskStatus(task.status),
      command: input.command,
      type: input.mode === "orchestration_agent" ? "orchestration_agent" : "task",
      cardType: input.mode ?? DEFAULT_TASK_CARD_MODE,
      title: taskTitle(task),
    };
    this.db
      .prepare(
        `
        INSERT INTO excalidraw_cards (
          id, task_id, project_id, source, mode, command, title, label, status, branch, x, y, width, height
          , parent_card_id, metadata_json
        )
        VALUES (
          @id, @taskId, @projectId, 'excalidraw', @mode, @command, @title, @label, @status, @branch, @x, @y, @width, @height
          , @parentCardId, @metadata
        )
      `,
      )
      .run({
        id,
        taskId: task.id,
        projectId: task.projectId,
        command: input.command,
        title: taskTitle(task),
        label,
        status: input.status ?? mapTaskStatus(task.status),
        branch: input.branch ?? task.taskBranch,
        x: input.x ?? 80,
        y: input.y ?? 80,
        mode: input.mode ?? DEFAULT_TASK_CARD_MODE,
        width: size.width,
        height: size.height,
        parentCardId: input.parentCardId ?? null,
        metadata: serializeMetadata(metadata),
      });
    const card = this.findById(id);
    if (!card) {
      throw new Error("Excalidraw task card could not be loaded after insert.");
    }
    return card;
  }

  createPlanCard(input: CreatePlanCardInput): ExcalidrawCard {
    const id = randomUUID();
    const mode = input.mode ?? DEFAULT_PLAN_CARD_MODE;
    const metadata: ExcalidrawCardMetadata = {
      ...(input.metadata ?? {}),
      source: "excalidraw",
      type: mode === "orchestration_parent"
        ? "orchestration_parent"
        : mode === "orchestration_border"
          ? "orchestration_border"
          : mode === "orchestration_question"
            ? "orchestration_question"
            : mode === "orchestration_agent"
              ? "orchestration_agent"
              : "plan",
      cardType: mode,
      command: input.command,
      title: input.title,
      status: input.status ?? "planned",
    };
    this.db
      .prepare(
        `
        INSERT INTO excalidraw_cards (
          id, task_id, project_id, source, mode, command, title, label, status, branch, x, y, width, height
          , parent_card_id, metadata_json
        )
        VALUES (
          @id, @taskId, @projectId, 'excalidraw', @mode, @command, @title, @label, @status, NULL, @x, @y, @width, @height
          , @parentCardId, @metadata
        )
      `,
      )
      .run({
        id,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        command: input.command,
        title: input.title,
        label: input.label,
        status: input.status ?? "planned",
        x: input.x ?? 80,
        y: input.y ?? 80,
        width: input.width ?? 360,
        height: input.height ?? 180,
        mode,
        parentCardId: input.parentCardId ?? null,
        metadata: serializeMetadata(metadata),
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

  listByProject(projectId: number, limit = 50): ExcalidrawCard[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM excalidraw_cards
        WHERE project_id = ?
        ORDER BY datetime(updated_at) DESC, id DESC
        LIMIT ?
      `,
      )
      .all(projectId, limit) as ExcalidrawCardRow[];
    return rows.map(mapCard);
  }

  updateFromTask(task: Task): ExcalidrawCard | null {
    const existing = this.findByTaskId(task.id);
    if (!existing) {
      return null;
    }
    const next = {
      title: taskTitle(task),
      label: taskCardLabel(task),
      status: mapTaskStatus(task.status),
      branch: task.taskBranch,
    };
    const size = taskCardSize(next.label, existing);
    if (
      existing.title === next.title &&
      existing.label === next.label &&
      existing.status === next.status &&
      existing.branch === next.branch &&
      existing.width === size.width &&
      existing.height === size.height
    ) {
      return existing;
    }
    this.db
      .prepare(
        `
        UPDATE excalidraw_cards
        SET title = @title,
            label = @label,
            status = @status,
            branch = @branch,
            width = @width,
            height = @height,
            metadata_json = COALESCE(@metadata, metadata_json),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @id
      `,
      )
      .run({
        id: existing.id,
        ...next,
        width: size.width,
        height: size.height,
        metadata: serializeMetadata({
          ...(existing.metadata ?? {}),
          status: next.status,
          command: existing.command,
          title: next.title,
          phase: next.label.includes("Phase:") ? next.label : existing.metadata?.phase,
          activity: next.label.includes("Activity:") ? next.label : existing.metadata?.activity,
        }),
      });
    return this.findById(existing.id);
  }

  updatePosition(id: string, input: { x?: number; y?: number; width?: number; height?: number }): ExcalidrawCard | null {
    const fields = Object.entries(input).filter(([, value]) => typeof value === "number" && Number.isFinite(value));
    if (fields.length === 0) {
      return this.findById(id);
    }
    const existing = this.findById(id);
    if (!existing) {
      return null;
    }
    if (
      (input.x === undefined || existing.x === input.x) &&
      (input.y === undefined || existing.y === input.y) &&
      (input.width === undefined || existing.width === input.width) &&
      (input.height === undefined || existing.height === input.height)
    ) {
      return existing;
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

  updateText(
    id: string,
    input: { title?: string; label?: string; status?: string; width?: number; height?: number; metadata?: ExcalidrawCardMetadata | null },
  ): ExcalidrawCard | null {
    const existing = this.findById(id);
    if (!existing) return null;
    this.db
      .prepare(
        `
        UPDATE excalidraw_cards
        SET title = @title,
            label = @label,
            status = @status,
            width = @width,
            height = @height,
            metadata_json = COALESCE(@metadata, metadata_json),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @id
      `,
      )
      .run({
        id,
        title: input.title ?? existing.title,
        label: input.label ?? existing.label,
        status: input.status ?? existing.status,
        width: input.width ?? existing.width,
        height: input.height ?? existing.height,
        metadata: input.metadata === undefined ? null : serializeMetadata(input.metadata),
      });
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
    parentCardId: row.parent_card_id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    metadata: parseMetadata(row.metadata_json),
    links: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeMetadata(metadata: ExcalidrawCardMetadata | null | undefined): string | null {
  if (!metadata) return null;
  const clean = { ...metadata };
  return JSON.stringify(clean);
}

function parseMetadata(metadata: string | null): ExcalidrawCardMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as ExcalidrawCardMetadata;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
