import type {
  WorkflowDecision,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowOpenQuestion,
  WorkflowPatch,
  WorkflowPatchOperation,
  WorkflowPatchTargetType,
  WorkflowRisk,
  WorkflowRevision,
} from "./types.js";
import { validateWorkflowGraph, validateWorkflowPatch } from "./validation.js";

export type WorkflowPatchErrorCode =
  | "invalid_graph"
  | "invalid_patch"
  | "stale_patch"
  | "missing_graph"
  | "graph_exists"
  | "graph_mismatch"
  | "operation_failed";

export class WorkflowPatchError extends Error {
  constructor(
    public readonly code: WorkflowPatchErrorCode,
    message: string,
    public readonly details: string[] = [],
  ) {
    super(details.length ? `${message}: ${details.join("; ")}` : message);
    this.name = "WorkflowPatchError";
  }
}

export function applyWorkflowPatch(graph: WorkflowGraph | null, rawPatch: WorkflowPatch): WorkflowGraph {
  const patchResult = validateWorkflowPatch(rawPatch);
  if (!patchResult.ok || !patchResult.value) {
    throw new WorkflowPatchError("invalid_patch", "Workflow patch is invalid", patchResult.errors);
  }
  const patch = patchResult.value;
  const createOperation = patch.operations.find((operation) => operation.op === "create_graph");

  if (createOperation?.op === "create_graph") {
    if (graph) {
      throw new WorkflowPatchError("graph_exists", "create_graph cannot replace an existing workflow graph", [`graph ${graph.id} already exists.`]);
    }
    const created = materializeCreatedGraph(createOperation.graph, patch);
    assertValidGraph(created);
    return created;
  }

  if (!graph) {
    throw new WorkflowPatchError("missing_graph", "Workflow patch requires an existing graph");
  }

  const graphResult = validateWorkflowGraph(graph);
  if (!graphResult.ok) {
    throw new WorkflowPatchError("invalid_graph", "Existing workflow graph is invalid", graphResult.errors);
  }

  if (patch.graphId && patch.graphId !== graph.id) {
    throw new WorkflowPatchError("graph_mismatch", "Workflow patch targets a different graph", [`patch graphId ${patch.graphId} does not match graph ${graph.id}.`]);
  }
  if (patch.baseRevision !== graph.revision) {
    throw new WorkflowPatchError("stale_patch", "Workflow patch baseRevision is stale", [
      `patch ${patch.id} targets baseRevision ${patch.baseRevision ?? "missing"}, but graph ${graph.id} is currently at revision ${graph.revision}. Fetch the latest workflow snapshot and regenerate the patch against that revision.`,
    ]);
  }

  let next = cloneGraph(graph);
  for (const operation of patch.operations) {
    next = applyOperation(next, operation, patch);
  }

  next = {
    ...next,
    revision: graph.revision + 1,
    updatedAt: patch.createdAt,
    revisions: [
      ...next.revisions,
      {
        revision: graph.revision + 1,
        patchId: patch.id,
        reason: patch.reason,
        author: patch.author,
        createdAt: patch.createdAt,
        updatedAt: patch.createdAt,
        operationCount: patch.operations.length,
      },
    ],
  };

  assertValidGraph(next);
  return next;
}

type WorkflowCreateGraphOperation = Extract<WorkflowPatchOperation, { op: "create_graph" }>;

function materializeCreatedGraph(operationGraph: WorkflowCreateGraphOperation["graph"], patch: WorkflowPatch): WorkflowGraph {
  const createdAt = operationGraph.createdAt ?? patch.createdAt;
  const updatedAt = operationGraph.updatedAt ?? patch.createdAt;
  const revision: WorkflowRevision = {
    revision: 1,
    patchId: patch.id,
    reason: patch.reason,
    author: patch.author,
    createdAt: patch.createdAt,
    updatedAt: patch.createdAt,
    operationCount: patch.operations.length,
  };
  return {
    ...operationGraph,
    decisions: operationGraph.decisions ?? [],
    risks: operationGraph.risks ?? [],
    openQuestions: operationGraph.openQuestions ?? [],
    layoutHints: operationGraph.layoutHints ?? [],
    revision: 1,
    revisions: [revision],
    createdAt,
    updatedAt,
  };
}

