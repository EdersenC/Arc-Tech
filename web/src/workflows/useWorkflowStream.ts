import { useEffect, useState } from "react";
import {
  getCurrentWorkflowForProject,
  openWorkflowEventSource,
  type ArcPersistedWorkflowGraph,
  type ArcWorkflowEvent,
} from "./api";

export type WorkflowStreamStatus = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

export interface WorkflowStreamState {
  graph: ArcPersistedWorkflowGraph | null;
  revision: number | null;
  status: WorkflowStreamStatus;
  error: string | null;
  latestPatchReason: string | null;
  latestEvent: ArcWorkflowEvent | null;
}

export function useWorkflowStream(projectId: number | null): WorkflowStreamState {
  const [state, setState] = useState<WorkflowStreamState>({
    graph: null,
    revision: null,
    status: "idle",
    error: null,
    latestPatchReason: null,
    latestEvent: null,
  });

  useEffect(() => {
    if (!projectId) {
      setState({ graph: null, revision: null, status: "idle", error: null, latestPatchReason: null, latestEvent: null });
      return;
    }

    let canceled = false;
    let source: EventSource | null = null;
    setState((current) => ({ ...current, status: "connecting", error: null }));

    void getCurrentWorkflowForProject(projectId)
      .then((response) => {
        if (canceled) return;
        setState((current) => ({
          ...current,
          graph: response.workflow,
          revision: response.workflow?.revision ?? null,
          status: "connecting",
          error: null,
        }));
      })
      .catch((error) => {
        if (canceled) return;
        setState((current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : String(error) }));
      });

    source = openWorkflowEventSource(projectId, (event) => {
      setState((current) => {
        const graph = event.graph ?? current.graph;
        const latestPatchReason = patchReason(event) ?? current.latestPatchReason;
        return {
          graph,
          revision: graph?.revision ?? current.revision,
          status: "connected",
          error: event.type === "workflow.patch_rejected" ? (event.error ?? "Workflow patch rejected.") : null,
          latestPatchReason,
          latestEvent: event,
        };
      });
    }, (error) => {
      setState((current) => ({ ...current, status: "error", error }));
    });
    source.onopen = () => {
      setState((current) => ({ ...current, status: "connected", error: null }));
    };
    source.onerror = () => {
      setState((current) => ({
        ...current,
        status: source?.readyState === EventSource.CLOSED ? "disconnected" : "reconnecting",
        error: source?.readyState === EventSource.CLOSED ? "Workflow stream disconnected." : "Workflow stream reconnecting.",
      }));
    };

    return () => {
      canceled = true;
      source?.close();
      setState((current) => ({ ...current, status: "disconnected" }));
    };
  }, [projectId]);

  return state;
}

function patchReason(event: ArcWorkflowEvent): string | null {
  if (!event.patch) return null;
  const patch = event.patch;
  if ("reason" in patch && typeof patch.reason === "string") return patch.reason;
  if ("patch" in patch && patch.patch && typeof patch.patch === "object" && "reason" in patch.patch) {
    const reason = (patch.patch as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  return null;
}
