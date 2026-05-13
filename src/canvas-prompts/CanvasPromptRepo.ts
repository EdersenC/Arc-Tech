import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalPromptCommand, normalizePromptCommand } from "./commandParser.js";
import type {
  CanvasPromptBundle,
  CanvasPromptCommandKind,
  CanvasPromptLink,
  CanvasPromptLinkKind,
  CanvasPromptLinkStatus,
  CanvasPromptNode,
  CanvasPromptStatus,
  CanvasPromptTargetKind,
} from "./types.js";

type PromptRow = {
  id: string;
  project_id: number;
  owner_id: string;
  owner_label: string;
  command_kind: CanvasPromptCommandKind;
  command_text: string;
  body: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status: CanvasPromptStatus;
  last_dispatch_hash: string | null;
  last_dispatched_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type LinkRow = {
  id: string;
  project_id: number;
  prompt_node_id: string;
  link_kind: CanvasPromptLinkKind;
  owner_id: string;
  source_kind: string | null;
  source_id: string | null;
  target_kind: CanvasPromptTargetKind;
  target_id: string;
  orchestration_id: number | null;
  question_id: string | null;
  workflow_graph_id: string | null;
  workflow_node_id: string | null;
  task_id: number | null;
  card_id: string | null;
  target_orchestration_id: number | null;
  target_workflow_graph_id: string | null;
  target_workflow_node_id: string | null;
  arrow_element_id: string;
  status: CanvasPromptLinkStatus;
  dispatch_hash: string | null;
  dispatched_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export interface CreateCanvasPromptInput {
  projectId: number;
  ownerId: string;
  ownerLabel: string;
  commandKind: CanvasPromptCommandKind;
  commandText?: string;
  body?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  status?: CanvasPromptStatus;
}

export interface UpdateCanvasPromptInput {
  ownerId?: string;
  ownerLabel?: string;
  commandKind?: CanvasPromptCommandKind;
  commandText?: string;
  body?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  status?: CanvasPromptStatus;
}

export interface CreateCanvasPromptLinkInput {
  projectId: number;
  promptNodeId: string;
  linkKind?: CanvasPromptLinkKind;
  ownerId: string;
  sourceKind?: string | null;
  sourceId?: string | null;
  targetKind: CanvasPromptTargetKind;
  targetId: string;
  orchestrationId?: number | null;
  questionId?: string | null;
  workflowGraphId?: string | null;
  workflowNodeId?: string | null;
  taskId?: number | null;
  cardId?: string | null;
  arrowElementId?: string;
}

export class CanvasPromptRepo {
  constructor(private readonly db: Database.Database) {}

  listByProject(projectId: number): CanvasPromptBundle {
    const prompts = this.db
      .prepare("SELECT * FROM canvas_prompt_nodes WHERE project_id = ? AND deleted_at IS NULL ORDER BY datetime(created_at) ASC, id ASC")
      .all(projectId) as PromptRow[];
    const links = this.db
      .prepare("SELECT * FROM canvas_prompt_links WHERE project_id = ? AND deleted_at IS NULL ORDER BY datetime(created_at) ASC, id ASC")
      .all(projectId) as LinkRow[];
    return { prompts: prompts.map(mapPrompt), links: links.map(mapLink) };
  }

  findPrompt(id: string): CanvasPromptNode | null {
    const row = this.db.prepare("SELECT * FROM canvas_prompt_nodes WHERE id = ? AND deleted_at IS NULL").get(id) as PromptRow | undefined;
    return row ? mapPrompt(row) : null;
  }

  findLink(id: string): CanvasPromptLink | null {
    const row = this.db.prepare("SELECT * FROM canvas_prompt_links WHERE id = ? AND deleted_at IS NULL").get(id) as LinkRow | undefined;
    return row ? mapLink(row) : null;
  }

  findActiveLinkForPrompt(promptNodeId: string): CanvasPromptLink | null {
    const row = this.db
      .prepare("SELECT * FROM canvas_prompt_links WHERE prompt_node_id = ? AND deleted_at IS NULL ORDER BY datetime(created_at) ASC LIMIT 1")
      .get(promptNodeId) as LinkRow | undefined;
    return row ? mapLink(row) : null;
  }

  listActiveLinksForPrompt(promptNodeId: string): CanvasPromptLink[] {
    const rows = this.db
      .prepare("SELECT * FROM canvas_prompt_links WHERE prompt_node_id = ? AND deleted_at IS NULL ORDER BY datetime(created_at) ASC, id ASC")
      .all(promptNodeId) as LinkRow[];
    return rows.map(mapLink);
  }

  createPrompt(input: CreateCanvasPromptInput): CanvasPromptNode {
    const id = randomUUID();
    const commandKind = normalizePromptCommand(input.commandKind);
    this.db
      .prepare(
        `
        INSERT INTO canvas_prompt_nodes (
          id, project_id, owner_id, owner_label, command_kind, command_text, body, x, y, width, height, status
        )
        VALUES (
          @id, @projectId, @ownerId, @ownerLabel, @commandKind, @commandText, @body, @x, @y, @width, @height, @status
        )
      `,
      )
      .run({
        id,
        projectId: input.projectId,
        ownerId: input.ownerId,
        ownerLabel: input.ownerLabel,
        commandKind,
        commandText: input.commandText ?? canonicalPromptCommand(commandKind),
        body: input.body ?? "",
        x: input.x,
        y: input.y,
        width: input.width ?? 460,
        height: input.height ?? 190,
        status: input.status ?? "draft",
      });
    return requirePrompt(this.findPrompt(id), id);
  }

  updatePrompt(id: string, input: UpdateCanvasPromptInput): CanvasPromptNode | null {
    const existing = this.findPrompt(id);
    if (!existing) return null;
    const commandKind = input.commandKind ? normalizePromptCommand(input.commandKind) : existing.commandKind;
    const bodyChanged = input.body !== undefined && input.body !== existing.body;
    const commandChanged = input.commandKind !== undefined && commandKind !== existing.commandKind;
    const sentBefore = existing.status === "sent" || existing.status === "dirty";
    const nextStatus = input.status ?? (sentBefore && (bodyChanged || commandChanged) ? "dirty" : existing.status);
    this.db
      .prepare(
        `
        UPDATE canvas_prompt_nodes
        SET owner_id = @ownerId,
            owner_label = @ownerLabel,
            command_kind = @commandKind,
            command_text = @commandText,
            body = @body,
            x = @x,
            y = @y,
            width = @width,
            height = @height,
            status = @status,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @id AND deleted_at IS NULL
      `,
      )
      .run({
        id,
        ownerId: input.ownerId ?? existing.ownerId,
        ownerLabel: input.ownerLabel ?? existing.ownerLabel,
        commandKind,
        commandText: input.commandText ?? canonicalPromptCommand(commandKind),
        body: input.body ?? existing.body,
        x: input.x ?? existing.x,
        y: input.y ?? existing.y,
        width: input.width ?? existing.width,
        height: input.height ?? existing.height,
        status: nextStatus,
      });
    if (sentBefore && (bodyChanged || commandChanged)) {
      this.db
        .prepare(
          `
          UPDATE canvas_prompt_links
          SET status = 'dirty',
              updated_at = CURRENT_TIMESTAMP
          WHERE prompt_node_id = ? AND deleted_at IS NULL AND status IN ('sent', 'dirty')
        `,
        )
        .run(id);
    }
    return this.findPrompt(id);
  }

  deletePrompt(id: string): { deleted: boolean; locked: boolean } {
    const existing = this.findPrompt(id);
    if (!existing) return { deleted: false, locked: false };
    if (existing.status === "sent" || existing.status === "sending" || existing.status === "dirty") {
      return { deleted: false, locked: true };
    }
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE canvas_prompt_links SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE prompt_node_id = ? AND deleted_at IS NULL").run(id);
      this.db.prepare("UPDATE canvas_prompt_nodes SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL").run(id);
    });
    tx();
    return { deleted: true, locked: false };
  }

  createLink(input: CreateCanvasPromptLinkInput): CanvasPromptLink {
    const prompt = requirePrompt(this.findPrompt(input.promptNodeId), input.promptNodeId);
    const linkKind = input.linkKind ?? inferLinkKind(prompt.commandKind, input.targetKind);
    const existingLinks = this.listActiveLinksForPrompt(input.promptNodeId);
    for (const existing of existingLinks) {
      if (sameTarget(existing, input)) {
        return existing;
      }
    }
    if (linkKind === "question_answer" || linkKind === "question_context") {
      if (existingLinks.some((link) => link.linkKind === "workflow_dispatch" || link.linkKind === "plan_control")) {
        throw new Error("This prompt already has a workflow target. Create a new answer prompt for questions.");
      }
    } else {
      if (existingLinks.some((link) => link.linkKind === "question_answer" || link.linkKind === "question_context")) {
        throw new Error("This prompt is already being used as a question answer. Create a new prompt box for workflow actions.");
      }
      if (existingLinks.length) {
        throw new Error("Only one workflow target is allowed per prompt box right now.");
      }
    }
    const id = randomUUID();
    const orchestrationId = input.orchestrationId ?? null;
    const workflowGraphId = input.workflowGraphId ?? null;
    const workflowNodeId = input.workflowNodeId ?? null;
    const questionId = input.questionId ?? (input.targetKind === "open_question" ? workflowNodeId ?? input.targetId : null);
    const cardId = input.cardId ?? (input.targetKind === "task_card" || input.targetKind === "orchestration_parent" ? input.targetId : null);
    this.db
      .prepare(
        `
        INSERT INTO canvas_prompt_links (
          id, project_id, prompt_node_id, link_kind, owner_id, source_kind, source_id, target_kind, target_id, orchestration_id,
          question_id, workflow_graph_id, workflow_node_id, task_id, card_id, target_orchestration_id,
          target_workflow_graph_id, target_workflow_node_id, arrow_element_id, status
        )
        VALUES (
          @id, @projectId, @promptNodeId, @linkKind, @ownerId, @sourceKind, @sourceId, @targetKind, @targetId, @orchestrationId,
          @questionId, @workflowGraphId, @workflowNodeId, @taskId, @cardId, @targetOrchestrationId,
          @targetWorkflowGraphId, @targetWorkflowNodeId, @arrowElementId, 'linked'
        )
      `,
      )
      .run({
        id,
        projectId: input.projectId,
        promptNodeId: input.promptNodeId,
        linkKind,
        ownerId: input.ownerId,
        sourceKind: input.sourceKind ?? "canvas_prompt",
        sourceId: input.sourceId ?? input.promptNodeId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        orchestrationId,
        questionId,
        workflowGraphId,
        workflowNodeId,
        taskId: input.taskId ?? null,
        cardId,
        targetOrchestrationId: orchestrationId,
        targetWorkflowGraphId: workflowGraphId,
        targetWorkflowNodeId: workflowNodeId,
        arrowElementId: input.arrowElementId ?? `arc-prompt-link-${id}`,
      });
    this.updatePrompt(input.promptNodeId, { status: "linked" });
    return requireLink(this.findLink(id), id);
  }

  deleteLink(id: string): { deleted: boolean; locked: boolean } {
    const existing = this.findLink(id);
    if (!existing) return { deleted: false, locked: false };
    if (existing.status === "sent" || existing.status === "sending" || existing.status === "dirty") {
      return { deleted: false, locked: true };
    }
    this.db.prepare("UPDATE canvas_prompt_links SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL").run(id);
    return { deleted: true, locked: false };
  }

  markSending(linkId: string): void {
    this.db.prepare("UPDATE canvas_prompt_links SET status = 'sending', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(linkId);
    const link = this.findLink(linkId);
    if (link) {
      this.db.prepare("UPDATE canvas_prompt_nodes SET status = 'sending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(link.promptNodeId);
    }
  }

  markWaitingForBody(linkId: string): CanvasPromptLink {
    const link = requireLink(this.findLink(linkId), linkId);
    this.db.prepare("UPDATE canvas_prompt_links SET status = 'waiting_for_body', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(linkId);
    this.db.prepare("UPDATE canvas_prompt_nodes SET status = 'waiting_for_body', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(link.promptNodeId);
    return requireLink(this.findLink(linkId), linkId);
  }

  markDispatchSent(linkId: string, dispatchHash: string): CanvasPromptLink {
    const now = new Date().toISOString();
    const link = requireLink(this.findLink(linkId), linkId);
    this.db
      .prepare(
        `
        UPDATE canvas_prompt_links
        SET status = 'sent',
            dispatch_hash = @dispatchHash,
            dispatched_at = @now,
            error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @linkId
      `,
      )
      .run({ linkId, dispatchHash, now });
    this.db
      .prepare(
        `
        UPDATE canvas_prompt_nodes
        SET status = 'sent',
            last_dispatch_hash = @dispatchHash,
            last_dispatched_at = @now,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @promptNodeId
      `,
      )
      .run({ promptNodeId: link.promptNodeId, dispatchHash, now });
    return requireLink(this.findLink(linkId), linkId);
  }

  markDispatchFailed(linkId: string, error: string): CanvasPromptLink {
    const link = requireLink(this.findLink(linkId), linkId);
    this.db
      .prepare("UPDATE canvas_prompt_links SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(error, linkId);
    this.db.prepare("UPDATE canvas_prompt_nodes SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(link.promptNodeId);
    return requireLink(this.findLink(linkId), linkId);
  }
}

export function canvasPromptDispatchHash(prompt: CanvasPromptNode, link: CanvasPromptLink): string {
  return createHash("sha256")
    .update([
      prompt.id,
      link.id,
      link.linkKind,
      link.targetKind,
      link.targetId,
      prompt.commandKind,
      prompt.commandText,
      prompt.body,
      link.orchestrationId ?? "",
      link.workflowGraphId ?? "",
      link.workflowNodeId ?? "",
      link.questionId ?? "",
      link.taskId ?? "",
      link.cardId ?? "",
    ].join("\0"))
    .digest("hex");
}

function sameTarget(left: CanvasPromptLink, right: CreateCanvasPromptLinkInput): boolean {
  return (
    left.linkKind === (right.linkKind ?? left.linkKind) &&
    left.targetKind === right.targetKind &&
    left.targetId === right.targetId &&
    left.orchestrationId === (right.orchestrationId ?? null) &&
    left.workflowGraphId === (right.workflowGraphId ?? null) &&
    left.workflowNodeId === (right.workflowNodeId ?? null) &&
    left.questionId === (right.questionId ?? (right.targetKind === "open_question" ? right.workflowNodeId ?? right.targetId : null))
  );
}

function inferLinkKind(commandKind: CanvasPromptCommandKind, targetKind: CanvasPromptTargetKind): CanvasPromptLinkKind {
  if (targetKind === "open_question") {
    return commandKind === "answer" ? "question_answer" : "question_context";
  }
  if (commandKind === "continue_planning" || commandKind === "start_work" || commandKind === "remake_plan") {
    return "plan_control";
  }
  return "workflow_dispatch";
}

function requirePrompt(prompt: CanvasPromptNode | null, id: string): CanvasPromptNode {
  if (!prompt) throw new Error(`Canvas prompt ${id} could not be loaded.`);
  return prompt;
}

function requireLink(link: CanvasPromptLink | null, id: string): CanvasPromptLink {
  if (!link) throw new Error(`Canvas prompt link ${id} could not be loaded.`);
  return link;
}

function mapPrompt(row: PromptRow): CanvasPromptNode {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    ownerLabel: row.owner_label,
    commandKind: row.command_kind,
    commandText: row.command_text,
    body: row.body,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    status: row.status,
    lastDispatchHash: row.last_dispatch_hash,
    lastDispatchedAt: row.last_dispatched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapLink(row: LinkRow): CanvasPromptLink {
  return {
    id: row.id,
    projectId: row.project_id,
    promptNodeId: row.prompt_node_id,
    linkKind: row.link_kind ?? "workflow_dispatch",
    ownerId: row.owner_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    orchestrationId: row.orchestration_id ?? row.target_orchestration_id,
    questionId: row.question_id ?? (row.target_kind === "open_question" ? row.target_workflow_node_id ?? row.target_id : null),
    workflowGraphId: row.workflow_graph_id ?? row.target_workflow_graph_id,
    workflowNodeId: row.workflow_node_id ?? row.target_workflow_node_id,
    taskId: row.task_id,
    cardId: row.card_id ?? (row.target_kind === "task_card" || row.target_kind === "orchestration_parent" ? row.target_id : null),
    targetOrchestrationId: row.orchestration_id ?? row.target_orchestration_id,
    targetWorkflowGraphId: row.workflow_graph_id ?? row.target_workflow_graph_id,
    targetWorkflowNodeId: row.workflow_node_id ?? row.target_workflow_node_id,
    arrowElementId: row.arrow_element_id,
    status: row.status,
    dispatchHash: row.dispatch_hash,
    dispatchedAt: row.dispatched_at,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