function applyOperation(graph: WorkflowGraph, operation: WorkflowPatchOperation, patch: WorkflowPatch): WorkflowGraph {
  switch (operation.op) {
    case "add_node":
      assertMissingId("node", graph.nodes, operation.node.id);
      return { ...graph, nodes: [...graph.nodes, stampNode(operation.node, patch)] };

    case "update_node":
      return replaceNode(graph, operation.nodeId, (node) => ({ ...node, ...operation.changes, updatedAt: patch.createdAt }));

    case "remove_node":
      assertExistingId("node", graph.nodes, operation.nodeId);
      return {
        ...graph,
        nodes: graph.nodes.filter((node) => node.id !== operation.nodeId),
        edges: graph.edges.filter((edge) => edge.fromNodeId !== operation.nodeId && edge.toNodeId !== operation.nodeId),
        decisions: graph.decisions.filter((decision) => decision.nodeId !== operation.nodeId),
        risks: graph.risks.map((risk) => ({ ...risk, nodeIds: risk.nodeIds?.filter((nodeId) => nodeId !== operation.nodeId) })),
        openQuestions: graph.openQuestions.map((question) => ({ ...question, nodeIds: question.nodeIds?.filter((nodeId) => nodeId !== operation.nodeId) })),
        layoutHints: graph.layoutHints.filter((hint) => hint.nodeId !== operation.nodeId && hint.parentNodeId !== operation.nodeId),
      };

    case "add_edge":
      assertMissingId("edge", graph.edges, operation.edge.id);
      assertNodeExists(graph, operation.edge.fromNodeId, `edge ${operation.edge.id} fromNodeId`);
      assertNodeExists(graph, operation.edge.toNodeId, `edge ${operation.edge.id} toNodeId`);
      return { ...graph, edges: [...graph.edges, stampEdge(operation.edge, patch)] };

    case "update_edge":
      return replaceEdge(graph, operation.edgeId, (edge) => {
        const next = { ...edge, ...operation.changes, updatedAt: patch.createdAt };
        assertNodeExists(graph, next.fromNodeId, `edge ${operation.edgeId} fromNodeId`);
        assertNodeExists(graph, next.toNodeId, `edge ${operation.edgeId} toNodeId`);
        return next;
      });

    case "remove_edge":
      assertExistingId("edge", graph.edges, operation.edgeId);
      return { ...graph, edges: graph.edges.filter((edge) => edge.id !== operation.edgeId) };

    case "replace_decision": {
      if (operation.decision.id !== operation.decisionId) {
        throw new WorkflowPatchError("operation_failed", "replace_decision id mismatch", [
          `decisionId ${operation.decisionId} does not match decision.id ${operation.decision.id}.`,
        ]);
      }
      if (operation.decision.nodeId) {
        assertNodeExists(graph, operation.decision.nodeId, `decision ${operation.decision.id} nodeId`);
      }
      const existing = graph.decisions.some((decision) => decision.id === operation.decisionId);
      const decision = stampDecision(operation.decision, patch);
      return {
        ...graph,
        decisions: existing
          ? graph.decisions.map((current) => (current.id === operation.decisionId ? decision : current))
          : [...graph.decisions, decision],
      };
    }

    case "mark_deprecated":
      return markDeprecated(graph, operation.targetType, operation.targetId, operation.reason, operation.replacementId, patch.createdAt);

    case "add_risk":
      assertMissingId("risk", graph.risks, operation.risk.id);
      for (const nodeId of operation.risk.nodeIds ?? []) {
        assertNodeExists(graph, nodeId, `risk ${operation.risk.id} nodeIds`);
      }
      return { ...graph, risks: [...graph.risks, stampRisk(operation.risk, patch)] };

    case "add_open_question":
      assertMissingId("open question", graph.openQuestions, operation.question.id);
      for (const nodeId of operation.question.nodeIds ?? []) {
        assertNodeExists(graph, nodeId, `open question ${operation.question.id} nodeIds`);
      }
      return { ...graph, openQuestions: [...graph.openQuestions, stampOpenQuestion(operation.question, patch)] };

    case "resolve_open_question":
      return replaceOpenQuestion(graph, operation.questionId, (question) => ({
        ...question,
        status: "resolved",
        answer: operation.answer,
        resolvedAt: patch.createdAt,
        updatedAt: patch.createdAt,
      }));

    case "relayout_section": {
      for (const hint of operation.hints) {
        assertNodeExists(graph, hint.nodeId, `layout hint ${hint.id} nodeId`);
        if (hint.parentNodeId) {
          assertNodeExists(graph, hint.parentNodeId, `layout hint ${hint.id} parentNodeId`);
        }
      }
      const replacementIds = new Set(operation.hints.map((hint) => hint.id));
      return {
        ...graph,
        layoutHints: [...graph.layoutHints.filter((hint) => hint.sectionId !== operation.sectionId && !replacementIds.has(hint.id)), ...operation.hints],
      };
    }

    case "create_graph":
      throw new WorkflowPatchError("operation_failed", "create_graph must be applied before other operations");
  }
}

function markDeprecated(
  graph: WorkflowGraph,
  targetType: WorkflowPatchTargetType,
  targetId: string,
  reason: string,
  replacementId: string | undefined,
  updatedAt: string,
): WorkflowGraph {
  switch (targetType) {
    case "node":
      return replaceNode(graph, targetId, (node) => ({
        ...node,
        status: "deprecated",
        deprecatedAt: updatedAt,
        deprecatedReason: reason,
        replacementNodeId: replacementId,
        updatedAt,
      }));
    case "edge":
      return replaceEdge(graph, targetId, (edge) => ({
        ...edge,
        status: "deprecated",
        deprecatedAt: updatedAt,
        deprecatedReason: reason,
        replacementEdgeId: replacementId,
        updatedAt,
      }));
    case "decision":
      return replaceDecision(graph, targetId, (decision) => ({ ...decision, status: "deprecated", updatedAt }));
    case "risk":
      return replaceRisk(graph, targetId, (risk) => ({ ...risk, status: "deprecated", updatedAt }));
    case "open_question":
      return replaceOpenQuestion(graph, targetId, (question) => ({ ...question, status: "deprecated", updatedAt }));
  }
}

