import {
  WORKFLOW_EDGE_KINDS,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_NODE_STATUSES,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowOpenQuestion,
  type WorkflowPatch,
} from "./types.js";
import { validateWorkflowPatch } from "./validation.js";

export const WORKFLOW_PATCH_BLOCK = "ARC_WORKFLOW_PATCH_JSON";

export type PlannerWorkflowPatchParseResult =
  | { status: "none" }
  | { status: "valid"; patch: WorkflowPatch }
  | { status: "rejected"; error: string; raw: string };

export function extractNewestWorkflowPatchBlock(content: string): string | null {
  const blocks = [...content.matchAll(/```ARC_WORKFLOW_PATCH_JSON\s*([\s\S]*?)```/g)];
  const newest = blocks.at(-1);
  return newest ? newest[1].trim() : null;
}

export interface PlannerWorkflowPatchContext {
  graph?: Pick<WorkflowGraph, "id" | "revision">;
  author?: string;
  now?: string;
}

export function parsePlannerWorkflowPatch(content: string, context: PlannerWorkflowPatchContext = {}): PlannerWorkflowPatchParseResult {
  const raw = extractNewestWorkflowPatchBlock(content);
  if (!raw) {
    return { status: "none" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const preview = raw.replace(/\s+/g, " ").slice(0, 180);
    return {
      status: "rejected",
      raw,
      error: `Workflow patch JSON is malformed inside the newest ${WORKFLOW_PATCH_BLOCK} block: ${error instanceof Error ? error.message : String(error)}. Check the fenced block contains one complete JSON object. Preview: ${preview}`,
    };
  }

  const normalized = normalizeWorkflowPatchCandidate(parsed, context);
  const validation = validateWorkflowPatch(normalized);
  if (!validation.ok || !validation.value) {
    return {
      status: "rejected",
      raw,
      error: `Workflow patch JSON is invalid: ${validation.errors.join("; ")}`,
    };
  }

  return { status: "valid", patch: validation.value };
}

export function normalizeWorkflowPatchCandidate(value: unknown, context: PlannerWorkflowPatchContext = {}): unknown {
  if (!isRecord(value)) return value;
  const createdAt = stringValue(value.createdAt) ?? context.now ?? new Date().toISOString();
  const rawOperations = value.operations;
  const operations = Array.isArray(rawOperations)
    ? rawOperations.map((operation, index) => normalizeOperation(operation, createdAt, index, rawOperations))
    : rawOperations;
  return {
    ...value,
    id: stringValue(value.id) ?? stableId("patch", context.graph?.id ?? "workflow", String(context.graph?.revision ?? 0), stableJson(operations)),
    graphId: stringValue(value.graphId) ?? context.graph?.id,
    baseRevision: typeof value.baseRevision === "number" ? value.baseRevision : context.graph?.revision,
    reason: stringValue(value.reason) ?? "Planner workflow update.",
    author: stringValue(value.author) ?? context.author ?? "planner",
    createdAt,
    operations,
  };
}

function normalizeOperation(value: unknown, createdAt: string, index: number, operations: readonly unknown[] = []): unknown {
  if (!isRecord(value)) return value;
  switch (value.op) {
    case "add_node":
      return { op: "add_node", node: normalizeNode(isRecord(value.node) ? value.node : value, createdAt, index) };
    case "update_node":
      return { op: "update_node", nodeId: value.nodeId, changes: normalizeNodePatch(value.changes) };
    case "add_edge":
      return { op: "add_edge", edge: normalizeEdge(isRecord(value.edge) ? value.edge : value, createdAt, index) };
    case "update_edge":
      return { op: "update_edge", edgeId: value.edgeId, changes: normalizeEdgePatch(value.changes) };
    case "create_graph":
      return isRecord(value.graph)
        ? {
            op: "create_graph",
            graph: {
              ...value.graph,
              nodes: Array.isArray(value.graph.nodes)
                ? value.graph.nodes.map((node, nodeIndex) => normalizeNode(node, createdAt, nodeIndex))
                : value.graph.nodes,
              edges: Array.isArray(value.graph.edges)
                ? value.graph.edges.map((edge, edgeIndex) => normalizeEdge(edge, createdAt, edgeIndex))
                : value.graph.edges,
            },
          }
        : value;
    case "add_open_question":
      return { op: "add_open_question", question: normalizeOpenQuestion(openQuestionCandidate(value, operations), createdAt, index) };
    case "update_open_question":
      return { op: "update_open_question", questionId: value.questionId, changes: normalizeOpenQuestionPatch(value.changes) };
    case "resolve_open_question":
      return { op: "resolve_open_question", questionId: value.questionId, answer: value.answer };
    default:
      return value;
  }
}

function openQuestionCandidate(value: Record<string, unknown>, operations: readonly unknown[]): unknown {
  if (isRecord(value.question)) return value.question;
  const nodeId = stringValue(value.nodeId);
  const node = nodeId ? findAddedNode(operations, nodeId) : null;
  return {
    ...value,
    id: stringValue(value.id) ?? stringValue(value.questionId) ?? nodeId,
    question: stringValue(value.question) ?? stringValue(value.text) ?? stringValue(value.title) ?? node?.title,
    detail: stringValue(value.detail) ?? stringValue(value.body) ?? stringValue(value.summary) ?? node?.summary ?? node?.body,
    nodeIds: Array.isArray(value.nodeIds) ? value.nodeIds : nodeId ? [nodeId] : value.nodeIds,
    status: stringValue(value.status) ?? "open",
    createdAt: stringValue(value.createdAt) ?? node?.createdAt,
    updatedAt: stringValue(value.updatedAt) ?? node?.updatedAt,
  };
}

function findAddedNode(operations: readonly unknown[], nodeId: string): WorkflowNode | null {
  for (const operation of operations) {
    if (!isRecord(operation) || operation.op !== "add_node") continue;
    const normalized = normalizeNode(isRecord(operation.node) ? operation.node : operation, new Date().toISOString(), 0);
    if (isWorkflowNode(normalized) && normalized.id === nodeId) {
      return normalized;
    }
  }
  return null;
}

function normalizeNode(value: unknown, createdAt: string, index: number): WorkflowNode | unknown {
  if (!isRecord(value)) return value;
  const { type: _type, label: _label, op: _op, node: _node, edge: _edge, changes: _changes, from: _from, to: _to, ...rest } = value;
  const title = stringValue(value.title) ?? stringValue(value.label);
  const kind = normalizeNodeKind(stringValue(value.kind) ?? stringValue(value.type), title);
  return {
    ...rest,
    id: stringValue(value.id) ?? stableId("node", kind ?? "note", title ?? String(index)),
    kind,
    status: normalizeNodeStatus(stringValue(value.status)),
    title,
    createdAt: stringValue(value.createdAt) ?? createdAt,
    updatedAt: stringValue(value.updatedAt) ?? createdAt,
  };
}

function normalizeNodePatch(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { type: _type, label: _label, createdAt: _createdAt, updatedAt: _updatedAt, sourcePatchId: _sourcePatchId, ...rest } = value;
  return omitUndefined({
    ...rest,
    kind: value.kind !== undefined || value.type !== undefined
      ? normalizeNodeKind(stringValue(value.kind) ?? stringValue(value.type), stringValue(value.title) ?? stringValue(value.label))
      : undefined,
    status: value.status === undefined ? undefined : normalizeNodeStatus(stringValue(value.status)),
    title: stringValue(value.title) ?? stringValue(value.label),
  });
}

function normalizeEdge(value: unknown, createdAt: string, index: number): WorkflowEdge | unknown {
  if (!isRecord(value)) return value;
  const { type: _type, from: _from, to: _to, op: _op, node: _node, edge: _edge, changes: _changes, ...rest } = value;
  const kind = normalizeEdgeKind(stringValue(value.kind) ?? stringValue(value.type));
  const fromNodeId = stringValue(value.fromNodeId) ?? stringValue(value.from);
  const toNodeId = stringValue(value.toNodeId) ?? stringValue(value.to);
  return {
    ...rest,
    id: stringValue(value.id) ?? stableId("edge", fromNodeId ?? "from", toNodeId ?? "to", kind ?? String(index)),
    kind,
    fromNodeId,
    toNodeId,
    status: normalizeEdgeStatus(stringValue(value.status)),
    createdAt: stringValue(value.createdAt) ?? createdAt,
    updatedAt: stringValue(value.updatedAt) ?? createdAt,
  };
}

function normalizeEdgePatch(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { type: _type, from: _from, to: _to, createdAt: _createdAt, updatedAt: _updatedAt, sourcePatchId: _sourcePatchId, ...rest } = value;
  return omitUndefined({
    ...rest,
    kind: value.kind !== undefined || value.type !== undefined ? normalizeEdgeKind(stringValue(value.kind) ?? stringValue(value.type)) : undefined,
    fromNodeId: stringValue(value.fromNodeId) ?? stringValue(value.from),
    toNodeId: stringValue(value.toNodeId) ?? stringValue(value.to),
    status: value.status === undefined ? undefined : normalizeEdgeStatus(stringValue(value.status)),
  });
}

function normalizeOpenQuestion(value: unknown, createdAt: string, index: number): WorkflowOpenQuestion | unknown {
  if (!isRecord(value)) return value;
  const {
    text: _text,
    label: _label,
    title: _title,
    body: _body,
    summary: _summary,
    rationale: _rationale,
    optionIds: _optionIds,
    op: _op,
    nodeId: _nodeId,
    questionId: _questionId,
    ...rest
  } = value;
  const question = stringValue(value.question) ?? stringValue(value.text) ?? stringValue(value.title);
  const options = Array.isArray(value.options)
    ? value.options.map((option, optionIndex) => normalizeQuestionOption(option, question ?? String(index), optionIndex))
    : value.options;
  return omitUndefined({
    ...rest,
    id: stringValue(value.id) ?? stableId("question", question ?? String(index)),
    question,
    detail: stringValue(value.detail) ?? stringValue(value.body) ?? stringValue(value.summary),
    status: normalizeOpenQuestionStatus(stringValue(value.status)),
    allowMultiSelect: typeof value.allowMultiSelect === "boolean" ? value.allowMultiSelect : value.allowMultiSelect,
    options,
    recommendedOptionIds: Array.isArray(value.recommendedOptionIds) ? value.recommendedOptionIds : value.recommendedOptionIds,
    recommendationRationale: stringValue(value.recommendationRationale) ?? stringValue(value.rationale),
    nodeIds: Array.isArray(value.nodeIds) ? value.nodeIds : value.nodeId ? [value.nodeId] : value.nodeIds,
    createdAt: stringValue(value.createdAt) ?? createdAt,
    updatedAt: stringValue(value.updatedAt) ?? createdAt,
  });
}

function normalizeQuestionOption(value: unknown, question: string, index: number): unknown {
  if (!isRecord(value)) {
    const label = typeof value === "string" ? value : String(index + 1);
    return { id: stableId("option", question, label), label };
  }
  const label = stringValue(value.label) ?? stringValue(value.title) ?? stringValue(value.text) ?? String(index + 1);
  return {
    id: stringValue(value.id) ?? stableId("option", question, label),
    label,
    description: stringValue(value.description) ?? stringValue(value.detail) ?? stringValue(value.summary),
  };
}

function normalizeOpenQuestionPatch(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const {
    text: _text,
    title: _title,
    body: _body,
    summary: _summary,
    rationale: _rationale,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    sourcePatchId: _sourcePatchId,
    selectedOptionIds: _selectedOptionIds,
    selectedLabels: _selectedLabels,
    ...rest
  } = value;
  return omitUndefined({
    ...rest,
    question: stringValue(value.question) ?? stringValue(value.text) ?? stringValue(value.title),
    detail: stringValue(value.detail) ?? stringValue(value.body) ?? stringValue(value.summary),
    status: value.status === undefined ? undefined : normalizeOpenQuestionStatus(stringValue(value.status)),
    options: Array.isArray(value.options) ? value.options.map((option, index) => normalizeQuestionOption(option, stringValue(value.question) ?? "question", index)) : value.options,
    recommendationRationale: stringValue(value.recommendationRationale) ?? stringValue(value.rationale),
    nodeIds: Array.isArray(value.nodeIds) ? value.nodeIds : value.nodeId ? [value.nodeId] : value.nodeIds,
  });
}

function normalizeOpenQuestionStatus(value: string | undefined): WorkflowOpenQuestion["status"] {
  const token = canonicalToken(value);
  if (token === "resolved" || token === "answered" || token === "complete" || token === "done") return "resolved";
  if (token === "deprecated" || token === "removed" || token === "obsolete") return "deprecated";
  return "open";
}

function normalizeNodeKind(value: string | undefined, title: string | undefined): WorkflowNode["kind"] {
  const enumValue = canonicalEnumValue(value);
  if (isWorkflowNodeKind(enumValue)) return enumValue;
  const token = canonicalToken(value);

  const aliases: Record<string, WorkflowNode["kind"]> = {
    agent: "agent_task",
    agenttask: "agent_task",
    task: "agent_task",
    work: "agent_task",
    implementation: "agent_task",
    step: "agent_task",
    frontend: "frontend_component",
    ui: "frontend_component",
    client: "frontend_component",
    backend: "backend_component",
    api: "backend_component",
    server: "backend_component",
    database: "data_store",
    db: "data_store",
    datastore: "data_store",
    storage: "data_store",
    service: "external_service",
    external: "external_service",
    integration: "external_service",
    component: "system_component",
    system: "system_component",
    architecture: "system_component",
    gamemodule: "system_component",
    game: "system_component",
    gameplay: "system_component",
    module: "system_component",
    platform: "system_component",
    question: "open_question",
    openquestion: "open_question",
    open: "open_question",
    note: "note",
    goal: "goal",
    requirement: "requirement",
    decision: "decision",
    milestone: "milestone",
    risk: "risk",
  };
  if (token && aliases[token]) return aliases[token];

  const haystack = canonicalToken(`${value ?? ""} ${title ?? ""}`);
  if (haystack.includes("frontend") || haystack.includes("ui")) return "frontend_component";
  if (haystack.includes("backend") || haystack.includes("api") || haystack.includes("server")) return "backend_component";
  if (haystack.includes("database") || haystack.includes("datastore") || haystack.includes("storage")) return "data_store";
  if (haystack.includes("service") || haystack.includes("integration")) return "external_service";
  if (haystack.includes("architecture") || haystack.includes("module") || haystack.includes("platform") || haystack.includes("game")) return "system_component";
  if (haystack.includes("question") || haystack.includes("answer")) return "open_question";
  if (haystack.includes("decision")) return "decision";
  if (haystack.includes("risk")) return "risk";
  if (haystack.includes("goal")) return "goal";
  if (haystack.includes("requirement")) return "requirement";
  if (haystack.includes("milestone")) return "milestone";
  if (haystack.includes("task") || haystack.includes("agent") || haystack.includes("work")) return "agent_task";
  if (haystack.includes("component")) return "system_component";
  return "note";
}

function normalizeNodeStatus(value: string | undefined): WorkflowNode["status"] {
  const enumValue = canonicalEnumValue(value);
  if (isWorkflowNodeStatus(enumValue)) return enumValue;
  const token = canonicalToken(value);
  const aliases: Record<string, WorkflowNode["status"]> = {
    pending: "proposed",
    todo: "proposed",
    planned: "proposed",
    planning: "proposed",
    started: "in_progress",
    running: "in_progress",
    working: "in_progress",
    doing: "in_progress",
    waiting: "blocked",
    waitinguser: "blocked",
    waitingforuser: "blocked",
    needsanswer: "blocked",
    needsinput: "blocked",
    open: "active",
    resolved: "complete",
    done: "complete",
    completed: "complete",
    finished: "complete",
    removed: "deprecated",
    obsolete: "deprecated",
  };
  return (token && aliases[token]) || "active";
}

function normalizeEdgeKind(value: string | undefined): WorkflowEdge["kind"] {
  const enumValue = canonicalEnumValue(value);
  if (isWorkflowEdgeKind(enumValue)) return enumValue;
  const token = canonicalToken(value);
  const aliases: Record<string, WorkflowEdge["kind"]> = {
    dependency: "depends_on",
    depends: "depends_on",
    require: "depends_on",
    requires: "depends_on",
    requiredby: "depends_on",
    implement: "implements",
    implementedby: "implements",
    contain: "contains",
    child: "contains",
    parent: "contains",
    partof: "contains",
    decomposesinto: "contains",
    decomposes: "contains",
    includes: "contains",
    blocker: "blocks",
    blockedby: "blocks",
    block: "blocks",
    related: "relates_to",
    relates: "relates_to",
    relation: "relates_to",
    replaces: "replaces",
    supersedes: "replaces",
    answer: "answers",
    answeredby: "answers",
    resolves: "answers",
    mitigate: "mitigates",
    mitigation: "mitigates",
    output: "produces",
    outputs: "produces",
    produce: "produces",
    input: "consumes",
    inputs: "consumes",
    uses: "consumes",
    consume: "consumes",
    enabledby: "depends_on",
    enables: "implements",
  };
  return (token && aliases[token]) || "relates_to";
}

function normalizeEdgeStatus(value: string | undefined): WorkflowEdge["status"] {
  const token = canonicalToken(value);
  return token === "deprecated" || token === "removed" || token === "obsolete" ? "deprecated" : "active";
}

function canonicalToken(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function canonicalEnumValue(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function isWorkflowNodeKind(value: string): value is WorkflowNode["kind"] {
  return (WORKFLOW_NODE_KINDS as readonly string[]).includes(value);
}

function isWorkflowNodeStatus(value: string): value is WorkflowNode["status"] {
  return (WORKFLOW_NODE_STATUSES as readonly string[]).includes(value);
}

function isWorkflowEdgeKind(value: string): value is WorkflowEdge["kind"] {
  return (WORKFLOW_EDGE_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isWorkflowNode(value: unknown): value is WorkflowNode {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function stableId(prefix: string, ...parts: string[]): string {
  const slug = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 92);
  return `${prefix}-${slug || "workflow-update"}`;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
