import type Database from "better-sqlite3";
import type { OrchestrationContractRevision, OrchestrationSafetyKind, OrchestrationSafetyRecord, OrchestrationSafetyStatus } from "../types.js";

type SafetyRow = {
  id: number;
  orchestration_id: number;
  agent_id: number | null;
  task_id: number | null;
  kind: OrchestrationSafetyKind;
  status: OrchestrationSafetyStatus;
  title: string;
  body: string;
  severity: string | null;
  needs_orchestrator_action: number;
  needs_user_action: number;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

type ContractRevisionRow = {
  id: number;
  orchestration_id: number;
  safety_record_id: number | null;
  revision_kind: OrchestrationContractRevision["revisionKind"];
  summary: string;
  payload_json: string | null;
  created_at: string;
};

export interface CreateSafetyRecordInput {
  orchestrationId: number;
  agentId?: number | null;
  taskId?: number | null;
  kind: OrchestrationSafetyKind;
  title: string;
  body?: string;
  severity?: string | null;
  needsOrchestratorAction?: boolean;
  needsUserAction?: boolean;
  payload?: unknown;
}

export class OrchestrationSafetyRepo {
  constructor(private readonly db: Database.Database) {}

  listByOrchestrationId(orchestrationId: number): OrchestrationSafetyRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestration_safety_records WHERE orchestration_id = ? ORDER BY datetime(created_at) DESC, id DESC")
      .all(orchestrationId) as SafetyRow[];
    return rows.map(mapSafetyRecord);
  }

  listContractRevisions(orchestrationId: number): OrchestrationContractRevision[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestration_contract_revisions WHERE orchestration_id = ? ORDER BY datetime(created_at) DESC, id DESC")
      .all(orchestrationId) as ContractRevisionRow[];
    return rows.map(mapContractRevision);
  }

  create(input: CreateSafetyRecordInput): OrchestrationSafetyRecord {
    const status: OrchestrationSafetyStatus = input.kind === "notify_dependency_ready" ? "resolved" : "open";
    this.db
      .prepare(
        `
        INSERT INTO orchestration_safety_records (
          orchestration_id, agent_id, task_id, kind, status, title, body, severity,
          needs_orchestrator_action, needs_user_action, payload_json, resolved_at
        )
        VALUES (
          @orchestrationId, @agentId, @taskId, @kind, @status, @title, @body, @severity,
          @needsOrchestratorAction, @needsUserAction, @payloadJson, @resolvedAt
        )
      `,
      )
      .run({
        orchestrationId: input.orchestrationId,
        agentId: input.agentId ?? null,
        taskId: input.taskId ?? null,
        kind: input.kind,
        status,
        title: input.title,
        body: input.body ?? "",
        severity: input.severity ?? null,
        needsOrchestratorAction: input.needsOrchestratorAction ? 1 : 0,
        needsUserAction: input.needsUserAction ? 1 : 0,
        payloadJson: JSON.stringify(input.payload ?? null),
        resolvedAt: status === "resolved" ? new Date().toISOString() : null,
      });
    const id = Number((this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    return requireSafety(this.findById(id), id);
  }

  findById(id: number): OrchestrationSafetyRecord | null {
    const row = this.db.prepare("SELECT * FROM orchestration_safety_records WHERE id = ?").get(id) as SafetyRow | undefined;
    return row ? mapSafetyRecord(row) : null;
  }

  updateStatus(id: number, status: OrchestrationSafetyStatus, body?: string): OrchestrationSafetyRecord | null {
    const before = this.findById(id);
    const resolved = status === "approved" || status === "denied" || status === "resolved" || status === "superseded";
    this.db
      .prepare(
        `
        UPDATE orchestration_safety_records
        SET status = @status,
            body = CASE WHEN @body IS NULL THEN body ELSE @body END,
            needs_orchestrator_action = CASE WHEN @resolved THEN 0 ELSE needs_orchestrator_action END,
            needs_user_action = CASE WHEN @resolved THEN 0 ELSE needs_user_action END,
            resolved_at = CASE WHEN @resolved THEN COALESCE(resolved_at, @now) ELSE resolved_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @id
      `,
      )
      .run({ id, status, body: body ?? null, resolved: resolved ? 1 : 0, now: new Date().toISOString() });
    const after = this.findById(id);
    if (before && after && status === "approved" && before.status !== "approved") {
      this.recordContractRevision(after);
    }
    return after;
  }

  private recordContractRevision(record: OrchestrationSafetyRecord): void {
    const revisionKind =
      record.kind === "request_scope_change" ? "scope" : record.kind === "request_interface_change" ? "interface" : null;
    if (!revisionKind) return;
    this.db
      .prepare(
        `
        INSERT INTO orchestration_contract_revisions (
          orchestration_id, safety_record_id, revision_kind, summary, payload_json
        )
        VALUES (@orchestrationId, @safetyRecordId, @revisionKind, @summary, @payloadJson)
      `,
      )
      .run({
        orchestrationId: record.orchestrationId,
        safetyRecordId: record.id,
        revisionKind,
        summary: record.title,
        payloadJson: JSON.stringify(record.payload ?? null),
      });
  }
}

function requireSafety(record: OrchestrationSafetyRecord | null, id: number): OrchestrationSafetyRecord {
  if (!record) throw new Error(`Safety record #${id} could not be loaded.`);
  return record;
}

function mapSafetyRecord(row: SafetyRow): OrchestrationSafetyRecord {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    body: row.body,
    severity: row.severity,
    needsOrchestratorAction: row.needs_orchestrator_action === 1,
    needsUserAction: row.needs_user_action === 1,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function mapContractRevision(row: ContractRevisionRow): OrchestrationContractRevision {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    safetyRecordId: row.safety_record_id,
    revisionKind: row.revision_kind,
    summary: row.summary,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
