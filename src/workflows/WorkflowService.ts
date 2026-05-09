import { applyWorkflowPatch } from "./applyPatch.js";
import type { PersistedWorkflowGraph, PersistedWorkflowPatch, WorkflowGraphRepo } from "./WorkflowGraphRepo.js";
import type { WorkflowGraph, WorkflowPatch } from "./types.js";
import { validateWorkflowPatch } from "./validation.js";

export class WorkflowService {
  constructor(private readonly workflows: WorkflowGraphRepo) {}

  getOrCreateForOrchestration(projectId: number, orchestrationId: number, goal: string): PersistedWorkflowGraph {
    const existing = this.workflows.getByOrchestration(orchestrationId);
    if (existing) {
      assertProjectMatch(existing, projectId, orchestrationId);
      return existing;
    }

    const now = new Date().toISOString();
    const title = workflowTitle(goal);
    const graph = starterWorkflowGraph(projectId, orchestrationId, goal, title, now);
    return this.workflows.createGraph(projectId, orchestrationId, title, {
      ...graph,
    });
  }

  applyPlannerPatch(projectId: number, orchestrationId: number, patch: WorkflowPatch): PersistedWorkflowGraph {
    const patchResult = validateWorkflowPatch(patch);
    if (!patchResult.ok) {
      throw new Error(`Workflow planner patch is invalid: ${patchResult.errors.join("; ")}`);
    }
    if (patch.operations.some((operation) => operation.op === "create_graph")) {
      throw new Error("Workflow planner patches cannot create graphs through applyPlannerPatch; call getOrCreateForOrchestration first.");
    }

    const existing = this.workflows.getByOrchestration(orchestrationId);
    if (!existing) {
      throw new Error(`Workflow graph for orchestration ${orchestrationId} not found.`);
    }
    assertProjectMatch(existing, projectId, orchestrationId);
    if (patch.graphId && patch.graphId !== existing.graph.id) {
      throw new Error(`Workflow patch graphId ${patch.graphId} does not match current graph ${existing.graph.id}.`);
    }

    const updatedGraph = applyWorkflowPatch(existing.graph, patch);
    this.workflows.savePatch(existing.id, patch, updatedGraph);
    return requireGraph(this.workflows.getGraphSnapshot(existing.id), existing.id);
  }

  getCurrentGraphForProject(projectId: number): PersistedWorkflowGraph | null {
    const graph = this.workflows.getByProject(projectId);
    if (graph && graph.projectId !== projectId) {
      throw new Error(`Workflow graph ${graph.id} belongs to project ${graph.projectId}, not ${projectId}.`);
    }
    return graph;
  }

  getCurrentGraphForOrchestration(orchestrationId: number): PersistedWorkflowGraph | null {
    const graph = this.workflows.getByOrchestration(orchestrationId);
    if (graph && graph.orchestrationId !== orchestrationId) {
      throw new Error(`Workflow graph ${graph.id} belongs to orchestration ${graph.orchestrationId}, not ${orchestrationId}.`);
    }
    return graph;
  }

  listGraphHistory(graphId: number): PersistedWorkflowPatch[] {
    const graph = this.workflows.getGraphSnapshot(graphId);
    if (!graph) {
      throw new Error(`Workflow graph ${graphId} not found.`);
    }
    return this.workflows.listPatches(graphId);
  }
}

