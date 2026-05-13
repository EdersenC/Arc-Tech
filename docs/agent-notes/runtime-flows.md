# Runtime Flows

## Direct Implementation Task

1. Discord `/implement` or Excalidraw Direct Agent calls `ImplementService.run(...)`.
2. The service syncs project remote state, creates a task row, creates or refreshes a git worktree through `TaskService` and `GitManager`, and queues the initial task message.
3. If started immediately, `TaskMessagePump.enqueue(taskId)` begins processing.
4. `TaskMessagePump` marks queued messages as processing and runs Codex through `CodexCliRunner`.
5. Codex JSONL events are parsed and routed into task progress.
6. After Codex exits, `GitManager.commitTaskChanges(...)` commits task worktree changes.
7. If GitHub PRs are enabled and there is a diff, `GitHubPRService` stages and publishes a PR.
8. Task status becomes `WAITING_REVIEW`, with completion summary, diff stat, and optional PR URL.

## Follow-Up Task Message

1. Discord thread message or Excalidraw task drawer message calls `ImplementService.enqueueFollowUp(...)`.
2. A task message row is queued.
3. If the task is not `PENDING_START`, the pump starts or continues the same task worktree and branch.
4. Closed task statuses reject follow-ups.

## Orchestration Planning

1. `/orchestrate` creates an orchestration row and stores the user's goal as an orchestration message.
2. The planner runs in read-only mode through `OrchestrationPlannerService`.
3. Excalidraw creates or loads a server-owned `WorkflowGraph` for the orchestration.
4. Planner responses should include semantic `ARC_WORKFLOW_PATCH_JSON` blocks when graph semantics change.
5. The API parses, repairs when possible, validates, applies, persists, and emits workflow patch events.
6. Planner clarification questions should become workflow `open_question` records.

## Batched Question Answering

1. The browser shows all workflow-backed planner questions in the sidebar and question popovers.
2. Option clicks and typed custom answers call `/api/orchestrations/:id/questions/:questionId/answer`.
3. The server records the answer message and locally applies a `resolve_open_question` workflow patch.
4. The planner is not called for each answer.
5. Once the visible question batch is complete, the user can press Continue Planning to let the model ask another wave, or Prepare Plan to generate an agent fleet plan.
6. Preparing the plan is blocked while workflow questions remain open.

## Fleet Plan And Child Agent Spawn

1. Prepare Plan or Launch asks `OrchestrationPlannerService.generateFleetPlan(...)` for strict `AgentFleetPlan` JSON.
2. The planner should define shared `interfaceContracts` and per-agent `AgentWorkContract` objects before child agents spawn.
3. `AgentFleetPlanValidator` checks agent count, roles, prompts, acceptance criteria, and the optional contract shapes.
4. Excalidraw marks the parent orchestration card ready and shows Start Plan.
5. Start Plan creates child tasks through `ImplementService.run(...)` with explicit branch/worktree names.
6. Child cards are placed inside the orchestration parent container.
7. Child task completion updates orchestration agent status and parent aggregate progress.

## Agent Safety Coordination

1. Child-agent prompts include the agent safety contract and coordination skills for contract lookup, context lookup, plan history, user decisions, prompt artifacts, scope/interface changes, contract deviations, assumptions, risks, validation results, test help, integration handoff, dependency tracking, retry, reassignment, and safe abort.
2. Agents emit `ARC_AGENT_SAFETY_EVENT_JSON` blocks when they need to change scope, shared interfaces, workflow rules, prompt artifact rules, event payloads, contracts, another agent's files, or cross-agent dependencies.
3. `TaskMessagePump` parses those blocks from structured Codex completion output and stores them in `orchestration_safety_records`.
4. Approved scope/interface changes create `orchestration_contract_revisions` so contract changes are auditable.
5. The Excalidraw orchestration sidebar shows context query history, plan history requests, user decisions, prompt artifact context, validation results, failed validation alerts, integration handoffs, retry/reassignment/abort status, assumptions, risks, dependencies, change requests, deviations, contract revisions, and records needing orchestrator or user action.
6. The orchestrator answers context queries from known state, keeps user decisions separate from assumptions, treats prompt artifacts as context instead of workflow nodes, reacts to failed validation, uses integration handoffs for final merge/PR planning, and escalates to the user only for product behavior, user intent, or major tradeoffs.

## Workflow Event Stream

1. Browser subscribes to `GET /api/workflows/events?projectId=<id>`.
2. `WorkflowEventBus` emits snapshots, graph-created events, patch-applied events, and patch-rejected events.
3. `web/src/workflows/useWorkflowStream.ts` receives events and refreshes graph state.
4. `workflowElements.ts` renders workflow nodes/edges into Excalidraw.
5. Client moves/deletes of workflow elements are restored from the server graph.

## PR Staging And Feedback

1. Agent final output must contain one structured `ARC_AGENT_COMPLETION_JSON` block.
2. The runner parses only the structured block. Free-form Codex text is not copied into PR bodies.
3. Changed files and stats come from git facts, not from agent-provided file lists.
4. The PR Stager sanitizes title/body and blocks publication on leak detection.
5. `gh pr create/edit --body-file` publishes the staged body.
6. The feedback worker polls tracked open PRs, dedupes comments/reviews, queues them as task follow-ups, and can suspend idle polling.
