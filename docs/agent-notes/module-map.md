# Module Map

## Entrypoints

`src/index.ts` starts the Discord bot. It wires Discord commands, component handlers, task progress, orchestration control panels, PR feedback polling, and the shared `TaskMessagePump`.

`src/excalidrawServer.ts` starts the local Excalidraw API and Vite UI wrapper without requiring Discord credentials. It creates the same stores and services as the Discord bot, plus Excalidraw card persistence and workflow event streaming.

`src/excalidraw.ts` is the local launcher that runs the Excalidraw API and frontend dev process.

## Shared Project And Task Layer

`src/stores.ts` maps SQLite rows into `Project`, `Task`, task messages, codex events, and task progress data. `schema.sql` is the canonical schema and `src/db.ts` applies lightweight migrations.

`src/tasks/TaskService.ts` owns low-level implementation task creation and task worktree creation. `src/tasks/ImplementService.ts` is the higher-level adapter-safe entrypoint for `/implement`, Excalidraw Direct Agent, and orchestration child agents.

`src/taskMessagePump.ts` serializes queued task messages into Codex runs. It commits changes after Codex exits, stages PRs when enabled, updates task status, and notifies UI adapters.

## Codex Execution

`src/codexRunner.ts` shells out to `codex exec --json` in the task worktree. It sets a private `.codex-tmp/` inside the worktree so sandboxed Codex runs do not depend on shared temp paths.

`src/codex/CodexJsonlEventParser.ts` parses JSONL events. `src/codex/CodexEventRouter.ts` stores events and routes progress to `TaskProgressService`.

`src/progress/TaskProgressService.ts` turns task events into live Discord status updates.

## Git And Pull Requests

`src/git.ts` owns repo initialization, worktree creation, commits, branch pushes, PR create/edit calls, merge, cleanup, and git-derived PR facts.

`src/github/GitHubPRService.ts` is the runner-facing PR integration. It calls `src/pr-stager/` before publishing a PR body.

`src/pr-stager/` parses structured agent completion JSON, classifies PR type, renders sanitized reviewer-facing markdown, emits optional repo-relative impact graphs, and blocks leak-prone PR content.

`src/github/PullRequestFeedbackWorker.ts` polls tracked PRs for new feedback and queues that feedback as normal task follow-up work. `PullRequestFeedbackRepo.ts` stores tracked PRs and deduped feedback events.

## Orchestration

`src/orchestrations/OrchestrationPlannerService.ts` runs read-only planner turns and generates strict `AgentFleetPlan` JSON during launch.

`src/orchestrations/AgentFleetPlanValidator.ts` validates final fleet plans.

`src/orchestrations/AgentWorkContract.ts` formats the per-child `AgentWorkContract` passed into spawned agent prompts. It keeps old plans compatible by generating a fallback contract when the planner omitted one.

`src/orchestrations/AgentSafetyInstructions.ts` defines the shared child-agent safety contract and machine-readable safety event format. `AgentSafetyEvents.ts` parses emitted safety blocks, and `repos/OrchestrationSafetyRepo.ts` persists safety records and approved contract revisions.

`src/orchestrations/OrchestrationAgentSpawner.ts` creates child implementation tasks from a final plan. Discord child agents get threads; Excalidraw child agents get cards.

`src/orchestrations/OrchestrationControlPanel.ts` is the Discord control surface. Excalidraw orchestration controls live in `ExcalidrawApiServer.ts` and `web/src/App.tsx`.

## Workflow Graph

`src/workflows/types.ts` defines semantic workflow nodes, edges, decisions, risks, open questions, layout hints, and patch operations.

`src/workflows/plannerPatchParser.ts` extracts and normalizes planner `ARC_WORKFLOW_PATCH_JSON` blocks.

`src/workflows/validation.ts` validates strict patch and graph contracts.

`src/workflows/applyPatch.ts` applies semantic workflow patches.

`src/workflows/WorkflowGraphRepo.ts` persists graph snapshots and patch history.

`src/workflows/WorkflowService.ts` is the service boundary used by the Excalidraw API and planner integration.

`src/workflows/WorkflowEventBus.ts` emits in-memory workflow SSE events to the browser.

## Excalidraw Adapter

`src/excalidraw/ExcalidrawApiServer.ts` is the main HTTP API for local canvas use. It owns project selection, task cards, orchestration views, question answering, plan update/remake, launch, workflow patches, workflow event streams, task history, and PR feedback checks.

`src/excalidraw/ExcalidrawCardsRepo.ts` persists visual cards. Cards are not the source of task or workflow truth.

`web/src/App.tsx` is the main React canvas shell. It renders cards, sidebars, canvas composer text boxes, workflow popovers, batched question controls, launch actions, and agent safety registers.

`web/src/workflows/workflowElements.ts` converts workflow graphs into Excalidraw elements. `workflowLayout.ts` computes graph layout sections. `useWorkflowStream.ts` subscribes to SSE workflow events.
