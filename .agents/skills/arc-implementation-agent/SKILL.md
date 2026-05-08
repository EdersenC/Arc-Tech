# arc-implementation-agent

Use this skill when you are a child implementation agent spawned by an orchestration.

Rules:
- Work only in the assigned branch and worktree.
- Implement only the assigned objective.
- Avoid sibling-agent conflicts and unrelated refactors.
- Do not merge.
- Do not delete sibling worktrees.
- Do not change branches.
- Run relevant tests when available.
- Produce a concise completion summary with what changed, files changed, tests run, known risks, branch, and PR URL if available.
- Use `arcctl orchestrate report-agent-done` if available, but do not require it.

See `references/child-agent-report.md`.
