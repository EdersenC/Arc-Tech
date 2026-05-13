export const WORKFLOW_NODE_KINDS = [
  "goal",
  "requirement",
  "decision",
  "system_component",
  "frontend_component",
  "backend_component",
  "data_store",
  "external_service",
  "agent_task",
  "milestone",
  "risk",
  "open_question",
  "note",
] as const;

export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

export const WORKFLOW_NODE_STATUSES = [
  "proposed",
  "active",
  "in_progress",
  "blocked",
  "complete",
  "deprecated",
] as const;

export type WorkflowNodeStatus = (typeof WORKFLOW_NODE_STATUSES)[number];

export const WORKFLOW_EDGE_KINDS = [
  "depends_on",
  "implements",
  "contains",
  "blocks",
  "relates_to",
  "replaces",
  "answers",
  "mitigates",
  "produces",
  "consumes",
] as const;

export type WorkflowEdgeKind = (typeof WORKFLOW_EDGE_KINDS)[number];

export type WorkflowDecisionStatus = "proposed" | "accepted" | "superseded" | "deprecated";
export type WorkflowRiskStatus = "open" | "mitigated" | "accepted" | "deprecated";
export type WorkflowOpenQuestionStatus = "open" | "resolved" | "deprecated";

export interface WorkflowQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface WorkflowLayoutHint {
  id: string;
  nodeId: string;
  sectionId?: string;
  parentNodeId?: string;
  lane?: string;
  order?: number;
  group?: string;
}

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  status: WorkflowNodeStatus;
  title: string;
  summary?: string;
  body?: string;
  tags?: string[];
  owner?: string;
  sourcePatchId?: string;
  layoutHintId?: string;
  deprecatedAt?: string;
  deprecatedReason?: string;
  replacementNodeId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEdge {
  id: string;
  kind: WorkflowEdgeKind;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  status?: "active" | "deprecated";
  sourcePatchId?: string;
  deprecatedAt?: string;
  deprecatedReason?: string;
  replacementEdgeId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDecision {
  id: string;
  title: string;
  summary: string;
  status: WorkflowDecisionStatus;
  nodeId?: string;
  supersedesDecisionId?: string;
  sourcePatchId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRisk {
  id: string;
  title: string;
  impact: string;
  status: WorkflowRiskStatus;
  mitigation?: string;
  nodeIds?: string[];
  sourcePatchId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface WorkflowOpenQuestion {
  id: string;
  question: string;
  detail?: string;
  status: WorkflowOpenQuestionStatus;
  answer?: string;
  allowMultiSelect?: boolean;
  options?: WorkflowQuestionOption[];
  recommendedOptionIds?: string[];
  recommendationRationale?: string;
  nodeIds?: string[];
  sourcePatchId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface WorkflowRevision {
  revision: number;
  patchId: string;
  reason: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  operationCount: number;
}

export interface WorkflowGraph {
  id: string;
  projectId?: string;
  title: string;
  description?: string;
  revision: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  decisions: WorkflowDecision[];
  risks: WorkflowRisk[];
  openQuestions: WorkflowOpenQuestion[];
  layoutHints: WorkflowLayoutHint[];
  revisions: WorkflowRevision[];
  createdAt: string;
  updatedAt: string;
}

export type WorkflowPatchOperation =
  | { op: "create_graph"; graph: Omit<WorkflowGraph, "revision" | "revisions" | "createdAt" | "updatedAt"> & Partial<Pick<WorkflowGraph, "createdAt" | "updatedAt">> }
  | { op: "add_node"; node: WorkflowNode }
  | { op: "update_node"; nodeId: string; changes: WorkflowNodePatch }
  | { op: "remove_node"; nodeId: string }
  | { op: "add_edge"; edge: WorkflowEdge }
  | { op: "update_edge"; edgeId: string; changes: WorkflowEdgePatch }
  | { op: "remove_edge"; edgeId: string }
  | { op: "replace_decision"; decisionId: string; decision: WorkflowDecision }
  | { op: "mark_deprecated"; targetType: WorkflowPatchTargetType; targetId: string; reason: string; replacementId?: string }
  | { op: "add_risk"; risk: WorkflowRisk }
  | { op: "add_open_question"; question: WorkflowOpenQuestion }
  | { op: "update_open_question"; questionId: string; changes: WorkflowOpenQuestionPatch }
  | { op: "resolve_open_question"; questionId: string; answer: string }
  | { op: "relayout_section"; sectionId: string; hints: WorkflowLayoutHint[] };

export type WorkflowPatchTargetType = "node" | "edge" | "decision" | "risk" | "open_question";

export type WorkflowNodePatch = Partial<
  Pick<
    WorkflowNode,
    | "kind"
    | "status"
    | "title"
    | "summary"
    | "body"
    | "tags"
    | "owner"
    | "layoutHintId"
    | "deprecatedAt"
    | "deprecatedReason"
    | "replacementNodeId"
  >
>;

export type WorkflowEdgePatch = Partial<
  Pick<
    WorkflowEdge,
    | "kind"
    | "fromNodeId"
    | "toNodeId"
    | "label"
    | "status"
    | "deprecatedAt"
    | "deprecatedReason"
    | "replacementEdgeId"
  >
>;

export type WorkflowOpenQuestionPatch = Partial<
  Pick<
    WorkflowOpenQuestion,
    | "question"
    | "detail"
    | "status"
    | "answer"
    | "allowMultiSelect"
    | "options"
    | "recommendedOptionIds"
    | "recommendationRationale"
    | "nodeIds"
    | "resolvedAt"
  >
>;

export interface WorkflowPatch {
  id: string;
  graphId?: string;
  baseRevision?: number;
  reason: string;
  author?: string;
  createdAt: string;
  operations: WorkflowPatchOperation[];
}
