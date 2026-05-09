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

`WorkflowService.getOrCreateForOrchestration(projectId, orchestrationId, goal)` creates a revision `0` starter graph when no graph exists yet. The starter graph includes the goal plus initial requirement, decision, frontend/backend, testing, deployment, and open-question nodes. Multiplayer goals also seed P2P-related nodes such as peer discovery, NAT traversal, host migration, and multiplayer synchronization so the planner can explicitly replace or deprecate them later. `WorkflowService.applyPlannerPatch(projectId, orchestrationId, patch)` validates the patch, checks project/orchestration ownership, applies it with `applyWorkflowPatch`, updates the snapshot, and records the patch history.

Stale patch application fails before the graph row is updated. The persistence layer checks both the semantic patch `baseRevision` and the current SQLite `workflow_graphs.revision`.

The persistence service has no Discord, Git, or Excalidraw card dependencies. Canvas cards remain downstream projections and are not mutated by workflow graph persistence.

## API Routes

Workflow graph routes are served by the existing Excalidraw API server. They are local/trusted v1 endpoints for planner/model-owned workflow changes.

Routes:

- `GET /api/workflows/project/:projectId/current`
- `GET /api/workflows/orchestration/:orchestrationId`
- `GET /api/workflows/:graphId/history`
- `POST /api/workflows/orchestration/:orchestrationId/patch`
- `GET /api/workflows/events?projectId=...`

`GET /api/workflows/orchestration/:orchestrationId` creates a revision `0` workflow graph for the orchestration when none exists yet. The graph starts from the orchestration goal and starter planning nodes. The POST patch route then applies semantic `WorkflowPatch` objects against that graph.

Example create/get:

```bash
curl -s http://127.0.0.1:3123/api/workflows/orchestration/1
```

Example current project workflow:

```bash
curl -s http://127.0.0.1:3123/api/workflows/project/1/current
```

Example patch:

```bash
curl -s \
  -X POST \
  -H 'content-type: application/json' \
  http://127.0.0.1:3123/api/workflows/orchestration/1/patch \
  --data '{
    "patch": {
      "id": "patch-add-https-api",
      "graphId": "workflow-project-1-orchestration-1",
      "baseRevision": 0,
      "reason": "Add HTTPS API server to the workflow plan.",
      "author": "planner",
      "createdAt": "2026-05-09T12:30:00.000Z",
      "operations": [
        {
          "op": "add_node",
          "node": {
            "id": "component-https-api",
            "kind": "backend_component",
            "status": "active",
            "title": "HTTPS API server",
            "createdAt": "2026-05-09T12:30:00.000Z",
            "updatedAt": "2026-05-09T12:30:00.000Z"
          }
        }
      ]
    }
  }'
```

Example history:

```bash
curl -s http://127.0.0.1:3123/api/workflows/1/history
```

Example live stream:

```bash
curl -N http://127.0.0.1:3123/api/workflows/events?projectId=1
```

SSE event names:

- `workflow.snapshot`
- `workflow.graph_created`
- `workflow.patch_applied`
- `workflow.patch_rejected`

The stream is project-scoped. Subscribers for project `1` do not receive workflow events emitted for project `2`.

The patch route validates semantic workflow patches and rejects stale revisions, project/orchestration mismatches, unstable IDs, and raw Excalidraw scene fields. It does not run shell commands and does not mutate `excalidraw_cards`.

## Planner Integration

When the Excalidraw canvas sends `POST /api/orchestrate`, the server creates the orchestration, creates or loads the orchestration workflow graph, emits `workflow.graph_created` on the project stream, and includes the graph in the orchestration response:

```json
{
  "orchestration": {
    "orchestration": {
      "id": 12,
      "workflow": {
        "id": 7,
        "projectId": 1,
        "orchestrationId": 12,
        "revision": 0,
        "graph": {
          "id": "workflow-project-1-orchestration-12",
          "revision": 0
        }
      }
    }
  }
}
```

Planner messages may include one semantic patch block. The server extracts the newest block, validates it with `WorkflowPatchValidator`, applies it through `WorkflowService`, records patch history, and emits `workflow.patch_applied`. Malformed or stale blocks are recorded in planner message metadata as `workflowPatch.status = "rejected"` and emitted as `workflow.patch_rejected`; the planner loop continues.

Patch block format:

````markdown
The plan should move networking away from P2P and make the backend authoritative.

```ARC_WORKFLOW_PATCH_JSON
{
  "id": "patch-replace-p2p-with-https-orchestration-12-rev-0",
  "graphId": "workflow-project-1-orchestration-12",
  "baseRevision": 0,
  "reason": "Replace P2P multiplayer with HTTPS.",
  "author": "planner",
  "createdAt": "2026-05-09T12:40:00.000Z",
  "operations": [
    {
      "op": "mark_deprecated",
      "targetType": "node",
      "targetId": "component-peer-discovery-orchestration-12",
      "reason": "User replaced P2P multiplayer with HTTPS.",
      "replacementId": "component-https-api-server-orchestration-12"
    },
    {
      "op": "add_node",
      "node": {
        "id": "component-https-api-server-orchestration-12",
        "kind": "backend_component",
        "status": "active",
        "title": "HTTPS API server",
        "summary": "Server endpoint layer replaces direct P2P connectivity.",
        "createdAt": "2026-05-09T12:40:00.000Z",
        "updatedAt": "2026-05-09T12:40:00.000Z"
      }
    }
  ]
}
```
````

Planner prompt rules:

- Keep user-facing planner text concise.
- Include `ARC_WORKFLOW_PATCH_JSON` only when the semantic workflow should change.
- Always include `graphId`, `baseRevision`, `reason`, `createdAt`, and stable lowercase IDs.
- Never include raw Excalidraw `elements`, `appState`, `files`, coordinates, or shape JSON.
- Ask a clarifying question and emit no patch when user input is ambiguous.

Example flow:

1. User starts `/orchestrate ace multiplayer snake game`.
2. The starter graph includes goal, requirements, architecture decisions, frontend/game loop, backend/networking, multiplayer synchronization, testing, deployment, open questions, and P2P assumptions.
3. User replies `No not P2P, make it HTTPS`.
4. The planner patch deprecates P2P multiplayer, peer discovery, NAT traversal, and host migration; adds HTTPS API server, game rooms, server-authoritative state, sessions/auth, and backend endpoints; and updates testing/deployment consequences while preserving unrelated nodes.

When `Spawn Agents` is approved, the current `WorkflowGraph` summary is appended to `AgentFleetPlan.sharedContext`. Child agents receive it as context only; in v1 they do not mutate the workflow graph directly.
