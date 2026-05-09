export type ArcWorkflowEventType = "workflow.snapshot" | "workflow.patch_applied" | "workflow.patch_rejected" | "workflow.graph_created";

export interface ArcWorkflowGraphResponse {
  workflow: ArcPersistedWorkflowGraph | null;
}

export interface ArcWorkflowPatchResponse {
  workflow: ArcPersistedWorkflowGraph;
  patch: ArcPersistedWorkflowPatch | null;
}

export interface ArcWorkflowHistoryResponse {
  patches: ArcPersistedWorkflowPatch[];
}

export interface ArcPersistedWorkflowGraph {
  id: number;
  projectId: number;
  orchestrationId: number | null;
  title: string;
  revision: number;
  graph: ArcWorkflowGraph;
  createdAt: string;
  updatedAt: string;
}

export interface ArcPersistedWorkflowPatch {
  id: number;
  graphId: number;
  projectId: number;
  orchestrationId: number | null;
  baseRevision: number;
  resultingRevision: number;
  patch: ArcWorkflowPatch;
  source: string;
  reason: string;
  createdAt: string;
}

export interface ArcWorkflowEvent {
  id: number;
  type: ArcWorkflowEventType;
  projectId: number;
  orchestrationId: number | null;
  graphId: number | null;
  graph?: ArcPersistedWorkflowGraph;
  patch?: ArcPersistedWorkflowPatch | ArcWorkflowPatch;
  error?: string;
  createdAt: string;
}

export interface ArcWorkflowGraph {
  id: string;
  projectId?: string;
  title: string;
  description?: string;
  revision: number;
  nodes: ArcWorkflowNode[];
  edges: ArcWorkflowEdge[];
  decisions: unknown[];
  risks: unknown[];
  openQuestions: unknown[];
  layoutHints: unknown[];
  revisions: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface ArcWorkflowNode {
  id: string;
  kind: string;
  status: string;
  title: string;
  summary?: string;
  body?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArcWorkflowEdge {
  id: string;
  kind: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArcWorkflowPatch {
  id: string;
  graphId?: string;
  baseRevision?: number;
  reason: string;
  author?: string;
  createdAt: string;
  operations: unknown[];
}

export async function getCurrentWorkflowForProject(projectId: number): Promise<ArcWorkflowGraphResponse> {
  const response = await fetch(`/api/workflows/project/${encodeURIComponent(String(projectId))}/current`);
  return parseJsonResponse(response);
}

export async function getWorkflowForOrchestration(orchestrationId: number): Promise<ArcWorkflowGraphResponse> {
  const response = await fetch(`/api/workflows/orchestration/${encodeURIComponent(String(orchestrationId))}`);
  return parseJsonResponse(response);
}

export async function getWorkflowHistory(graphId: number): Promise<ArcWorkflowHistoryResponse> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(String(graphId))}/history`);
  return parseJsonResponse(response);
}

export async function applyWorkflowPatch(orchestrationId: number, patch: ArcWorkflowPatch): Promise<ArcWorkflowPatchResponse> {
  const response = await fetch(`/api/workflows/orchestration/${encodeURIComponent(String(orchestrationId))}/patch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patch }),
  });
  return parseJsonResponse(response);
}

export function openWorkflowEventSource(projectId: number, onEvent: (event: ArcWorkflowEvent) => void): EventSource {
  const source = new EventSource(`/api/workflows/events?projectId=${encodeURIComponent(String(projectId))}`);
  const eventTypes: ArcWorkflowEventType[] = ["workflow.snapshot", "workflow.patch_applied", "workflow.patch_rejected", "workflow.graph_created"];
  for (const type of eventTypes) {
    source.addEventListener(type, (event) => {
      onEvent(JSON.parse((event as MessageEvent<string>).data) as ArcWorkflowEvent);
    });
  }
  return source;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!response.ok) {
    const suffix = body.code ? ` (${body.code})` : "";
    throw new Error(`${body.error ?? `Request failed with ${response.status}`}${suffix}`);
  }
  return body as T;
}
