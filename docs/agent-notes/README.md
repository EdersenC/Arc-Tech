# Arc-Tech Agent Notes

These notes are for agents working in this repository. They describe how the main modules connect so future changes stay inside the intended boundaries.

## Repository Shape

Arc-Tech has two UI adapters over one task runner:

- Discord bot entrypoint: `src/index.ts`
- Local Excalidraw entrypoint: `src/excalidrawServer.ts`

Both adapters create projects, tasks, orchestration state, worktrees, Codex runs, and optional pull requests through shared services. Avoid adding adapter-specific duplicate logic when a shared service already exists.

## First Files To Check

- Task creation and follow-up: `src/tasks/ImplementService.ts`, `src/tasks/TaskService.ts`, `src/taskMessagePump.ts`
- Git/worktree/PR lifecycle: `src/git.ts`, `src/github/GitHubPRService.ts`, `src/pr-stager/`
- Orchestration planning and child agents: `src/orchestrations/`
- Workflow graph state: `src/workflows/`
- Excalidraw API and cards: `src/excalidraw/ExcalidrawApiServer.ts`, `src/excalidraw/ExcalidrawCardsRepo.ts`
- React canvas: `web/src/App.tsx`, `web/src/api.ts`, `web/src/workflows/`
- Persistence: `schema.sql`, `src/db.ts`, `src/stores.ts`

## Working Style

- Prefer the existing store/service boundary over direct SQL from UI or runner code.
- Keep Discord and Excalidraw behavior consistent by routing through shared services.
- Treat generated workflow elements as read-only UI projection.
- Keep workflow patches semantic. Do not emit raw Excalidraw scene JSON as workflow state.
- Use repo-relative paths in docs and PR text.
