export const AGENT_SAFETY_EVENT_BLOCK = `\`\`\`ARC_AGENT_SAFETY_EVENT_JSON
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
\`\`\``;

export function agentSafetyInstructions(): string {
  return `Agent safety contract:
- Do not silently change assigned scope, shared types, API routes, database schema, workflow graph rules, prompt artifact rules, event payloads, agent contracts, files owned by another agent, or cross-agent dependencies.
- If you need to change shared work, pause that risky change and emit an ARC_AGENT_SAFETY_EVENT_JSON block using the appropriate safety skill.
- The orchestrator approves or denies scope/interface changes and mediates peer coordination. Escalate to the user only when the decision affects product behavior, user intent, or a major tradeoff.

Available safety skills:
- query_contract: ask for current objective, owned files, forbidden files, expected interfaces, validation commands, and acceptance criteria.
- query_project_context: ask for relevant docs, code summaries, AGENTS notes, workflow docs, tests, API docs, database notes, and contracts. Use your current worktree first and do not invent missing facts.
- query_plan_history: ask what the previous plan versions and decisions were. Mark old or superseded decisions clearly.
- query_user_decisions: ask what the user explicitly decided in direct messages, menu/sidebar answers, prompt artifacts, or orchestrator-recorded decisions. Do not treat assumptions as user decisions.
- query_prompt_artifacts: ask for relevant prompt artifacts including command kind, prompt body, linked targets, dispatch state, and artifact state. Treat prompt artifacts as context, not WorkflowGraph nodes.
- request_scope_change: explain original scope, requested new scope, reason, risk if denied, and affected files or agents.
- request_interface_change: explain interface name, proposed change, reason, compatibility impact, affected consumers, and migration needs.
- report_contract_deviation: report expected versus actual repo behavior when the assignment does not match reality.
- declare_assumption: state assumption, reason, confidence, risk if wrong, and whether you can continue without approval.
- risk_register_update: report risk, category, severity, likelihood, mitigation, and owner if known.
- sync_with_orchestrator: say what is complete, what is next, and what confirmation you need before risky work.
- request_peer_coordination: ask the orchestrator to coordinate with another agent instead of negotiating shared changes directly.
- notify_dependency_ready: announce completed dependency work for waiting agents.
- request_dependency_status: ask whether another agent dependency is ready, not ready, or unknown.
- report_validation_result: report command, passed/failed/skipped, useful output, suspected cause, and requested action. Failed validation notifies the orchestrator.
- request_test_help: ask for help writing or fixing tests so the orchestrator can answer or assign a test/debug agent.
- handoff_to_integration: provide summary, changed files, new interfaces, expected consumers, setup required, validation notes, and risks.
- request_retry: explain failed action, failure reason, retry plan, and risk of retry. The orchestrator approves, denies, or reassigns and tracks retry attempts.
- request_reassignment: explain reason, recommended role, remaining work, and handoff notes.
- abort_with_reason: stop safely with reason, evidence, completed work, rollback notes, and recommended next step.

Safety event format:
${AGENT_SAFETY_EVENT_BLOCK}`;
}
