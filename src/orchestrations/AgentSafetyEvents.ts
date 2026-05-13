import type { OrchestrationSafetyKind } from "./types.js";

const SAFETY_KINDS: readonly OrchestrationSafetyKind[] = [
  "query_contract",
  "query_project_context",
  "query_plan_history",
  "query_user_decisions",
  "query_prompt_artifacts",
  "request_scope_change",
  "request_interface_change",
  "report_contract_deviation",
  "declare_assumption",
  "risk_register_update",
  "sync_with_orchestrator",
  "request_peer_coordination",
  "notify_dependency_ready",
  "request_dependency_status",
  "report_validation_result",
  "request_test_help",
  "handoff_to_integration",
  "request_retry",
  "request_reassignment",
  "abort_with_reason",
];

export interface AgentSafetyEvent {
  kind: OrchestrationSafetyKind;
  title?: string;
  body?: string;
  severity?: string;
  needsUserAction?: boolean;
  payload?: unknown;
}

export function parseAgentSafetyEvents(output: string): AgentSafetyEvent[] {
  const events: AgentSafetyEvent[] = [];
  const pattern = /```ARC_AGENT_SAFETY_EVENT_JSON\s*([\s\S]*?)```/gi;
  for (const match of output.matchAll(pattern)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const parsed = parseJson(raw);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    for (const value of values) {
      const event = normalizeSafetyEvent(value);
      if (event) events.push(event);
    }
  }
  return events;
}

export function safetyEventNeedsOrchestrator(kind: OrchestrationSafetyKind, severity?: string | null, payload?: unknown): boolean {
  if (kind === "notify_dependency_ready") return false;
  if (kind === "handoff_to_integration") return false;
  if (kind === "report_validation_result") return validationResultNeedsAction(payload);
  if (kind === "declare_assumption") return severity === "high" || severity === "critical";
  return true;
}

function normalizeSafetyEvent(value: unknown): AgentSafetyEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" && SAFETY_KINDS.includes(record.kind as OrchestrationSafetyKind)
    ? (record.kind as OrchestrationSafetyKind)
    : null;
  if (!kind) return null;
  return {
    kind,
    title: typeof record.title === "string" ? record.title : titleForKind(kind),
    body: typeof record.body === "string" ? record.body : "",
    severity: typeof record.severity === "string" ? record.severity : undefined,
    needsUserAction: record.needsUserAction === true,
    payload: record,
  };
}

function titleForKind(kind: OrchestrationSafetyKind): string {
  return kind.replace(/_/g, " ");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function validationResultNeedsAction(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return true;
  const record = payload as Record<string, unknown>;
  const nested = record.payload && typeof record.payload === "object" ? record.payload as Record<string, unknown> : record;
  const status = String(nested.status ?? nested.result ?? "").toLowerCase();
  return status === "failed" || status === "fail" || status === "error";
}
