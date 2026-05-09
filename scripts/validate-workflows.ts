import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppDatabase } from "../src/db.js";
import {
  WorkflowGraphRepo,
  WorkflowService,
  applyWorkflowPatch,
  validateWorkflowPatch,
  type WorkflowGraph,
  type WorkflowPatch,
} from "../src/workflows/index.js";

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

const tmp = mkdtempSync(path.join(tmpdir(), "arc-workflow-validation-"));
try {
  const database = new AppDatabase(path.join(tmp, "arc.sqlite"));
  try {
    database.db
      .prepare(
        `
        INSERT INTO projects (
          guild_id,
          channel_id,
          project_channel_id,
          project_channel_name,
          project_name,
          project_slug,
          repo_path,
          worktrees_path
        )
        VALUES ('guild-1', 'channel-1', 'channel-1', 'Workflow Validation', 'Workflow Validation', 'workflow-validation', @repoPath, @worktreesPath)
      `,
      )
      .run({ repoPath: path.join(tmp, "repo"), worktreesPath: path.join(tmp, "worktrees") });
    const projectId = Number(database.db.prepare("SELECT id FROM projects LIMIT 1").pluck().get());
    const orchestrationResult = database.db
      .prepare(
        `
        INSERT INTO orchestrations (project_id, author_user_id, status, goal)
        VALUES (?, 'validator', 'PLANNING', 'Persist workflow graph state')
      `,
      )
      .run(projectId);
    const orchestrationId = Number(orchestrationResult.lastInsertRowid);

    const repo = new WorkflowGraphRepo(database.db);
    const service = new WorkflowService(repo);
    const persisted = service.getOrCreateForOrchestration(projectId, orchestrationId, "Persist workflow graph state");
    assert.equal(persisted.revision, 0);
    assert.equal(persisted.graph.nodes.length, 1);

    const servicePatch: WorkflowPatch = {
      id: "patch-add-service-node",
      graphId: persisted.graph.id,
      baseRevision: 0,
      reason: "Add service layer node.",
      author: "planner",
      createdAt: "2026-05-09T12:20:00.000Z",
      operations: [
        {
          op: "add_node",
          node: {
            id: "component-workflow-service",
            kind: "backend_component",
            status: "active",
            title: "WorkflowService",
            createdAt: "2026-05-09T12:20:00.000Z",
            updatedAt: "2026-05-09T12:20:00.000Z",
          },
        },
      ],
    };
    const saved = service.applyPlannerPatch(projectId, orchestrationId, servicePatch);
    assert.equal(saved.revision, 1);
    assert.equal(service.listGraphHistory(saved.id).length, 1);
    assert.throws(() => service.applyPlannerPatch(projectId, orchestrationId, servicePatch), /stale|baseRevision/i);
  } finally {
    database.close();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("Workflow domain and persistence validation passed.");
