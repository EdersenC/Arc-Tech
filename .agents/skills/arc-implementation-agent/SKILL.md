---
name: arc-implementation-agent
description: Use when acting as a child implementation agent spawned by an orchestration, with scoped worktree ownership, test expectations, and completion reporting.
---

# arc-implementation-agent

Use this skill when you are a child implementation agent spawned by an orchestration.

Rules:
- Work only in the assigned branch and worktree.
- Implement only the assigned objective.
- Treat `AgentWorkContract` as the source of truth when present. Follow owned scope, forbidden scope, interfaces to consume/provide, data contracts, validation commands, and conflict-avoidance rules.
- Do not silently change assigned scope, shared types, API routes, database schema, workflow graph rules, prompt artifact rules, event payloads, agent contracts, files owned by another agent, or cross-agent dependencies.
- If you need to change scope or a shared interface, pause that risky change and emit an `ARC_AGENT_SAFETY_EVENT_JSON` block for orchestrator approval before editing that surface.
- Use these safety skills as structured events:
  - `query_contract`: ask for objective, owned files, forbidden files, expected interfaces, validation commands, and acceptance criteria.
  - `query_project_context`: ask for relevant docs/code/contracts after checking your current worktree; do not invent missing facts.
  - `query_plan_history`: ask what the previous plan versions and decisions were; mark old decisions as superseded.
  - `query_user_decisions`: ask for explicit user decisions only; do not treat assumptions as user decisions.
  - `query_prompt_artifacts`: ask for prompt artifact command kind, body, linked targets, dispatch state, and artifact state; prompt artifacts are not WorkflowGraph nodes.
  - `request_scope_change`: include original scope, requested new scope, reason, risk if denied, and affected files or agents.
  - `request_interface_change`: include interface name, proposed change, reason, compatibility impact, affected consumers, and migration needs.
  - `report_contract_deviation`: report expected versus actual repo behavior when the assignment is wrong.
  - `declare_assumption`: include assumption, reason, confidence, risk if wrong, and whether work can continue without approval.
  - `risk_register_update`: include risk, category, severity, likelihood, mitigation, and owner if known.
  - `sync_with_orchestrator`: report completed work, next risky work, and needed confirmation.
  - `request_peer_coordination`: ask the orchestrator to mediate with another agent.
  - `notify_dependency_ready`: announce completed dependency work for waiting agents.
  - `request_dependency_status`: ask the orchestrator whether a dependency is ready, not ready, or unknown.
  - `report_validation_result`: include command, passed/failed/skipped, useful output, suspected cause, and requested action. Failed validation must be reported.
  - `request_test_help`: ask for help writing or fixing tests.
  - `handoff_to_integration`: include summary, changed files, new interfaces, expected consumers, setup required, validation notes, and risks.
  - `request_retry`: include failed action, failure reason, retry plan, and risk of retry.
  - `request_reassignment`: include reason, recommended role, remaining work, and handoff notes.
  - `abort_with_reason`: include reason, evidence, completed work, rollback notes, and recommended next step.
- Safety event format:
  ```ARC_AGENT_SAFETY_EVENT_JSON
  {
    "kind": "request_scope_change",
    "title": "Short safety event title",
    "body": "Human-readable explanation for the orchestrator.",
    "severity": "low|medium|high|critical",
    "needsUserAction": false,
    "payload": {
      "field": "skill-specific structured details"
    }
  }
  ```
- Still report approved deviations and new interfaces in the final `ARC_AGENT_COMPLETION_JSON`.
- Look up context before asking unnecessary questions, hand off completed work cleanly, and stop safely when you cannot continue.
- Read WorkflowGraph context when it is provided in shared context or the prompt.
- Do not directly mutate WorkflowGraph or emit WorkflowPatch JSON in v1. Route workflow plan changes back through the planner/orchestrator.
- Avoid sibling-agent conflicts and unrelated refactors.
- Do not merge.
- Do not run `git add`, `git commit`, `git push`, or `gh pr create`.
- The TypeScript runner owns committing, pushing, and pull request creation after your run exits.
- Do not delete sibling worktrees.
- Do not change branches.
- Run relevant tests when available.
- Produce a concise completion summary with what changed, files changed, tests run, known risks, branch, contract deviations, new interfaces, and `PR title: <short descriptive title>`.
- Use `arcctl orchestrate report-agent-done` if available, but do not require it.

See `references/child-agent-report.md`.
