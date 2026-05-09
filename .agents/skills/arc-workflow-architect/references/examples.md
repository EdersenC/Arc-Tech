# Examples

These examples are patterns, not a special snake-game-only contract. Reuse the same structure for any Arc-Tech workflow:

- Start with a `goal` node and a small set of requirements.
- Add architecture `decision` nodes for assumptions that may change.
- Add component nodes for frontend, backend, data, external services, deployment, and validation concerns.
- Connect components with semantic edges such as `implements`, `depends_on`, `contains`, `replaces`, or `blocks`.
- When the user changes direction, preserve unrelated graph sections and deprecate or replace only the affected nodes.
- When a requirement change has downstream effects, update tests, risks, deployment, open questions, and agent-task nodes in the same patch when enough information is available.
- If the user is ambiguous, ask a clarifying question and emit no patch.

Generic node ID pattern:

```text
goal-orchestration-<id>
req-<short-requirement>-orchestration-<id>
decision-<short-decision>-orchestration-<id>
component-<short-component>-orchestration-<id>
agent-task-<short-slice>-orchestration-<id>
risk-<short-risk>-orchestration-<id>
question-<short-question>-orchestration-<id>
```

Generic change pattern:

```ARC_WORKFLOW_PATCH_JSON
{
  "id": "patch-change-architecture-rev-3",
  "graphId": "workflow-project-1-orchestration-12",
  "baseRevision": 3,
  "reason": "Replace an earlier architecture decision with the user's new requirement.",
  "author": "planner",
  "createdAt": "2026-05-09T12:00:00.000Z",
  "operations": [
    {
      "op": "mark_deprecated",
      "targetType": "node",
      "targetId": "decision-old-architecture-orchestration-12",
      "reason": "The user selected a different architecture.",
      "replacementId": "decision-new-architecture-orchestration-12"
    },
    {
      "op": "add_node",
      "node": {
        "id": "decision-new-architecture-orchestration-12",
        "kind": "decision",
        "status": "active",
        "title": "New architecture decision",
        "summary": "Concise statement of the new decision.",
        "createdAt": "2026-05-09T12:00:00.000Z",
        "updatedAt": "2026-05-09T12:00:00.000Z"
      }
    }
  ]
}
```

## Initial Graph: Ace Multiplayer Snake Game

```json
{
  "id": "workflow-project-1-orchestration-12",
  "projectId": "project-1",
  "title": "ace multiplayer snake game",
  "description": "ace multiplayer snake game",
  "revision": 0,
  "nodes": [
    {
      "id": "goal-orchestration-12",
      "kind": "goal",
      "status": "active",
      "title": "ace multiplayer snake game",
      "summary": "Build the requested multiplayer snake game.",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    },
    {
      "id": "frontend-game-loop-orchestration-12",
      "kind": "frontend_component",
      "status": "active",
      "title": "Frontend game loop",
      "summary": "Render the snake board and process player input.",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    },
    {
      "id": "decision-p2p-multiplayer-orchestration-12",
      "kind": "decision",
      "status": "active",
      "title": "P2P multiplayer",
      "summary": "Initial multiplayer networking assumption.",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    },
    {
      "id": "component-peer-discovery-orchestration-12",
      "kind": "backend_component",
      "status": "active",
      "title": "Peer discovery",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    },
    {
      "id": "component-nat-traversal-orchestration-12",
      "kind": "backend_component",
      "status": "active",
      "title": "NAT traversal",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    }
  ],
  "edges": [
    {
      "id": "edge-frontend-goal-orchestration-12",
      "kind": "implements",
      "fromNodeId": "frontend-game-loop-orchestration-12",
      "toNodeId": "goal-orchestration-12",
      "status": "active",
      "createdAt": "2026-05-09T12:00:00.000Z",
      "updatedAt": "2026-05-09T12:00:00.000Z"
    }
  ],
  "decisions": [],
  "risks": [],
  "openQuestions": [],
  "layoutHints": [],
  "revisions": [],
  "createdAt": "2026-05-09T12:00:00.000Z",
  "updatedAt": "2026-05-09T12:00:00.000Z"
}
```

## P2P -> HTTPS Replacement Patch

