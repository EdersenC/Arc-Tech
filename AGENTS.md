# Agent Notes

This repository is a TypeScript Discord/Codex runner with an Excalidraw canvas adapter. Agents should read the structured notes in `docs/agent-notes/` before changing module boundaries.

Start here:

- `docs/agent-notes/README.md` - orientation and common rules.
- `docs/agent-notes/module-map.md` - where major runtime modules live.
- `docs/agent-notes/runtime-flows.md` - how Discord, Excalidraw, Codex, workflow, and PR paths connect.
- `docs/agent-notes/contracts-and-boundaries.md` - ownership rules and safety contracts.
- `docs/agent-notes/validation.md` - validation commands and what they cover.

Important defaults:

- The orchestrator owns git branch, worktree, commit, push, PR, and merge operations.
- Codex worker tasks edit only inside their isolated task worktree.
- WorkflowGraph is server-owned semantic state; Excalidraw renders a projection.
- User question answers are saved first, then planning continues only through explicit plan actions.
- Public PR bodies must be staged and sanitized; do not publish raw prompts, local paths, workflow dumps, or internal runner rules.
