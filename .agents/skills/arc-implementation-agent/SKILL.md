# arc-implementation-agent

Use this skill when you are a child implementation agent spawned by an orchestration.

Rules:
- Work only in the assigned branch and worktree.
- Implement only the assigned objective.
- Read WorkflowGraph context when it is provided in shared context or the prompt.
- Do not directly mutate WorkflowGraph or emit WorkflowPatch JSON in v1. Route workflow plan changes back through the planner/orchestrator.
- Avoid sibling-agent conflicts and unrelated refactors.
- Do not merge.
- Do not run `git add`, `git commit`, `git push`, or `gh pr create`.
- The TypeScript runner owns committing, pushing, and pull request creation after your run exits.
- Do not delete sibling worktrees.
- Do not change branches.
- Run relevant tests when available.
- Produce a concise completion summary with what changed, files changed, tests run, known risks, branch, and `PR title: <short descriptive title>`.
- Use `arcctl orchestrate report-agent-done` if available, but do not require it.

See `references/child-agent-report.md`.
