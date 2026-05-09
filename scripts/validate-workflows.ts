import assert from "node:assert/strict";
import { applyWorkflowPatch, validateWorkflowPatch, type WorkflowGraph, type WorkflowPatch } from "../src/workflows/index.js";

const t0 = "2026-05-09T12:00:00.000Z";
const createPatch: WorkflowPatch = {
  id: "patch-create-workflow",
  reason: "Create initial live canvas workflow graph.",
  author: "validation-script",
  createdAt: t0,
  operations: [
    {
      op: "create_graph",
      graph: {
        id: "workflow-live-canvas-v1",
        projectId: "project-arc",
        title: "Live workflow canvas v1",
        nodes: [
          {
            id: "goal-live-canvas",
            kind: "goal",
            status: "active",
            title: "Ship live workflow canvas v1",
            createdAt: t0,
            updatedAt: t0,
          },
          {
            id: "component-peer-discovery",
            kind: "backend_component",
            status: "active",
            title: "Peer discovery",
            createdAt: t0,
            updatedAt: t0,
          },
        ],
        edges: [
          {
            id: "edge-peer-discovery-goal",
            kind: "implements",
            fromNodeId: "component-peer-discovery",
            toNodeId: "goal-live-canvas",
            createdAt: t0,
            updatedAt: t0,
          },
        ],
        decisions: [],
        risks: [],
        openQuestions: [],
        layoutHints: [],
      },
    },
  ],
};

const graph = applyWorkflowPatch(null, createPatch);
assert.equal(graph.revision, 1);
assert.equal(graph.nodes.length, 2);

const t1 = "2026-05-09T12:10:00.000Z";
const replaceP2pPatch: WorkflowPatch = {
  id: "patch-replace-p2p-with-https",
  graphId: "workflow-live-canvas-v1",
  baseRevision: 1,
  reason: "Replace P2P multiplayer with HTTPS.",
  author: "validation-script",
  createdAt: t1,
  operations: [
    {
      op: "mark_deprecated",
      targetType: "node",
      targetId: "component-peer-discovery",
      reason: "HTTPS removes peer discovery from v1.",
      replacementId: "component-https-api",
    },
    {
      op: "add_node",
      node: {
        id: "component-https-api",
        kind: "backend_component",
        status: "active",
        title: "HTTPS API server",
        createdAt: t1,
        updatedAt: t1,
      },
    },
    {
      op: "add_edge",
      edge: {
        id: "edge-https-api-goal",
        kind: "implements",
        fromNodeId: "component-https-api",
        toNodeId: "goal-live-canvas",
        createdAt: t1,
        updatedAt: t1,
      },
    },
  ],
};

const updated = applyWorkflowPatch(graph, replaceP2pPatch);
assert.equal(updated.revision, 2);
assert.equal(graph.revision, 1, "applyWorkflowPatch should not mutate the input graph");
assert.equal(updated.nodes.find((node) => node.id === "component-peer-discovery")?.status, "deprecated");
assert.ok(updated.nodes.some((node) => node.id === "component-https-api"));

const rawExcalidrawPatch = {
  id: "patch-raw-excalidraw",
  graphId: "workflow-live-canvas-v1",
  baseRevision: 2,
  reason: "This should be rejected.",
  createdAt: t1,
  operations: [],
  elements: [{ id: "shape-1", type: "rectangle", x: 10, y: 10, width: 200, height: 120 }],
};
assert.equal(validateWorkflowPatch(rawExcalidrawPatch).ok, false);

const stalePatch: WorkflowPatch = { ...replaceP2pPatch, id: "patch-stale", baseRevision: 1 };
assert.throws(() => applyWorkflowPatch(updated as WorkflowGraph, stalePatch), /baseRevision 1 does not match graph revision 2/);

console.log("Workflow domain validation passed.");
