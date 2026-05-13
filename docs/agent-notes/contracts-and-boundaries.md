# Contracts And Boundaries

## Git Ownership

The runner owns git lifecycle operations:

- repo init and remote sync
- task branch/worktree creation
- commits after Codex exits
- branch pushes
- PR create/edit
- merges and cleanup

Codex workers must not run `git add`, `git commit`, `git push`, `gh pr create`, or branch-changing commands. Worker code changes belong inside the isolated task worktree only.

## WorkflowGraph Ownership

`WorkflowGraph` is semantic state, not canvas state. The graph belongs to the server and is changed only through validated `WorkflowPatch` operations. Excalidraw elements are a visual projection.

Do not store raw Excalidraw elements, `appState`, files, coordinates, or scene JSON in workflow patches. Use semantic nodes, edges, risks, decisions, open questions, and layout hints.

Allowed workflow changes go through:

- `plannerPatchParser.ts` for model output extraction and normalization
- `validation.ts` for strict schema checks
- `applyPatch.ts` for graph mutations
- `WorkflowService.ts` and `WorkflowGraphRepo.ts` for persistence

## Planner Questions

Clarification questions should be first-class workflow `open_question` items. Planner prose alone is not enough.

Question answers are batched:

- `/answer` saves a user answer and resolves the workflow question locally.
- `/messages` is for question-scoped planner chat.
- `/plan/update` continues planning from saved answers.
- `/plan/remake` rebuilds the fleet plan from saved answers.

Do not reintroduce behavior where every option click immediately runs the planner.

## PR Body Safety

Public PR bodies must be reviewer-focused and sanitized. Never publish:

- absolute local paths
- `.arc-tech`
- worktree internals
- Excalidraw workspace internals
- `WorkflowGraph` dumps
- detailed prompts
- internal rules
- system/developer instructions
- raw task prompts

The PR Stager must use structured agent completion data plus git-derived file facts. It must not trust agent-provided changed-file lists.

## UI Adapter Boundary

Discord and Excalidraw are adapters over shared task/orchestration services. If a behavior should apply to both, put it in the shared service layer. Adapter-specific code should stay limited to presentation, request parsing, or channel/card/thread mechanics.

## Persistence Boundary

Prefer store/repo classes over direct database access:

- `ProjectStore` and `TaskStore` for projects/tasks/messages/events.
- `OrchestrationsRepo`, `OrchestrationAgentsRepo`, and `OrchestrationMessagesRepo` for orchestration state.
- `WorkflowGraphRepo` for workflow snapshots and patch history.
- `ExcalidrawCardsRepo` for visual card layout only.
- `PullRequestFeedbackRepo` for tracked PRs and feedback events.

When adding schema fields, update `schema.sql`, `src/db.ts` migrations, row types, mapping functions, and any API views together.

## Canvas Rules

Task and orchestration cards are persisted visual objects. Workflow elements are regenerated from `WorkflowGraph`. Card dragging can persist positions; workflow element dragging should not mutate graph state.

Keep Excalidraw's built-in dark theme active and avoid overriding Excalidraw internals with custom theme clones.