```ARC_WORKFLOW_PATCH_JSON
{
  "id": "patch-replace-p2p-with-https-rev-0",
  "graphId": "workflow-project-1-orchestration-12",
  "baseRevision": 0,
  "reason": "Replace P2P multiplayer with HTTPS.",
  "author": "planner",
  "createdAt": "2026-05-09T12:05:00.000Z",
  "operations": [
    {
      "op": "mark_deprecated",
      "targetType": "node",
      "targetId": "decision-p2p-multiplayer-orchestration-12",
      "reason": "User rejected P2P multiplayer.",
      "replacementId": "component-https-api-server-orchestration-12"
    },
    {
      "op": "mark_deprecated",
      "targetType": "node",
      "targetId": "component-peer-discovery-orchestration-12",
      "reason": "HTTPS removes direct peer discovery.",
      "replacementId": "component-https-api-server-orchestration-12"
    },
    {
      "op": "mark_deprecated",
      "targetType": "node",
      "targetId": "component-nat-traversal-orchestration-12",
      "reason": "HTTPS removes NAT traversal from v1.",
      "replacementId": "component-https-api-server-orchestration-12"
    },
    {
      "op": "add_node",
      "node": {
        "id": "component-https-api-server-orchestration-12",
        "kind": "backend_component",
        "status": "active",
        "title": "HTTPS API server",
        "summary": "Server endpoint layer for multiplayer operations.",
        "createdAt": "2026-05-09T12:05:00.000Z",
        "updatedAt": "2026-05-09T12:05:00.000Z"
      }
    },
    {
      "op": "add_node",
      "node": {
        "id": "component-game-rooms-orchestration-12",
        "kind": "backend_component",
        "status": "active",
        "title": "Game rooms",
        "createdAt": "2026-05-09T12:05:00.000Z",
        "updatedAt": "2026-05-09T12:05:00.000Z"
      }
    },
    {
      "op": "add_node",
      "node": {
        "id": "component-server-authoritative-state-orchestration-12",
        "kind": "backend_component",
        "status": "active",
        "title": "Server-authoritative state",
        "createdAt": "2026-05-09T12:05:00.000Z",
        "updatedAt": "2026-05-09T12:05:00.000Z"
      }
    }
  ]
}
```

## Add Auth Patch

```ARC_WORKFLOW_PATCH_JSON
{
  "id": "patch-add-auth-rev-1",
  "graphId": "workflow-project-1-orchestration-12",
  "baseRevision": 1,
  "reason": "Add sessions and authentication to protect multiplayer rooms.",
  "author": "planner",
  "createdAt": "2026-05-09T12:10:00.000Z",
  "operations": [
    {
      "op": "add_node",
      "node": {
        "id": "component-sessions-auth-orchestration-12",
        "kind": "backend_component",
        "status": "active",
        "title": "Sessions/auth",
        "summary": "Identify players and authorize room actions.",
        "createdAt": "2026-05-09T12:10:00.000Z",
        "updatedAt": "2026-05-09T12:10:00.000Z"
      }
    },
    {
      "op": "add_edge",
      "edge": {
        "id": "edge-auth-https-api-orchestration-12",
        "kind": "depends_on",
        "fromNodeId": "component-sessions-auth-orchestration-12",
        "toNodeId": "component-https-api-server-orchestration-12",
        "status": "active",
        "createdAt": "2026-05-09T12:10:00.000Z",
        "updatedAt": "2026-05-09T12:10:00.000Z"
      }
    }
  ]
}
```

## Split Frontend/Backend Agents Patch

```ARC_WORKFLOW_PATCH_JSON
{
  "id": "patch-split-frontend-backend-agents-rev-2",
  "graphId": "workflow-project-1-orchestration-12",
  "baseRevision": 2,
  "reason": "Split implementation into frontend and backend child agents.",
  "author": "planner",
  "createdAt": "2026-05-09T12:15:00.000Z",
  "operations": [
    {
      "op": "add_node",
      "node": {
        "id": "agent-task-frontend-gameplay-orchestration-12",
        "kind": "agent_task",
        "status": "proposed",
        "title": "Frontend gameplay agent",
        "summary": "Own game UI, loop, controls, and client state rendering.",
        "createdAt": "2026-05-09T12:15:00.000Z",
        "updatedAt": "2026-05-09T12:15:00.000Z"
      }
    },
    {
      "op": "add_node",
      "node": {
        "id": "agent-task-backend-multiplayer-orchestration-12",
        "kind": "agent_task",
        "status": "proposed",
        "title": "Backend multiplayer agent",
        "summary": "Own HTTPS API, rooms, sessions/auth, and server-authoritative state.",
        "createdAt": "2026-05-09T12:15:00.000Z",
        "updatedAt": "2026-05-09T12:15:00.000Z"
      }
    }
  ]
}
```

## Invalid Patch Examples

Raw Excalidraw scene data is rejected:

```json
{
  "id": "patch-raw-canvas",
  "graphId": "workflow-project-1-orchestration-12",
  "baseRevision": 2,
  "reason": "Move a card",
  "createdAt": "2026-05-09T12:20:00.000Z",
  "operations": [],
  "elements": [{ "type": "rectangle", "x": 10, "y": 20, "width": 100, "height": 80 }]
}
```

Why rejected: workflow patches must be semantic, not canvas element updates.

Missing `baseRevision` is rejected unless the patch creates a graph:

```json
{
  "id": "patch-missing-base",
  "graphId": "workflow-project-1-orchestration-12",
  "reason": "Add API server",
  "createdAt": "2026-05-09T12:25:00.000Z",
  "operations": []
}
```

Why rejected: the server cannot safely apply a patch without stale-revision protection.
