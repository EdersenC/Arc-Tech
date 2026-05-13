# Validation Notes

## Common Commands

```bash
npm run build
npm run validate:workflows
npm run test:pr-stager
```

`npm run build` runs TypeScript and the Vite production build.

`npm run validate:workflows` covers workflow domain behavior, planner patch parsing/normalization, workflow persistence, Excalidraw workflow API behavior, generated question nodes, question answer resolution, and plan preparation.

`npm run test:pr-stager` covers PR body sanitization, structured completion parsing, git diff fixture parsing, PR type classification, renderer snapshots, and leakage regressions.

## When To Run What

- Task runner, git, PR, Codex, or shared type changes: run `npm run build`.
- Workflow graph, planner patches, orchestration questions, Excalidraw workflow canvas, or plan launch changes: run `npm run validate:workflows`.
- PR body, sanitizer, classifier, renderer, GitHub PR service, or agent completion changes: run `npm run test:pr-stager`.
- UI changes: run `npm run build`; use a browser smoke test when layout or Excalidraw interaction changed.

## Known Build Warning

The Vite build can warn about chunks larger than 500 kB. That warning is currently expected from the Excalidraw/Mermaid-heavy bundle. Treat build failure as blocking, but do not treat this warning alone as a failure.

## PR Review Checklist

- Are public PR bodies generated through the PR Stager or an equivalently sanitized path?
- Are file paths in public text repo-relative?
- Are workflow changes semantic patches instead of canvas JSON?
- Are planner questions represented as workflow `open_question` records?
- Does question answering remain batched unless the user explicitly asks to chat with the planner?
- Did new database fields update schema, migrations, row mappers, and API views together?
