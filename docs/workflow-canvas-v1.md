# Workflow Canvas v1

The workflow graph is the source of truth. Excalidraw is only the visual projection of that graph.

In v1, users do not directly edit the workflow graph on the canvas. Only model/planner-produced `WorkflowPatch` objects mutate the graph. Canvas elements may move, but raw Excalidraw element data must not be stored in or applied as a workflow patch.

## Example Graph

```json
{
  "id": "workflow-live-canvas-v1",
  "projectId": "project-arc",
  "title": "Live workflow canvas v1",
  "revision": 1,
  "createdAt": "2026-05-09T12:00:00.000Z",
  "updatedAt": "2026-05-09T12:00:00.000Z",
  "nodes": [
    {
      "id": "goal-live-canvas",
      "kind": "goal",
      "status": "active",
      "title": "Ship live workflow canvas v1",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    },
    {
      "id": "component-peer-discovery",
      "kind": "backend_component",
      "status": "active",
      "title": "Peer discovery",
      "summary": "Find peers for direct multiplayer sessions.",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    },
    {
      "id": "component-nat-traversal",
      "kind": "backend_component",
      "status": "active",
      "title": "NAT traversal",
      "summary": "Help direct peers connect across private networks.",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    },
    {
      "id": "component-host-migration",
      "kind": "backend_component",
      "status": "active",
      "title": "Host migration",
      "summary": "Move session authority when a peer host disconnects.",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    }
  ],
  "edges": [
    {
      "id": "edge-peer-discovery-goal",
      "kind": "implements",
      "fromNodeId": "component-peer-discovery",
      "toNodeId": "goal-live-canvas",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    },
    {
      "id": "edge-nat-traversal-goal",
      "kind": "implements",
      "fromNodeId": "component-nat-traversal",
      "toNodeId": "goal-live-canvas",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    },
    {
      "id": "edge-host-migration-goal",
      "kind": "implements",
      "fromNodeId": "component-host-migration",
      "toNodeId": "goal-live-canvas",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    }
  ],
  "decisions": [],
  "risks": [],
  "openQuestions": [],
  "layoutHints": [],
  "revisions": [
    {
      "revision": 1,
      "patchId": "patch-create-workflow",
      "reason": "Create initial live canvas workflow graph.",
      "author": "planner",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z",
      "operationCount": 1
    }
  ]
}
```

## Example Patch

```json
{
  "id": "patch-add-workflow-risk",
  "graphId": "workflow-live-canvas-v1",
  "baseRevision": 1,
  "reason": "Track risk that graph and canvas projections drift.",
  "author": "planner",
  "createdAt": "2026-05-09T12:05:00.000Z",
  "operations": [
    {
      "op": "add_risk",
      "risk": {
        "id": "risk-canvas-projection-drift",
        "title": "Canvas projection drift",
        "impact": "Users could see stale cards if graph changes are not projected consistently.",
        "status": "open",
        "nodeIds": ["goal-live-canvas"],
        "createdAt": "2026-05-09T12:05:00.000Z",
        "updatedAt": "2026-05-09T12:05:00.000Z"
      }
    }
  ]
}
```

## Example User Change

User change: `replace P2P multiplayer with HTTPS`

Expected semantic consequences:

- Deprecate or remove peer discovery.
- Deprecate or remove NAT traversal.
- Deprecate or remove host migration.
- Add an HTTPS API server.
- Add game rooms.
- Add server-authoritative state.
- Add sessions/auth.
- Add backend endpoints.

Concrete patch:

