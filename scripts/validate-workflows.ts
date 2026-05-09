import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/db.js";
import { ExcalidrawApiServer } from "../src/excalidraw/ExcalidrawApiServer.js";
import { ExcalidrawCardsRepo } from "../src/excalidraw/ExcalidrawCardsRepo.js";
import { OrchestrationAgentsRepo } from "../src/orchestrations/repos/OrchestrationAgentsRepo.js";
import { OrchestrationMessagesRepo } from "../src/orchestrations/repos/OrchestrationMessagesRepo.js";
import { OrchestrationsRepo } from "../src/orchestrations/repos/OrchestrationsRepo.js";
import { ProjectStore, TaskStore } from "../src/stores.js";
import {
  WorkflowGraphRepo,
  WorkflowEventBus,
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

async function runPersistenceAndApiValidation(): Promise<void> {
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
    const events = new WorkflowEventBus();
    const received: string[] = [];
    const unsubscribe = events.subscribe(projectId, (event) => received.push(event.type));
    const persisted = service.getOrCreateForOrchestration(projectId, orchestrationId, "Persist workflow graph state");
    events.graphCreated(persisted);
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
    const lastPatch = service.listGraphHistory(saved.id).at(-1);
    assert.ok(lastPatch);
    events.patchApplied(saved, lastPatch);
    assert.equal(saved.revision, 1);
    assert.equal(service.listGraphHistory(saved.id).length, 1);
    assert.throws(() => {
      try {
        service.applyPlannerPatch(projectId, orchestrationId, servicePatch);
      } catch (error) {
        events.patchRejected({
          projectId,
          orchestrationId,
          graphId: saved.id,
          patch: servicePatch,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }, /stale|baseRevision/i);
    unsubscribe();
    assert.deepEqual(received, ["workflow.graph_created", "workflow.patch_applied", "workflow.patch_rejected"]);

    const projectStore = new ProjectStore(database.db, path.join(tmp, "workspaces"));
    const taskStore = new TaskStore(database.db);
    const cards = new ExcalidrawCardsRepo(database.db);
    const orchestrations = new OrchestrationsRepo(database.db);
    const orchestrationAgents = new OrchestrationAgentsRepo(database.db);
    const orchestrationMessages = new OrchestrationMessagesRepo(database.db);
    const apiOrchestration = orchestrations.create({
      projectId,
      authorUserId: "validator",
      goal: "Validate workflow HTTP routes",
    });
    const port = 19000 + Math.floor(Math.random() * 1000);
    const server = new ExcalidrawApiServer({
      config: validationConfig(tmp, port),
      projects: projectStore,
      tasks: taskStore,
      implementService: {
        syncProjectOrigin: async <T>(project: T) => project,
      } as never,
      cards,
      orchestrations,
      orchestrationAgents,
      orchestrationMessages,
      workflows: service,
      workflowEvents: events,
    });
    server.listen();
    await delay(80);
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      const created = await fetchJson<{ workflow: { id: number; graph: WorkflowGraph } }>(
        `${baseUrl}/api/workflows/orchestration/${apiOrchestration.id}`,
      );
      assert.equal(created.workflow.graph.revision, 0);

      const stream = await fetch(`${baseUrl}/api/workflows/events?projectId=${projectId}`);
      assert.equal(stream.status, 200);
      assert.ok(stream.body);
      const reader = stream.body.getReader();
      const apiPatch: WorkflowPatch = {
        id: "patch-api-add-node",
        graphId: created.workflow.graph.id,
        baseRevision: 0,
        reason: "Validate workflow API patch route.",
        author: "planner",
        createdAt: "2026-05-09T12:40:00.000Z",
        operations: [
          {
            op: "add_node",
            node: {
              id: "component-api-route",
              kind: "backend_component",
              status: "active",
              title: "Workflow API route",
              createdAt: "2026-05-09T12:40:00.000Z",
              updatedAt: "2026-05-09T12:40:00.000Z",
            },
          },
        ],
      };
      const patched = await fetchJson<{ workflow: { revision: number }; patch: { resultingRevision: number } }>(
        `${baseUrl}/api/workflows/orchestration/${apiOrchestration.id}/patch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patch: apiPatch }),
        },
      );
      assert.equal(patched.workflow.revision, 1);
      assert.equal(patched.patch.resultingRevision, 1);
      assert.match(await readStreamUntil(reader, "workflow.patch_applied"), /workflow\.patch_applied/);
      await reader.cancel();

      const history = await fetchJson<{ patches: Array<{ resultingRevision: number }> }>(
        `${baseUrl}/api/workflows/${created.workflow.id}/history`,
      );
      assert.equal(history.patches.length, 1);
      assert.equal(history.patches[0].resultingRevision, 1);
    } finally {
      await server.close().catch(() => undefined);
    }
  } finally {
    database.close();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
}

await runPersistenceAndApiValidation();

console.log("Workflow domain, persistence, API, and event stream validation passed.");

function validationConfig(tmp: string, port: number): AppConfig {
  return {
    discordToken: null,
    discordClientId: null,
    discordGuildId: null,
    databasePath: path.join(tmp, "arc.sqlite"),
    workspacesDir: path.join(tmp, "workspaces"),
    codexBin: "codex",
    enableMessageContentIntent: false,
    githubPrEnabled: false,
    githubPrFeedbackEnabled: false,
    githubPrFeedbackPollMs: 60000,
    githubBaseBranch: "main",
    githubRemote: "origin",
    excalidrawHost: "127.0.0.1",
    excalidrawPort: port,
    excalidrawCorsOrigin: "*",
    excalidrawWorkspacesDir: path.join(tmp, "excalidraw-workspaces"),
    excalidrawProjectGuildId: "guild-1",
    excalidrawProjectChannelId: "channel-1",
    excalidrawProjectName: "Workflow Validation",
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return body as T;
}

async function readStreamUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 3000;
  while (!buffer.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${needle}. Received: ${buffer}`);
    }
    const result = await Promise.race([
      reader.read(),
      delay(remaining).then(() => ({ done: true as const, value: undefined })),
    ]);
    if (result.done) {
      break;
    }
    buffer += decoder.decode(result.value, { stream: true });
  }
  return buffer;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
