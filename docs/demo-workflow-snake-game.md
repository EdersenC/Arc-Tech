# Demo: Workflow-Aware Multiplayer Snake

This demo exercises the live workflow canvas v1 path from Excalidraw `/orchestrate` through planner-owned `WorkflowPatch` application and agent spawning.

## 1. Start The App

From a fresh checkout:

```bash
npm install
cp .env.example .env
npm run excalidraw
```

Open the Vite URL printed in the terminal. Keep the terminal visible so you can watch workflow logs:

- `Workflow patch applied.`
- `Planner workflow patch applied.`
- `Workflow patch rejected.`
- `Planner workflow patch rejected.`

## 2. Create Or Select A Project

In the top project selector:

1. Select an existing Excalidraw project, or create a new one.
2. If you plan to spawn implementation agents with PRs enabled, connect the repo remote in the repo panel.
3. Confirm the project status says the remote/PR state is ready for the operation you want.

Direct canvas edits are not workflow input. The workflow graph changes only through planner/model patches.

## 3. Start Planning

Submit:

```text
/orchestrate ace multiplayer snake game
```

Expected result:

- A parent orchestration card appears.
- The orchestration sidebar opens.
- A `WorkflowGraph` is created for the orchestration.
- The canvas renders locked workflow boxes/arrows.
- The status strip shows `Workflow connected` and the current revision.

The initial graph should include a goal, requirements, architecture decisions, frontend/game loop, backend/networking, multiplayer synchronization, testing, deployment, open questions, and initial P2P-related assumptions such as peer discovery, NAT traversal, and host migration.

## 4. Change Networking Requirement

Send this planner reply in the orchestration sidebar:

```text
make networking HTTPS instead of P2P
```

Expected result:

- The planner responds with concise planning text.
- If the planner has enough information, it emits an `ARC_WORKFLOW_PATCH_JSON` block.
- The server validates and applies the patch.
- The terminal logs `Planner workflow patch applied.`
- The workflow stream emits `workflow.patch_applied`.
- The canvas updates without a page reload.
- The sidebar shows the new workflow revision and latest patch reason.

Expected semantic consequences:

- P2P multiplayer, peer discovery, NAT traversal, and host migration are deprecated or replaced.
- HTTPS API server, game rooms, server-authoritative state, sessions/auth, and backend endpoints are added or planned.
- Testing/deployment context changes to include backend runtime, HTTPS/API validation, room lifecycle, and session/auth concerns.
- Unrelated nodes remain.

If the planner emits malformed JSON or an old `baseRevision`, the server rejects it safely. The sidebar should show the rejected patch status/error and the planner loop should keep running.

## 5. Verify Canvas Safety

Try selecting, moving, or deleting a workflow-owned element.

Expected result:

- The action does not persist to SQLite workflow state.
- Refreshing or receiving the next workflow snapshot restores workflow-owned elements from the current graph.
- Task-card dragging still persists through the existing `excalidraw_cards` path.

## 6. Spawn Agents

When the plan is ready, press **Spawn Agents**.

Expected result:

- The app asks the planner for strict `AgentFleetPlan` JSON.
- The current `WorkflowGraph` summary is included in `sharedContext`.
- Child tasks are created through the existing `ImplementService` path.
- Child prompts tell agents to read workflow context but not directly mutate `WorkflowGraph` in v1.
- Child cards appear inside the orchestration group.

## 7. Confirm Child Context

Open a child task card and inspect the prompt/history.

Look for:

```text
Current WorkflowGraph:
Graph: workflow-project-...
Child agents receive this workflow as context only. They must not directly mutate WorkflowGraph in v1 unless routed back through the planner.
```

## Troubleshooting

- `Workflow reconnecting`: the browser SSE connection dropped and `EventSource` is reconnecting automatically.
- `Workflow disconnected`: reload the page or switch projects to create a new stream.
- Stale patch rejection: the planner used an old `baseRevision`; fetch the current graph and regenerate the patch.
- Malformed patch rejection: the newest `ARC_WORKFLOW_PATCH_JSON` block must contain one complete JSON object.
- No canvas update: check browser console for stream parse errors and server logs for workflow patch apply/reject messages.