function workflowTitle(goal: string): string {
  const clean = goal.replace(/\s+/g, " ").trim();
  if (!clean) {
    return "Project workflow";
  }
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

function starterWorkflowGraph(projectId: number, orchestrationId: number, goal: string, title: string, now: string): WorkflowGraph {
  const hasMultiplayer = /multiplayer|multi-player|online|p2p|peer/i.test(goal);
  const hasGame = /game|snake|arcade|canvas|webgl|play/i.test(goal);
  const nodes: WorkflowGraph["nodes"] = [
    node(orchestrationId, "goal", "goal", title, "User-approved orchestration goal.", now, goal),
    node(orchestrationId, "req-playable-experience", "requirement", hasGame ? "Playable game experience" : "User-facing deliverable", "Build the primary user-visible workflow requested by the orchestration.", now),
    node(orchestrationId, "req-project-fit", "requirement", "Fit the existing project", "Inspect the selected repository and preserve current behavior unless a change is explicit.", now),
    node(orchestrationId, "decision-architecture", "decision", "Architecture plan", "Track the main implementation decisions before agents spawn.", now),
    node(orchestrationId, "frontend-game-loop", "frontend_component", hasGame ? "Frontend game loop" : "Frontend experience", "Owns interactive UI state, rendering, and user input.", now),
    node(orchestrationId, "backend-networking", "backend_component", hasMultiplayer ? "Backend/networking" : "Backend services", "Owns server-side APIs, persistence, and runtime coordination.", now),
    node(orchestrationId, "milestone-testing", "milestone", "Testing and validation", "Agents must run available build, test, and smoke checks.", now),
    node(orchestrationId, "milestone-deployment", "milestone", "Deployment readiness", "Record deployment/runtime assumptions before final integration.", now),
    node(orchestrationId, "question-runtime", "open_question", "Runtime constraints", "Clarify repo-specific runtime, deployment, and compatibility constraints.", now),
  ];

  if (hasMultiplayer) {
    nodes.push(
      node(orchestrationId, "decision-p2p-multiplayer", "decision", "P2P multiplayer", "Initial networking assumption until the user or planner replaces it.", now),
      node(orchestrationId, "component-peer-discovery", "backend_component", "Peer discovery", "Finds peers for P2P game sessions.", now),
      node(orchestrationId, "component-nat-traversal", "backend_component", "NAT traversal", "Allows peers behind routers to connect directly.", now),
      node(orchestrationId, "component-host-migration", "backend_component", "Host migration", "Moves authority when the current P2P host disconnects.", now),
      node(orchestrationId, "component-multiplayer-sync", "system_component", "Multiplayer synchronization", "Keeps game state synchronized across players.", now),
    );
  }

  const edges: WorkflowGraph["edges"] = [
    edge(orchestrationId, "goal-req-playable-experience", "contains", `goal-orchestration-${orchestrationId}`, `req-playable-experience-orchestration-${orchestrationId}`, now),
    edge(orchestrationId, "goal-req-project-fit", "contains", `goal-orchestration-${orchestrationId}`, `req-project-fit-orchestration-${orchestrationId}`, now),
    edge(orchestrationId, "frontend-game-loop-goal", "implements", `frontend-game-loop-orchestration-${orchestrationId}`, `goal-orchestration-${orchestrationId}`, now),
    edge(orchestrationId, "backend-networking-goal", "implements", `backend-networking-orchestration-${orchestrationId}`, `goal-orchestration-${orchestrationId}`, now),
    edge(orchestrationId, "testing-goal", "depends_on", `milestone-testing-orchestration-${orchestrationId}`, `goal-orchestration-${orchestrationId}`, now),
    edge(orchestrationId, "deployment-goal", "depends_on", `milestone-deployment-orchestration-${orchestrationId}`, `goal-orchestration-${orchestrationId}`, now),
  ];

  if (hasMultiplayer) {
    edges.push(
      edge(orchestrationId, "p2p-decision-networking", "relates_to", `decision-p2p-multiplayer-orchestration-${orchestrationId}`, `backend-networking-orchestration-${orchestrationId}`, now),
      edge(orchestrationId, "peer-discovery-p2p", "implements", `component-peer-discovery-orchestration-${orchestrationId}`, `decision-p2p-multiplayer-orchestration-${orchestrationId}`, now),
      edge(orchestrationId, "nat-traversal-p2p", "implements", `component-nat-traversal-orchestration-${orchestrationId}`, `decision-p2p-multiplayer-orchestration-${orchestrationId}`, now),
      edge(orchestrationId, "host-migration-p2p", "implements", `component-host-migration-orchestration-${orchestrationId}`, `decision-p2p-multiplayer-orchestration-${orchestrationId}`, now),
      edge(orchestrationId, "sync-backend", "depends_on", `component-multiplayer-sync-orchestration-${orchestrationId}`, `backend-networking-orchestration-${orchestrationId}`, now),
    );
  }

  const decisions: WorkflowGraph["decisions"] = hasMultiplayer
    ? [
        {
          id: `decision-p2p-multiplayer-orchestration-${orchestrationId}`,
          title: "P2P multiplayer",
          summary: "Initial networking assumption for multiplayer until planner input changes it.",
          status: "proposed",
          nodeId: `decision-p2p-multiplayer-orchestration-${orchestrationId}`,
          createdAt: now,
          updatedAt: now,
        },
      ]
    : [];

  return {
    id: `workflow-project-${projectId}-orchestration-${orchestrationId}`,
    projectId: `project-${projectId}`,
    title,
    description: goal.trim() || undefined,
    revision: 0,
    nodes,
    edges,
    decisions,
    risks: [],
    openQuestions: [
      {
        id: `question-runtime-orchestration-${orchestrationId}`,
        question: "What runtime, deployment, and compatibility constraints should the agents preserve?",
        status: "open",
        nodeIds: [`question-runtime-orchestration-${orchestrationId}`],
        createdAt: now,
        updatedAt: now,
      },
    ],
    layoutHints: nodes.map((workflowNode, index) => ({
      id: `layout-${workflowNode.id}`,
      nodeId: workflowNode.id,
      sectionId: workflowNode.kind,
      order: index,
    })),
    revisions: [],
    createdAt: now,
    updatedAt: now,
  };
}

function node(
  orchestrationId: number,
  slug: string,
  kind: WorkflowGraph["nodes"][number]["kind"],
  title: string,
  summary: string,
  now: string,
  body?: string,
): WorkflowGraph["nodes"][number] {
  return {
    id: slug === "goal" ? `goal-orchestration-${orchestrationId}` : `${slug}-orchestration-${orchestrationId}`,
    kind,
    status: "active",
    title,
    summary,
    body,
    createdAt: now,
    updatedAt: now,
  };
}

function edge(
  orchestrationId: number,
  slug: string,
  kind: WorkflowGraph["edges"][number]["kind"],
  fromNodeId: string,
  toNodeId: string,
  now: string,
): WorkflowGraph["edges"][number] {
  return {
    id: `edge-${slug}-orchestration-${orchestrationId}`,
    kind,
    fromNodeId,
    toNodeId,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function assertProjectMatch(graph: PersistedWorkflowGraph, projectId: number, orchestrationId: number): void {
  if (graph.projectId !== projectId) {
    throw new Error(`Workflow graph ${graph.id} belongs to project ${graph.projectId}, not ${projectId}.`);
  }
  if (graph.orchestrationId !== orchestrationId) {
    throw new Error(`Workflow graph ${graph.id} belongs to orchestration ${graph.orchestrationId}, not ${orchestrationId}.`);
  }
}

function requireGraph(graph: PersistedWorkflowGraph | null, id: number): PersistedWorkflowGraph {
  if (!graph) {
    throw new Error(`Workflow graph ${id} not found after update.`);
  }
  return graph;
}
