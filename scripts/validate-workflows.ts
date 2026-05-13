import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { CanvasPromptRepo } from "../src/canvas-prompts/CanvasPromptRepo.js";
import { AppDatabase } from "../src/db.js";
import { ExcalidrawApiServer } from "../src/excalidraw/ExcalidrawApiServer.js";
import { ExcalidrawCardsRepo } from "../src/excalidraw/ExcalidrawCardsRepo.js";
import { OrchestrationAgentsRepo } from "../src/orchestrations/repos/OrchestrationAgentsRepo.js";
import { OrchestrationMessagesRepo } from "../src/orchestrations/repos/OrchestrationMessagesRepo.js";
import { OrchestrationSafetyRepo } from "../src/orchestrations/repos/OrchestrationSafetyRepo.js";
import { OrchestrationsRepo } from "../src/orchestrations/repos/OrchestrationsRepo.js";
import { ProjectStore, TaskStore } from "../src/stores.js";
import {
  WorkflowGraphRepo,
  WorkflowEventBus,
  WorkflowService,
  applyWorkflowPatch,
  parsePlannerWorkflowPatch,
  validateWorkflowPatch,
  type WorkflowGraph,
  type WorkflowPatch,
} from "../src/workflows/index.js";
import { workflowNodeElementId } from "../web/src/workflows/workflowIds.ts";

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
assert.equal(
  parsePlannerWorkflowPatch("Planner text\n```ARC_WORKFLOW_PATCH_JSON\n{\"id\":\n```").status,
  "rejected",
  "malformed planner patch blocks should be rejected without throwing",
);
assert.equal(workflowNodeElementId("workflow-live-canvas-v1", "goal-live-canvas"), "arc-workflow-workflow-live-canvas-v1-node-goal-live-canvas");
const latestPatchParse = parsePlannerWorkflowPatch(`First block
\`\`\`ARC_WORKFLOW_PATCH_JSON
${JSON.stringify({ ...replaceP2pPatch, id: "patch-old-block" })}
\`\`\`
Second block
\`\`\`ARC_WORKFLOW_PATCH_JSON
${JSON.stringify({ ...replaceP2pPatch, id: "patch-newest-block" })}
\`\`\``);
assert.equal(latestPatchParse.status, "valid");
assert.equal(latestPatchParse.status === "valid" ? latestPatchParse.patch.id : null, "patch-newest-block");
const simplifiedPatchParse = parsePlannerWorkflowPatch(
  `Planner text
\`\`\`ARC_WORKFLOW_PATCH_JSON
${JSON.stringify({
  operations: [
    { op: "add_node", node: { id: "component-normalized-node", type: "backend_component", label: "Normalized node" } },
    { op: "add_edge", edge: { type: "depends_on", from: "component-normalized-node", to: "goal-live-canvas" } },
  ],
})}
\`\`\``,
  { graph: { id: "workflow-live-canvas-v1", revision: 1 }, author: "validation-script", now: t1 },
);
assert.equal(simplifiedPatchParse.status, "valid");
if (simplifiedPatchParse.status === "valid") {
  assert.equal(simplifiedPatchParse.patch.graphId, "workflow-live-canvas-v1");
  assert.equal(simplifiedPatchParse.patch.baseRevision, 1);
  const addNode = simplifiedPatchParse.patch.operations[0];
  const addEdge = simplifiedPatchParse.patch.operations[1];
  assert.equal(addNode.op === "add_node" ? addNode.node.kind : null, "backend_component");
  assert.equal(addNode.op === "add_node" ? addNode.node.title : null, "Normalized node");
  assert.equal(addEdge.op === "add_edge" ? addEdge.edge.fromNodeId : null, "component-normalized-node");
}
const aliasPatchParse = parsePlannerWorkflowPatch(
  `Planner text
\`\`\`ARC_WORKFLOW_PATCH_JSON
${JSON.stringify({
  operations: [
    { op: "add_node", node: { id: "ui-card", kind: "frontend", status: "waiting_user", title: "Question card" } },
    { op: "add_node", node: { id: "unknown-planner-item", kind: "implementation_step", status: "done", title: "Finish worker task" } },
    { op: "add_edge", edge: { kind: "requires", from: "ui-card", to: "unknown-planner-item" } },
  ],
})}
\`\`\``,
  { graph: { id: "workflow-live-canvas-v1", revision: 1 }, author: "validation-script", now: t1 },
);
assert.equal(aliasPatchParse.status, "valid");
if (aliasPatchParse.status === "valid") {
  const uiNode = aliasPatchParse.patch.operations[0];
  const taskNode = aliasPatchParse.patch.operations[1];
  const dependencyEdge = aliasPatchParse.patch.operations[2];
  assert.equal(uiNode.op === "add_node" ? uiNode.node.kind : null, "frontend_component");
  assert.equal(uiNode.op === "add_node" ? uiNode.node.status : null, "blocked");
  assert.equal(taskNode.op === "add_node" ? taskNode.node.kind : null, "agent_task");
  assert.equal(taskNode.op === "add_node" ? taskNode.node.status : null, "complete");
  assert.equal(dependencyEdge.op === "add_edge" ? dependencyEdge.edge.kind : null, "depends_on");
}
const proseOnlyQuestions = parsePlannerWorkflowPatch(sixQuestionPlannerResponse());
assert.equal(proseOnlyQuestions.status, "none", "planner prose questions should not be locally extracted into workflow state");
const structuredQuestions = parsePlannerWorkflowPatch(
  sixQuestionPlannerResponse({ includePatch: true, graphId: "workflow-live-canvas-v1", revision: 1, orchestrationId: 42 }),
  { graph: { id: "workflow-live-canvas-v1", revision: 1 }, author: "validation-script", now: t1 },
);
assert.equal(structuredQuestions.status, "valid");
if (structuredQuestions.status === "valid") {
  const openQuestions = structuredQuestions.patch.operations.filter((operation) => operation.op === "add_open_question");
  assert.equal(openQuestions.length, 6);
  assert.equal(openQuestions[0].question.question, "Client platform?");
  assert.equal(openQuestions[0].question.options?.length, 3);
  assert.equal(openQuestions[1].question.options?.[2]?.label, "Server authoritative");
}
const plannerMalformedQuestionPatch = parsePlannerWorkflowPatch(
  `Planner text
\`\`\`ARC_WORKFLOW_PATCH_JSON
${JSON.stringify({
  id: "patch-workflow-project-32-orchestration-5-rev-0-001",
  graphId: "workflow-project-32-orchestration-5",
  baseRevision: 0,
  reason: "Initialize semantic workflow graph with malformed question operations.",
  author: "planner",
  createdAt: "2026-05-12T04:09:30.000Z",
  operations: [
    {
      op: "add_node",
      node: {
        id: "goal-mini-games-python",
        kind: "goal",
        status: "active",
        title: "Build Python mini-games suite",
        createdAt: "2026-05-12T04:09:30.000Z",
        updatedAt: "2026-05-12T04:09:30.000Z",
      },
    },
    {
      op: "add_node",
      node: {
        id: "scope-racing-simulator",
        kind: "game_module",
        status: "active",
        title: "Racing simulator module",
        createdAt: "2026-05-12T04:09:30.000Z",
        updatedAt: "2026-05-12T04:09:30.000Z",
      },
    },
    { op: "add_edge", edge: { kind: "decomposes_into", fromNodeId: "goal-mini-games-python", toNodeId: "scope-racing-simulator" } },
    {
      op: "add_node",
      node: {
        id: "q-visual-style",
        kind: "open_question",
        status: "open",
        title: "Choose visual style",
        summary: "Decide between 2D top-down and 2.5D pseudo-3D.",
        createdAt: "2026-05-12T04:09:30.000Z",
        updatedAt: "2026-05-12T04:09:30.000Z",
      },
    },
    {
      op: "add_open_question",
      nodeId: "q-visual-style",
      detail: "Visual style impacts physics complexity, camera logic, art scope, and timeline.",
      options: [
        { id: "opt-visual-2d-topdown", title: "2D top-down", summary: "Fast implementation and strong gameplay clarity." },
        { id: "opt-visual-25d", title: "2.5D pseudo-3D", summary: "Richer look but higher technical overhead." },
      ],
      recommendedOptionIds: ["opt-visual-2d-topdown"],
    },
  ],
})}
\`\`\``,
  { graph: { id: "workflow-project-32-orchestration-5", revision: 0 }, author: "validation-script", now: "2026-05-12T04:09:30.000Z" },
);
assert.equal(plannerMalformedQuestionPatch.status, "valid");
if (plannerMalformedQuestionPatch.status === "valid") {
  const gameModule = plannerMalformedQuestionPatch.patch.operations.find(
    (operation) => operation.op === "add_node" && operation.node.id === "scope-racing-simulator",
  );
  const decomposition = plannerMalformedQuestionPatch.patch.operations.find((operation) => operation.op === "add_edge");
  const question = plannerMalformedQuestionPatch.patch.operations.find((operation) => operation.op === "add_open_question");
  assert.equal(gameModule?.op === "add_node" ? gameModule.node.kind : null, "system_component");
  assert.equal(decomposition?.op === "add_edge" ? decomposition.edge.kind : null, "contains");
  assert.equal(question?.op === "add_open_question" ? question.question.id : null, "q-visual-style");
  assert.equal(question?.op === "add_open_question" ? question.question.question : null, "Choose visual style");
  assert.equal(question?.op === "add_open_question" ? question.question.options?.[0]?.label : null, "2D top-down");
  assert.equal(question?.op === "add_open_question" ? question.question.options?.[0]?.description : null, "Fast implementation and strong gameplay clarity.");
}
const plannerUpdatePatchWithUiMetadata = parsePlannerWorkflowPatch(
  `Planner text
\`\`\`ARC_WORKFLOW_PATCH_JSON
${JSON.stringify({
  id: "patch-strip-ui-update-metadata",
  graphId: "workflow-live-canvas-v1",
  baseRevision: 2,
  reason: "Validate update metadata normalization.",
  author: "planner",
  createdAt: "2026-05-12T04:20:00.000Z",
  operations: [
    {
      op: "update_node",
      nodeId: "q-visual-style",
      changes: {
        status: "complete",
        summary: "User selected 2D top-down.",
        updatedAt: "2026-05-12T04:20:00.000Z",
      },
    },
    {
      op: "update_open_question",
      questionId: "q-visual-style",
      changes: {
        status: "resolved",
        answer: "2D top-down",
        selectedOptionIds: ["opt-visual-2d-topdown"],
        updatedAt: "2026-05-12T04:20:00.000Z",
      },
    },
  ],
})}
\`\`\``,
  { graph: { id: "workflow-live-canvas-v1", revision: 2 }, author: "validation-script", now: "2026-05-12T04:20:00.000Z" },
);
assert.equal(plannerUpdatePatchWithUiMetadata.status, "valid");
if (plannerUpdatePatchWithUiMetadata.status === "valid") {
  const nodeUpdate = plannerUpdatePatchWithUiMetadata.patch.operations[0];
  const questionUpdate = plannerUpdatePatchWithUiMetadata.patch.operations[1];
  assert.equal(nodeUpdate.op === "update_node" ? "updatedAt" in nodeUpdate.changes : true, false);
  assert.equal(questionUpdate.op === "update_open_question" ? "updatedAt" in questionUpdate.changes : true, false);
  assert.equal(questionUpdate.op === "update_open_question" ? "selectedOptionIds" in questionUpdate.changes : true, false);
}

