import type { PersistedWorkflowGraph, PersistedWorkflowPatch } from "./WorkflowGraphRepo.js";
import type { WorkflowPatch } from "./types.js";

export type WorkflowEventType = "workflow.snapshot" | "workflow.patch_applied" | "workflow.patch_rejected" | "workflow.graph_created";

export interface WorkflowEvent {
  id: number;
  type: WorkflowEventType;
  projectId: number;
  orchestrationId: number | null;
  graphId: number | null;
  graph?: PersistedWorkflowGraph;
  patch?: PersistedWorkflowPatch | WorkflowPatch;
  error?: string;
  createdAt: string;
}

export type WorkflowEventListener = (event: WorkflowEvent) => void;

export class WorkflowEventBus {
  private nextId = 1;
  private readonly listenersByProject = new Map<number, Set<WorkflowEventListener>>();

  subscribe(projectId: number, listener: WorkflowEventListener): () => void {
    const listeners = this.listenersByProject.get(projectId) ?? new Set<WorkflowEventListener>();
    listeners.add(listener);
    this.listenersByProject.set(projectId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listenersByProject.delete(projectId);
      }
    };
  }

  snapshot(graph: PersistedWorkflowGraph): WorkflowEvent {
    return this.emit({
      type: "workflow.snapshot",
      projectId: graph.projectId,
      orchestrationId: graph.orchestrationId,
      graphId: graph.id,
      graph,
    });
  }

  graphCreated(graph: PersistedWorkflowGraph): WorkflowEvent {
    return this.emit({
      type: "workflow.graph_created",
      projectId: graph.projectId,
      orchestrationId: graph.orchestrationId,
      graphId: graph.id,
      graph,
    });
  }

  patchApplied(graph: PersistedWorkflowGraph, patch: PersistedWorkflowPatch): WorkflowEvent {
    return this.emit({
      type: "workflow.patch_applied",
      projectId: graph.projectId,
      orchestrationId: graph.orchestrationId,
      graphId: graph.id,
      graph,
      patch,
    });
  }

  patchRejected(input: { projectId: number; orchestrationId: number | null; graphId?: number | null; patch?: WorkflowPatch; error: string }): WorkflowEvent {
    return this.emit({
      type: "workflow.patch_rejected",
      projectId: input.projectId,
      orchestrationId: input.orchestrationId,
      graphId: input.graphId ?? null,
      patch: input.patch,
      error: input.error,
    });
  }

  private emit(event: Omit<WorkflowEvent, "id" | "createdAt">): WorkflowEvent {
    const materialized: WorkflowEvent = {
      ...event,
      id: this.nextId++,
      createdAt: new Date().toISOString(),
    };
    const listeners = this.listenersByProject.get(materialized.projectId);
    if (listeners) {
      for (const listener of listeners) {
        listener(materialized);
      }
    }
    return materialized;
  }
}