function replaceNode(graph: WorkflowGraph, id: string, update: (value: WorkflowNode) => WorkflowNode): WorkflowGraph {
  assertExistingId("node", graph.nodes, id);
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === id ? update(node) : node)) };
}

function replaceEdge(graph: WorkflowGraph, id: string, update: (value: WorkflowEdge) => WorkflowEdge): WorkflowGraph {
  assertExistingId("edge", graph.edges, id);
  return { ...graph, edges: graph.edges.map((edge) => (edge.id === id ? update(edge) : edge)) };
}

function replaceDecision(graph: WorkflowGraph, id: string, update: (value: WorkflowDecision) => WorkflowDecision): WorkflowGraph {
  assertExistingId("decision", graph.decisions, id);
  return { ...graph, decisions: graph.decisions.map((decision) => (decision.id === id ? update(decision) : decision)) };
}

function replaceRisk(graph: WorkflowGraph, id: string, update: (value: WorkflowRisk) => WorkflowRisk): WorkflowGraph {
  assertExistingId("risk", graph.risks, id);
  return { ...graph, risks: graph.risks.map((risk) => (risk.id === id ? update(risk) : risk)) };
}

function replaceOpenQuestion(graph: WorkflowGraph, id: string, update: (value: WorkflowOpenQuestion) => WorkflowOpenQuestion): WorkflowGraph {
  assertExistingId("open question", graph.openQuestions, id);
  return { ...graph, openQuestions: graph.openQuestions.map((question) => (question.id === id ? update(question) : question)) };
}

function stampNode(node: WorkflowNode, patch: WorkflowPatch): WorkflowNode {
  return { ...node, sourcePatchId: node.sourcePatchId ?? patch.id, updatedAt: patch.createdAt };
}

function stampEdge(edge: WorkflowEdge, patch: WorkflowPatch): WorkflowEdge {
  return { ...edge, sourcePatchId: edge.sourcePatchId ?? patch.id, updatedAt: patch.createdAt };
}

function stampDecision(decision: WorkflowDecision, patch: WorkflowPatch): WorkflowDecision {
  return { ...decision, sourcePatchId: decision.sourcePatchId ?? patch.id, updatedAt: patch.createdAt };
}

function stampRisk(risk: WorkflowRisk, patch: WorkflowPatch): WorkflowRisk {
  return { ...risk, sourcePatchId: risk.sourcePatchId ?? patch.id, updatedAt: patch.createdAt };
}

function stampOpenQuestion(question: WorkflowOpenQuestion, patch: WorkflowPatch): WorkflowOpenQuestion {
  return { ...question, sourcePatchId: question.sourcePatchId ?? patch.id, updatedAt: patch.createdAt };
}

function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, tags: node.tags ? [...node.tags] : undefined })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    decisions: graph.decisions.map((decision) => ({ ...decision })),
    risks: graph.risks.map((risk) => ({ ...risk, nodeIds: risk.nodeIds ? [...risk.nodeIds] : undefined })),
    openQuestions: graph.openQuestions.map((question) => ({ ...question, nodeIds: question.nodeIds ? [...question.nodeIds] : undefined })),
    layoutHints: graph.layoutHints.map((hint) => ({ ...hint })),
    revisions: graph.revisions.map((revision) => ({ ...revision })),
  };
}

function assertValidGraph(graph: WorkflowGraph): void {
  const result = validateWorkflowGraph(graph);
  if (!result.ok) {
    throw new WorkflowPatchError("operation_failed", "Workflow patch produced an invalid graph", result.errors);
  }
}

function assertMissingId(label: string, values: Array<{ id: string }>, id: string): void {
  if (values.some((value) => value.id === id)) {
    throw new WorkflowPatchError("operation_failed", `Cannot add duplicate ${label}`, [`${label} id ${id} already exists.`]);
  }
}

function assertExistingId(label: string, values: Array<{ id: string }>, id: string): void {
  if (!values.some((value) => value.id === id)) {
    throw new WorkflowPatchError("operation_failed", `Cannot update missing ${label}`, [`${label} id ${id} does not exist.`]);
  }
}

function assertNodeExists(graph: WorkflowGraph, nodeId: string, context: string): void {
  if (!graph.nodes.some((node) => node.id === nodeId)) {
    throw new WorkflowPatchError("operation_failed", "Workflow patch references a missing node", [`${context} references missing node ${nodeId}.`]);
  }
}
