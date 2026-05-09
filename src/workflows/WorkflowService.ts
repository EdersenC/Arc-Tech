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
    return this.workflows.createGraph(projectId, orchestrationId, title, {
      id: `workflow-project-${projectId}-orchestration-${orchestrationId}`,
      projectId: `project-${projectId}`,
      title,
      description: goal.trim() || undefined,
      revision: 0,
      nodes: [
        {
          id: `goal-orchestration-${orchestrationId}`,
          kind: "goal",
          status: "active",
          title,
          summary: goal.trim() || undefined,
          createdAt: now,
          updatedAt: now,
        },
      ],
      edges: [],
      decisions: [],
      risks: [],
      openQuestions: [],
      layoutHints: [],
      revisions: [],
      createdAt: now,
      updatedAt: now,
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