```json
{
  "id": "patch-replace-p2p-with-https",
  "graphId": "workflow-live-canvas-v1",
  "baseRevision": 1,
  "reason": "Replace P2P multiplayer with HTTPS.",
  "author": "planner",
  "createdAt": "2026-05-09T12:10:00.000Z",
  "operations": [
    {
      "op": "mark_deprecated",
      "targetType": "node",
      "targetId": "component-peer-discovery",
      "reason": "HTTPS removes peer discovery from v1.",
      "replacementId": "component-https-api"
    },
    {
      "op": "mark_deprecated",
      "targetType": "node",
      "targetId": "component-nat-traversal",
      "reason": "HTTPS server connectivity replaces NAT traversal."
    },
    {
      "op": "mark_deprecated",
      "targetType": "node",
      "targetId": "component-host-migration",
      "reason": "Server authority removes host migration from v1."
    },
    {
      "op": "add_node",
      "node": {
        "id": "component-https-api",
        "kind": "backend_component",
        "status": "active",
        "title": "HTTPS API server",
        "summary": "Central server for room, session, and game-state APIs.",
        "createdAt": "2026-05-09T12:10:00.000Z",
        "updatedAt": "2026-05-09T12:10:00.000Z"
      }
    },
    {
      "op": "add_node",
      "node": {
        "id": "component-game-rooms",
        "kind": "backend_component",
        "status": "active",
        "title": "Game rooms",
        "summary": "Room lifecycle and membership model.",
        "createdAt": "2026-05-09T12:10:00.000Z",
        "updatedAt": "2026-05-09T12:10:00.000Z"
      }
    },
    {
      "op": "add_node",
      "node": {
        "id": "component-server-authoritative-state",
        "kind": "backend_component",
        "status": "active",
        "title": "Server-authoritative state",
        "summary": "Server-owned match state and conflict resolution.",
        "createdAt": "2026-05-09T12:10:00.000Z",
        "updatedAt": "2026-05-09T12:10:00.000Z"
      }
    },
    {
      "op": "add_node",
      "node": {
        "id": "component-sessions-auth",
        "kind": "backend_component",
        "status": "active",
        "title": "Sessions/auth",
        "summary": "Session identity and authorization for room APIs.",
        "createdAt": "2026-05-09T12:10:00.000Z",
        "updatedAt": "2026-05-09T12:10:00.000Z"
      }
    },
    {
      "op": "add_node",
      "node": {
        "id": "component-backend-endpoints",
        "kind": "backend_component",
        "status": "active",
        "title": "Backend endpoints",
        "summary": "HTTP endpoints for lobby, room, session, and state transitions.",
        "createdAt": "2026-05-09T12:10:00.000Z",
        "updatedAt": "2026-05-09T12:10:00.000Z"
      }
    }
  ]
}
```

The patch is semantic: it names workflow nodes, edges, decisions, risks, and open questions. It does not contain Excalidraw `elements`, `appState`, scene `files`, coordinates, dimensions, or shape types.

## Validation

Run:

```bash
npm run validate:workflows
npm run build
```

Validators reject duplicate node IDs, edges that point to missing nodes, stale `baseRevision` values, patches without a `reason`, unstable IDs, and raw Excalidraw scene data inside `WorkflowPatch`.

## Persistence

Workflow state is stored in SQLite as project-scoped graph snapshots plus append-only patch history.

`workflow_graphs` stores the current authoritative `WorkflowGraph` JSON for a project and optional orchestration. The row `revision` must match `graph_json.revision`. There is at most one graph per `(project_id, orchestration_id)` when an orchestration is attached.

`workflow_patches` stores each successfully applied planner patch with its `base_revision`, `resulting_revision`, original semantic `patch_json`, `source`, and `reason`. Patch rows are written in the same transaction as the graph snapshot update.

`WorkflowService.getOrCreateForOrchestration(projectId, orchestrationId, goal)` creates a revision `0` graph with a goal node when no graph exists yet. `WorkflowService.applyPlannerPatch(projectId, orchestrationId, patch)` validates the patch, checks project/orchestration ownership, applies it with `applyWorkflowPatch`, updates the snapshot, and records the patch history.

Stale patch application fails before the graph row is updated. The persistence layer checks both the semantic patch `baseRevision` and the current SQLite `workflow_graphs.revision`.

The persistence service has no Discord, Git, or Excalidraw card dependencies. Canvas cards remain downstream projections and are not mutated by workflow graph persistence.