const stalePatch: WorkflowPatch = { ...replaceP2pPatch, id: "patch-stale", baseRevision: 1 };
assert.throws(() => applyWorkflowPatch(updated as WorkflowGraph, stalePatch), /currently at revision 2/);

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
    assert.equal(persisted.graph.nodes.length, 0);
    assert.equal(persisted.graph.openQuestions.length, 0);
    assert.equal(persisted.graph.description, "Persist workflow graph state");

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
    const canvasPrompts = new CanvasPromptRepo(database.db);
    const orchestrations = new OrchestrationsRepo(database.db);
    const orchestrationAgents = new OrchestrationAgentsRepo(database.db);
    const orchestrationMessages = new OrchestrationMessagesRepo(database.db);
    const orchestrationSafety = new OrchestrationSafetyRepo(database.db);
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
      canvasPrompts,
      orchestrations,
      orchestrationAgents,
      orchestrationMessages,
      orchestrationSafety,
      planner: validationPlanner(orchestrationMessages, orchestrations),
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

      const orchestrated = await fetchJson<{
        orchestration: {
          orchestration: {
            id: number;
            workflow: { revision: number; graph: WorkflowGraph } | null;
            latestWorkflowPatch?: { status?: string; repairAttempts?: number } | null;
          };
        };
        workflow: { revision: number; graph: WorkflowGraph };
      }>(`${baseUrl}/api/orchestrate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "/orchestrate ace multiplayer snake game",
          projectId,
          x: 120,
          y: 160,
        }),
      });
      assert.equal(orchestrated.workflow.revision, 1);
      assert.equal(orchestrated.orchestration.orchestration.latestWorkflowPatch?.status, "applied");
      assert.equal(orchestrated.orchestration.orchestration.latestWorkflowPatch?.repairAttempts, 2);
      assert.ok(orchestrated.workflow.graph.nodes.some((node) => node.id.includes("component-peer-discovery")));
      assert.equal(orchestrated.workflow.graph.openQuestions.filter((question) => question.status === "open").length, 6);
      assert.ok(orchestrated.workflow.graph.nodes.some((node) => node.kind === "open_question" && /Client platform/.test(node.title)));
      assert.ok(orchestrated.orchestration.orchestration.workflow);
      const initialOrchestration = await fetchJson<{
        orchestration: {
          questions?: Array<{ id: string; source: string; workflowNodeId?: string; options: unknown[]; messages: unknown[] }>;
        };
        questionCards?: unknown[];
      }>(`${baseUrl}/api/orchestrations/${orchestrated.orchestration.orchestration.id}`);
      assert.equal(initialOrchestration.questionCards?.length ?? 0, 0);
      const clientPlatformQuestion = initialOrchestration.orchestration.questions?.find((question) => question.workflowNodeId?.includes("client-platform"));
      assert.equal(clientPlatformQuestion?.source, "workflow");
      assert.equal(clientPlatformQuestion?.options.length, 3);
      assert.equal(clientPlatformQuestion?.messages.length, 0);

      const answered = await fetchJson<{
        orchestration: {
          questions?: Array<{ workflowNodeId?: string; status: string; answer?: { content: string } | null }>;
          workflow: { revision: number; graph: WorkflowGraph } | null;
        };
      }>(`${baseUrl}/api/orchestrations/${orchestrated.orchestration.orchestration.id}/questions/${clientPlatformQuestion?.id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selectedOptionIds: ["option-client-platform-browser"], customText: "" }),
      });
      assert.equal(answered.orchestration.questions?.find((question) => question.workflowNodeId === clientPlatformQuestion?.workflowNodeId)?.status, "resolved");
      assert.equal(
        answered.orchestration.workflow?.graph.openQuestions.find((question) => question.id === clientPlatformQuestion?.id)?.status,
        "resolved",
      );

      const planned = await fetchJson<{
        orchestration: {
          questions?: Array<{ id: string; status: string; answer?: { content: string } | null; options: Array<{ id: string }> }>;
          workflow: { revision: number; graph: WorkflowGraph } | null;
          latestWorkflowPatch?: { status?: string; reason?: string; resultingRevision?: number; error?: string } | null;
        };
      }>(`${baseUrl}/api/orchestrations/${orchestrated.orchestration.orchestration.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "No not P2P, make it HTTPS" }),
      });
      assert.equal(planned.orchestration.workflow?.revision, 3);
      assert.equal(planned.orchestration.latestWorkflowPatch?.status, "applied");
      assert.ok(planned.orchestration.workflow?.graph.nodes.some((node) => node.id.includes("component-https-api-server")));
      assert.equal(
        planned.orchestration.workflow?.graph.nodes.find((node) => node.id.includes("component-peer-discovery"))?.status,
        "deprecated",
      );
      for (const question of planned.orchestration.questions?.filter((candidate) => candidate.status === "open" && !candidate.answer) ?? []) {
        await fetchJson(`${baseUrl}/api/orchestrations/${orchestrated.orchestration.orchestration.id}/questions/${question.id}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ selectedOptionIds: [question.options[0]?.id].filter(Boolean), customText: "" }),
        });
      }

      const prepared = await fetchJson<{
        requiresApproval?: boolean;
        cards: unknown[];
        orchestration: {
          orchestration: {
            status: string;
            finalPlan: { agents?: unknown[]; sharedContext?: string } | null;
            workflow: { revision: number; graph: WorkflowGraph } | null;
          };
        };
      }>(`${baseUrl}/api/orchestrations/${orchestrated.orchestration.orchestration.id}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 160, y: 220 }),
      });
      assert.equal(prepared.requiresApproval, true);
      assert.equal(prepared.cards.length, 0, "first launch call should prepare the plan without spawning child cards");
      assert.equal(prepared.orchestration.orchestration.status, "ready_for_approval");
      assert.ok(prepared.orchestration.orchestration.finalPlan?.agents?.length);
      assert.match(prepared.orchestration.orchestration.finalPlan?.sharedContext ?? "", /Current WorkflowGraph:/);
      assert.ok((prepared.orchestration.orchestration.workflow?.revision ?? 0) >= 3);
      assert.equal(prepared.orchestration.orchestration.workflow?.graph.openQuestions.some((question) => question.status === "open"), false);
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

function validationPlanner(messages: OrchestrationMessagesRepo, orchestrations: OrchestrationsRepo): {
  startPlanner: (orchestrationId: number, options?: { extraInstructions?: string; metadata?: unknown }) => Promise<string>;
  continuePlanner: (orchestrationId: number, userMessage?: string, options?: { extraInstructions?: string; metadata?: unknown }) => Promise<string>;
  generateFleetPlan: (orchestrationId: number, options?: { extraInstructions?: string; metadata?: unknown }) => Promise<{ raw: string; validJson?: string; errors: string[] }>;
} {
  return {
    async startPlanner(orchestrationId, options) {
      const content = sixQuestionPlannerResponse();
      messages.create(orchestrationId, "planner", content, { metadata: options?.metadata });
      return content;
    },
    async continuePlanner(orchestrationId, userMessage, options) {
      const metadata = metadataRecord(options?.metadata);
      const graphId =
        /Current graph id: ([a-z0-9_.:-]+)/.exec(options?.extraInstructions ?? "")?.[1] ??
        /Patch graphId must be ([a-z0-9_.:-]+)/.exec(options?.extraInstructions ?? "")?.[1] ??
        "workflow-project-1-orchestration-1";
      const revision = Number(
        /current revision: (\d+)/i.exec(options?.extraInstructions ?? "")?.[1] ??
          /baseRevision must be (\d+)/i.exec(options?.extraInstructions ?? "")?.[1] ??
          0,
      );
      const lower = userMessage?.toLowerCase() ?? "";
      const isRepair = metadata.kind === "workflow_patch_repair" || /Re-emit the workflow update now/i.test(options?.extraInstructions ?? "");
      const repairAttempt = typeof metadata.repairAttempt === "number" ? metadata.repairAttempt : 0;
      const questionId = typeof metadata.questionId === "string" ? metadata.questionId : "open-question-client-platform";
      const workflowNodeId = typeof metadata.workflowNodeId === "string" ? metadata.workflowNodeId : "question-client-platform";
      const patch: WorkflowPatch | null = isRepair
        ? repairAttempt === 1
          ? {
              id: `patch-validation-bad-repair-rev-${revision}`,
              graphId,
              baseRevision: revision,
              reason: "Intentionally invalid first repair.",
              author: "planner",
              createdAt: "2026-05-09T12:34:00.000Z",
              operations: [
                {
                  op: "update_node",
                  nodeId: "missing-node",
                  changes: { updatedAt: "2026-05-09T12:34:00.000Z" },
                } as never,
              ],
            }
          : sixQuestionWorkflowPatch({ graphId, revision, orchestrationId })
        : lower.includes("browser")
          ? {
              id: `patch-validation-answer-client-platform-rev-${revision}`,
              graphId,
              baseRevision: revision,
              reason: "Resolve client platform question.",
              author: "planner",
              createdAt: "2026-05-09T12:45:00.000Z",
              operations: [
                {
                  op: "resolve_open_question",
                  questionId,
                  answer: "Browser",
                },
                {
                  op: "update_node",
                  nodeId: workflowNodeId,
                  changes: {
                    status: "complete",
                    summary: "User selected Browser as the client platform.",
                  },
                },
              ],
            }
          : lower.includes("https")
        ? {
            id: `patch-validation-https-rev-${revision}`,
            graphId,
            baseRevision: revision,
            reason: "Replace P2P multiplayer with HTTPS.",
            author: "planner",
            createdAt: "2026-05-09T12:50:00.000Z",
            operations: [
              {
                op: "mark_deprecated",
                targetType: "node",
                targetId: `component-peer-discovery-orchestration-${orchestrationId}`,
                reason: "User replaced P2P multiplayer with HTTPS.",
                replacementId: `component-https-api-server-orchestration-${orchestrationId}`,
              },
              {
                op: "add_node",
                node: {
                  id: `component-https-api-server-orchestration-${orchestrationId}`,
                  kind: "backend_component",
                  status: "active",
                  title: "HTTPS API server",
                  createdAt: "2026-05-09T12:50:00.000Z",
                  updatedAt: "2026-05-09T12:50:00.000Z",
                },
              },
            ],
          }
        : null;
      const content = patch
        ? `Workflow updated.\n\n\`\`\`ARC_WORKFLOW_PATCH_JSON\n${JSON.stringify(patch, null, 2)}\n\`\`\``
        : "I need one more requirement before changing the workflow.";
      messages.create(orchestrationId, "planner", content, { metadata: options?.metadata });
      return content;
    },
    async generateFleetPlan(orchestrationId, options) {
      const plan = {
        orchestrationGoal: "Validate workflow planner flow",
        architectureSummary: "Use workflow-aware planner output.",
        agentCount: 2,
        sharedContext: options?.extraInstructions ?? "Workflow context unavailable.",
        integrationStrategy: "Use separate implementation and validation agents.",
        agents: [
          {
            name: "Implementation",
            role: "implementer",
            objective: "Implement the planned workflow slice.",
            prompt: "Read workflow context and implement only the assigned slice.",
            acceptanceCriteria: ["Implementation matches current workflow context."],
          },
          {
            name: "Validation",
            role: "tester",
            objective: "Validate the planned workflow slice.",
            prompt: "Run available checks and report results.",
            acceptanceCriteria: ["Relevant validation commands are reported."],
          },
        ],
      };
      const raw = JSON.stringify(plan, null, 2);
      orchestrations.updateFinalPlan(orchestrationId, raw);
      messages.create(orchestrationId, "planner", raw, { metadata: { fleetPlan: true, ...(metadataRecord(options?.metadata)) } });
      return { raw, validJson: raw, errors: [] };
    },
  };
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sixQuestionPlannerResponse(options: { includePatch?: boolean; graphId?: string; revision?: number; orchestrationId?: number } = {}): string {
  const prose = `
I need these decisions before spawning agents:

1. Client platform
A) Browser - Build a web-first game.
B) Desktop - Package for desktop runtime.
C) Mobile - Prioritize touch controls.

2. Multiplayer topology
A) Local only - Single-machine play.
B) P2P - Direct peer connections.
C) Server authoritative - Backend owns canonical state.

3. Rendering style
A) Canvas 2D - Simple fast rendering.
B) DOM grid - Accessible layout.
C) WebGL - GPU-driven visuals.

4. Persistence
A) None - Ephemeral sessions.
B) Local storage - Save on the client.
C) Database - Store rooms and scores.

5. Authentication
A) Anonymous - No accounts.
B) Guest handles - Lightweight names.
C) Full login - Account-backed identity.

6. Deployment target
A) Static host - Browser bundle only.
B) Node server - Deploy app plus API.
C) Container - Dockerized runtime.
`.trim();
  if (!options.includePatch) return prose;
  const patch = sixQuestionWorkflowPatch({
    graphId: options.graphId ?? "workflow-project-1-orchestration-1",
    revision: options.revision ?? 0,
    orchestrationId: options.orchestrationId ?? 1,
  });
  return `${prose}\n\n\`\`\`ARC_WORKFLOW_PATCH_JSON\n${JSON.stringify(patch, null, 2)}\n\`\`\``;
}

