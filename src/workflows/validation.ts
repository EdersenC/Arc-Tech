import { z } from "zod";
import {
  WORKFLOW_EDGE_KINDS,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_NODE_STATUSES,
  type WorkflowGraph,
  type WorkflowPatch,
} from "./types.js";

export const workflowStableIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)*$/, "must be a stable lowercase id such as workflow:arc-live-canvas or node-https-api");

const timestampSchema = z.string().trim().min(1);
const optionalTextSchema = z.string().trim().min(1).optional();
const textSchema = z.string().trim().min(1);
const tagSchema = z.string().trim().min(1).max(80);

const workflowQuestionOptionSchema = z
  .object({
    id: workflowStableIdSchema,
    label: textSchema,
    description: optionalTextSchema,
  })
  .strict();

export const workflowLayoutHintSchema = z
  .object({
    id: workflowStableIdSchema,
    nodeId: workflowStableIdSchema,
    sectionId: workflowStableIdSchema.optional(),
    parentNodeId: workflowStableIdSchema.optional(),
    lane: optionalTextSchema,
    order: z.number().int().optional(),
    group: optionalTextSchema,
  })
  .strict();

export const workflowNodeSchema = z
  .object({
    id: workflowStableIdSchema,
    kind: z.enum(WORKFLOW_NODE_KINDS),
    status: z.enum(WORKFLOW_NODE_STATUSES),
    title: textSchema,
    summary: optionalTextSchema,
    body: optionalTextSchema,
    tags: z.array(tagSchema).optional(),
    owner: optionalTextSchema,
    sourcePatchId: workflowStableIdSchema.optional(),
    layoutHintId: workflowStableIdSchema.optional(),
    deprecatedAt: timestampSchema.optional(),
    deprecatedReason: optionalTextSchema,
    replacementNodeId: workflowStableIdSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const workflowEdgeSchema = z
  .object({
    id: workflowStableIdSchema,
    kind: z.enum(WORKFLOW_EDGE_KINDS),
    fromNodeId: workflowStableIdSchema,
    toNodeId: workflowStableIdSchema,
    label: optionalTextSchema,
    status: z.enum(["active", "deprecated"]).optional(),
    sourcePatchId: workflowStableIdSchema.optional(),
    deprecatedAt: timestampSchema.optional(),
    deprecatedReason: optionalTextSchema,
    replacementEdgeId: workflowStableIdSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const workflowDecisionSchema = z
  .object({
    id: workflowStableIdSchema,
    title: textSchema,
    summary: textSchema,
    status: z.enum(["proposed", "accepted", "superseded", "deprecated"]),
    nodeId: workflowStableIdSchema.optional(),
    supersedesDecisionId: workflowStableIdSchema.optional(),
    sourcePatchId: workflowStableIdSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const workflowRiskSchema = z
  .object({
    id: workflowStableIdSchema,
    title: textSchema,
    impact: textSchema,
    status: z.enum(["open", "mitigated", "accepted", "deprecated"]),
    mitigation: optionalTextSchema,
    nodeIds: z.array(workflowStableIdSchema).optional(),
    sourcePatchId: workflowStableIdSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    resolvedAt: timestampSchema.optional(),
  })
  .strict();

export const workflowOpenQuestionSchema = z
  .object({
    id: workflowStableIdSchema,
    question: textSchema,
    detail: optionalTextSchema,
    status: z.enum(["open", "resolved", "deprecated"]),
    answer: optionalTextSchema,
    allowMultiSelect: z.boolean().optional(),
    options: z.array(workflowQuestionOptionSchema).optional(),
    recommendedOptionIds: z.array(workflowStableIdSchema).optional(),
    recommendationRationale: optionalTextSchema,
    nodeIds: z.array(workflowStableIdSchema).optional(),
    sourcePatchId: workflowStableIdSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    resolvedAt: timestampSchema.optional(),
  })
  .strict();

export const workflowRevisionSchema = z
  .object({
    revision: z.number().int().min(0),
    patchId: workflowStableIdSchema,
    reason: textSchema,
    author: optionalTextSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    operationCount: z.number().int().min(0),
  })
  .strict();

const graphPayloadSchema = z
  .object({
    id: workflowStableIdSchema,
    projectId: workflowStableIdSchema.optional(),
    title: textSchema,
    description: optionalTextSchema,
    nodes: z.array(workflowNodeSchema),
    edges: z.array(workflowEdgeSchema),
    decisions: z.array(workflowDecisionSchema).default([]),
    risks: z.array(workflowRiskSchema).default([]),
    openQuestions: z.array(workflowOpenQuestionSchema).default([]),
    layoutHints: z.array(workflowLayoutHintSchema).default([]),
    createdAt: timestampSchema.optional(),
    updatedAt: timestampSchema.optional(),
  })
  .strict();

export const workflowGraphSchema = graphPayloadSchema
  .extend({
    revision: z.number().int().min(0),
    revisions: z.array(workflowRevisionSchema),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const nodePatchSchema = z
  .object({
    kind: z.enum(WORKFLOW_NODE_KINDS).optional(),
    status: z.enum(WORKFLOW_NODE_STATUSES).optional(),
    title: optionalTextSchema,
    summary: optionalTextSchema,
    body: optionalTextSchema,
    tags: z.array(tagSchema).optional(),
    owner: optionalTextSchema,
    layoutHintId: workflowStableIdSchema.optional(),
    deprecatedAt: timestampSchema.optional(),
    deprecatedReason: optionalTextSchema,
    replacementNodeId: workflowStableIdSchema.optional(),
  })
  .strict();

const edgePatchSchema = z
  .object({
    kind: z.enum(WORKFLOW_EDGE_KINDS).optional(),
    fromNodeId: workflowStableIdSchema.optional(),
    toNodeId: workflowStableIdSchema.optional(),
    label: optionalTextSchema,
    status: z.enum(["active", "deprecated"]).optional(),
    deprecatedAt: timestampSchema.optional(),
    deprecatedReason: optionalTextSchema,
    replacementEdgeId: workflowStableIdSchema.optional(),
  })
  .strict();

const openQuestionPatchSchema = z
  .object({
    question: optionalTextSchema,
    detail: optionalTextSchema,
    status: z.enum(["open", "resolved", "deprecated"]).optional(),
    answer: optionalTextSchema,
    allowMultiSelect: z.boolean().optional(),
    options: z.array(workflowQuestionOptionSchema).optional(),
    recommendedOptionIds: z.array(workflowStableIdSchema).optional(),
    recommendationRationale: optionalTextSchema,
    nodeIds: z.array(workflowStableIdSchema).optional(),
    resolvedAt: timestampSchema.optional(),
  })
  .strict();

const workflowPatchOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create_graph"), graph: graphPayloadSchema }).strict(),
  z.object({ op: z.literal("add_node"), node: workflowNodeSchema }).strict(),
  z.object({ op: z.literal("update_node"), nodeId: workflowStableIdSchema, changes: nodePatchSchema }).strict(),
  z.object({ op: z.literal("remove_node"), nodeId: workflowStableIdSchema }).strict(),
  z.object({ op: z.literal("add_edge"), edge: workflowEdgeSchema }).strict(),
  z.object({ op: z.literal("update_edge"), edgeId: workflowStableIdSchema, changes: edgePatchSchema }).strict(),
  z.object({ op: z.literal("remove_edge"), edgeId: workflowStableIdSchema }).strict(),
  z.object({ op: z.literal("replace_decision"), decisionId: workflowStableIdSchema, decision: workflowDecisionSchema }).strict(),
  z
    .object({
      op: z.literal("mark_deprecated"),
      targetType: z.enum(["node", "edge", "decision", "risk", "open_question"]),
      targetId: workflowStableIdSchema,
      reason: textSchema,
      replacementId: workflowStableIdSchema.optional(),
    })
    .strict(),
  z.object({ op: z.literal("add_risk"), risk: workflowRiskSchema }).strict(),
  z.object({ op: z.literal("add_open_question"), question: workflowOpenQuestionSchema }).strict(),
  z.object({ op: z.literal("update_open_question"), questionId: workflowStableIdSchema, changes: openQuestionPatchSchema }).strict(),
  z.object({ op: z.literal("resolve_open_question"), questionId: workflowStableIdSchema, answer: textSchema }).strict(),
  z.object({ op: z.literal("relayout_section"), sectionId: workflowStableIdSchema, hints: z.array(workflowLayoutHintSchema) }).strict(),
]);

export const workflowPatchSchema = z
  .object({
    id: workflowStableIdSchema,
    graphId: workflowStableIdSchema.optional(),
    baseRevision: z.number().int().min(0).optional(),
    reason: textSchema,
    author: optionalTextSchema,
    createdAt: timestampSchema,
    operations: z.array(workflowPatchOperationSchema).min(1),
  })
  .strict();

export interface WorkflowValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

export function validateWorkflowGraph(value: unknown): WorkflowValidationResult<WorkflowGraph> {
  const schemaResult = workflowGraphSchema.safeParse(value);
  if (!schemaResult.success) {
    return { ok: false, errors: formatZodIssues(schemaResult.error.issues) };
  }
  return validateGraphIntegrity(schemaResult.data);
}

export function validateWorkflowPatch(value: unknown): WorkflowValidationResult<WorkflowPatch> {
  const rawShapeError = findRawExcalidrawShape(value);
  if (rawShapeError) {
    return { ok: false, errors: [rawShapeError] };
  }
  const schemaResult = workflowPatchSchema.safeParse(value);
  if (!schemaResult.success) {
    return { ok: false, errors: formatZodIssues(schemaResult.error.issues) };
  }
  const patch = schemaResult.data;
  const createsGraph = patch.operations.some((operation) => operation.op === "create_graph");
  if (!createsGraph && patch.baseRevision === undefined) {
    return { ok: false, errors: ["baseRevision is required unless the patch creates a new graph."] };
  }
  if (patch.operations.length > 1 && createsGraph) {
    return { ok: false, errors: ["create_graph must be the only operation in a workflow patch."] };
  }
  return { ok: true, value: patch, errors: [] };
}

export function validateGraphIntegrity(graph: WorkflowGraph): WorkflowValidationResult<WorkflowGraph> {
  const errors: string[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const decisionIds = new Set<string>();
  const riskIds = new Set<string>();
  const questionIds = new Set<string>();
  const layoutHintIds = new Set<string>();

  collectDuplicateIds("node", graph.nodes, nodeIds, errors);
  collectDuplicateIds("edge", graph.edges, edgeIds, errors);
  collectDuplicateIds("decision", graph.decisions, decisionIds, errors);
  collectDuplicateIds("risk", graph.risks, riskIds, errors);
  collectDuplicateIds("open question", graph.openQuestions, questionIds, errors);
  collectDuplicateIds("layout hint", graph.layoutHints, layoutHintIds, errors);

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.fromNodeId)) {
      errors.push(`edge ${edge.id} points from missing node ${edge.fromNodeId}.`);
    }
    if (!nodeIds.has(edge.toNodeId)) {
      errors.push(`edge ${edge.id} points to missing node ${edge.toNodeId}.`);
    }
    if (edge.replacementEdgeId && !edgeIds.has(edge.replacementEdgeId)) {
      errors.push(`edge ${edge.id} replacementEdgeId references missing edge ${edge.replacementEdgeId}.`);
    }
  }

  for (const node of graph.nodes) {
    if (node.replacementNodeId && !nodeIds.has(node.replacementNodeId)) {
      errors.push(`node ${node.id} replacementNodeId references missing node ${node.replacementNodeId}.`);
    }
    if (node.layoutHintId && !layoutHintIds.has(node.layoutHintId)) {
      errors.push(`node ${node.id} layoutHintId references missing layout hint ${node.layoutHintId}.`);
    }
  }

  for (const decision of graph.decisions) {
    if (decision.nodeId && !nodeIds.has(decision.nodeId)) {
      errors.push(`decision ${decision.id} references missing node ${decision.nodeId}.`);
    }
    if (decision.supersedesDecisionId && !decisionIds.has(decision.supersedesDecisionId)) {
      errors.push(`decision ${decision.id} supersedes missing decision ${decision.supersedesDecisionId}.`);
    }
  }

  for (const risk of graph.risks) {
    for (const nodeId of risk.nodeIds ?? []) {
      if (!nodeIds.has(nodeId)) {
        errors.push(`risk ${risk.id} references missing node ${nodeId}.`);
      }
    }
  }

  for (const question of graph.openQuestions) {
    for (const nodeId of question.nodeIds ?? []) {
      if (!nodeIds.has(nodeId)) {
        errors.push(`open question ${question.id} references missing node ${nodeId}.`);
      }
    }
    const optionIds = new Set<string>();
    collectDuplicateIds(`open question ${question.id} option`, question.options ?? [], optionIds, errors);
    for (const recommendedOptionId of question.recommendedOptionIds ?? []) {
      if (!optionIds.has(recommendedOptionId)) {
        errors.push(`open question ${question.id} recommends missing option ${recommendedOptionId}.`);
      }
    }
  }

  for (const hint of graph.layoutHints) {
    if (!nodeIds.has(hint.nodeId)) {
      errors.push(`layout hint ${hint.id} references missing node ${hint.nodeId}.`);
    }
    if (hint.parentNodeId && !nodeIds.has(hint.parentNodeId)) {
      errors.push(`layout hint ${hint.id} references missing parent node ${hint.parentNodeId}.`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: graph, errors: [] };
}

export function workflowValidationErrors(value: WorkflowValidationResult<unknown>): string {
  return value.errors.join("; ");
}

function collectDuplicateIds(label: string, values: Array<{ id: string }>, seen: Set<string>, errors: string[]): void {
  for (const value of values) {
    if (seen.has(value.id)) {
      errors.push(`duplicate ${label} id ${value.id}.`);
    }
    seen.add(value.id);
  }
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => `${issue.path.join(".") || "workflow"}: ${issue.message}`);
}

function findRawExcalidrawShape(value: unknown): string | null {
  const stack: Array<{ path: string; value: unknown }> = [{ path: "patch", value }];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const { path, value: node } = current;
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      node.forEach((item, index) => stack.push({ path: `${path}.${index}`, value: item }));
      continue;
    }

    const record = node as Record<string, unknown>;
    if ("elements" in record || "appState" in record || "files" in record) {
      return `${path} contains raw Excalidraw scene fields. WorkflowPatch must describe semantic workflow changes only.`;
    }

    if (
      typeof record.type === "string" &&
      ["rectangle", "ellipse", "diamond", "arrow", "line", "text", "freedraw", "image"].includes(record.type) &&
      ["x", "y", "width", "height"].some((key) => typeof record[key] === "number")
    ) {
      return `${path} looks like a raw Excalidraw element. WorkflowPatch operations must use semantic nodes, edges, decisions, risks, and questions.`;
    }

    for (const [key, child] of Object.entries(record)) {
      stack.push({ path: `${path}.${key}`, value: child });
    }
  }
  return null;
}