function sixQuestionWorkflowPatch(options: { graphId: string; revision: number; orchestrationId: number }): WorkflowPatch {
  const createdAt = "2026-05-09T12:35:00.000Z";
  const goalNodeId = `goal-snake-game-orchestration-${options.orchestrationId}`;
  const peerNodeId = `component-peer-discovery-orchestration-${options.orchestrationId}`;
  const questions = [
    {
      slug: "client-platform",
      title: "Client platform",
      question: "Client platform?",
      detail: "Which client runtime should the implementation target first?",
      options: [
        ["option-client-platform-browser", "Browser", "Build a web-first game."],
        ["option-client-platform-desktop", "Desktop", "Package for a desktop runtime."],
        ["option-client-platform-mobile", "Mobile", "Prioritize touch controls."],
      ],
      recommendedOptionIds: ["option-client-platform-browser"],
      recommendationRationale: "Browser keeps the first playable slice easiest to run and validate.",
    },
    {
      slug: "multiplayer-topology",
      title: "Multiplayer topology",
      question: "Multiplayer topology?",
      detail: "Who owns multiplayer state for the first version?",
      options: [
        ["option-multiplayer-local", "Local only", "Single-machine play."],
        ["option-multiplayer-p2p", "P2P", "Direct peer connections."],
        ["option-multiplayer-server-authoritative", "Server authoritative", "Backend owns canonical state."],
      ],
      recommendedOptionIds: ["option-multiplayer-p2p"],
      recommendationRationale: "P2P matches the requested end-to-end multiplayer direction while staying lighter than a full authoritative backend.",
    },
    {
      slug: "rendering-style",
      title: "Rendering style",
      question: "Rendering style?",
      detail: "Which rendering approach should the first playable game use?",
      options: [
        ["option-rendering-canvas-2d", "Canvas 2D", "Simple fast rendering."],
        ["option-rendering-dom-grid", "DOM grid", "Accessible layout."],
        ["option-rendering-webgl", "WebGL", "GPU-driven visuals."],
      ],
      recommendedOptionIds: ["option-rendering-canvas-2d"],
      recommendationRationale: "Canvas 2D is enough for Snake and keeps gameplay iteration fast.",
    },
    {
      slug: "persistence",
      title: "Persistence",
      question: "Persistence?",
      detail: "Should the first version save anything between sessions?",
      options: [
        ["option-persistence-none", "None", "Ephemeral sessions."],
        ["option-persistence-local-storage", "Local storage", "Save on the client."],
        ["option-persistence-database", "Database", "Store rooms and scores."],
      ],
      recommendedOptionIds: ["option-persistence-none"],
      recommendationRationale: "No persistence keeps the MVP focused on live gameplay.",
    },
    {
      slug: "authentication",
      title: "Authentication",
      question: "Authentication?",
      detail: "How should players identify themselves initially?",
      options: [
        ["option-authentication-anonymous", "Anonymous", "No accounts."],
        ["option-authentication-guest-handles", "Guest handles", "Lightweight names."],
        ["option-authentication-full-login", "Full login", "Account-backed identity."],
      ],
      recommendedOptionIds: ["option-authentication-guest-handles"],
      recommendationRationale: "Guest handles give multiplayer sessions identity without account work.",
    },
    {
      slug: "deployment-target",
      title: "Deployment target",
      question: "Deployment target?",
      detail: "Where should the first deployed build run?",
      options: [
        ["option-deployment-static-host", "Static host", "Browser bundle only."],
        ["option-deployment-node-server", "Node server", "Deploy app plus API."],
        ["option-deployment-container", "Container", "Dockerized runtime."],
      ],
      recommendedOptionIds: ["option-deployment-node-server"],
      recommendationRationale: "A Node server leaves room for multiplayer signaling if needed.",
    },
  ];
  const operations: WorkflowPatch["operations"] = [
    {
      op: "add_node",
      node: {
        id: goalNodeId,
        kind: "goal",
        status: "active",
        title: "Build end-to-end multiplayer Snake game",
        summary: "Model-authored workflow for the requested playable multiplayer Snake game.",
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      op: "add_node",
      node: {
        id: peerNodeId,
        kind: "backend_component",
        status: "proposed",
        title: "Peer discovery",
        summary: "Initial multiplayer assumption until the topology decision is answered.",
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      op: "add_edge",
      edge: {
        id: `edge-peer-discovery-goal-orchestration-${options.orchestrationId}`,
        kind: "implements",
        fromNodeId: peerNodeId,
        toNodeId: goalNodeId,
        createdAt,
        updatedAt: createdAt,
      },
    },
  ];
  for (const question of questions) {
    const nodeId = `question-${question.slug}-orchestration-${options.orchestrationId}`;
    const questionId = `open-question-${question.slug}-orchestration-${options.orchestrationId}`;
    operations.push(
      {
        op: "add_node",
        node: {
          id: nodeId,
          kind: "open_question",
          status: "blocked",
          title: question.title,
          summary: question.detail,
          createdAt,
          updatedAt: createdAt,
        },
      },
      {
        op: "add_open_question",
        question: {
          id: questionId,
          question: question.question,
          detail: question.detail,
          status: "open",
          allowMultiSelect: false,
          options: question.options.map(([id, label, description]) => ({ id, label, description })),
          recommendedOptionIds: question.recommendedOptionIds,
          recommendationRationale: question.recommendationRationale,
          nodeIds: [nodeId],
          createdAt,
          updatedAt: createdAt,
        },
      },
      {
        op: "add_edge",
        edge: {
          id: `edge-${question.slug}-goal-orchestration-${options.orchestrationId}`,
          kind: "blocks",
          fromNodeId: nodeId,
          toNodeId: goalNodeId,
          createdAt,
          updatedAt: createdAt,
        },
      },
    );
  }
  return {
    id: `patch-validation-six-questions-rev-${options.revision}`,
    graphId: options.graphId,
    baseRevision: options.revision,
    reason: "Create model-authored workflow and planner questions.",
    author: "planner",
    createdAt,
    operations,
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
