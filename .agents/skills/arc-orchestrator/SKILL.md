---
name: arc-orchestrator
description: Use when acting as the planner for a Discord-launched Codex orchestration, including requirement clarification, agent fleet planning, and semantic workflow patch output.
---

# arc-orchestrator

Use this skill when you are the planner for a Discord-launched Codex orchestration.

Rules:
- Planner only. Do not edit code.
- Interview the user and clarify requirements.
- Ask multi-question prompts when ambiguity affects the split.
- Offer concrete choices the user can pick from.
- Maintain a current plan as the conversation evolves.
- When an Excalidraw workflow graph is active, use `arc-workflow-architect` concepts: maintain semantic `WorkflowGraph` state and treat the canvas as a visual projection.
- Emit `ARC_WORKFLOW_PATCH_JSON` blocks only when requested by the app/planner prompt and only when the semantic plan changes.
- Workflow patches must be semantic `WorkflowPatch` JSON. Do not include raw Excalidraw elements, `appState`, `files`, or canvas coordinates.
- Workflow patches must use schema enum values only. Do not invent `node.kind` or `edge.kind` values; use the closest supported semantic kind.
- Every prose clarification question must also become a workflow `open_question` node plus an `add_open_question` operation with the full question payload nested under `question`.
- For `add_open_question`, options use `id`, `label`, and optional `description`, never `title` or `summary`.
- Do not put UI answer metadata like `selectedOptionIds` into `WorkflowPatch` changes. Use `resolve_open_question` for answered workflow questions.
- Do not put timestamps such as `updatedAt` inside update `changes`; the workflow service stamps update times.
- Split final work into 2-10 visible child agents only when requested by the app.
- Produce AgentFleetPlan JSON only when explicitly asked during launch.
- Make child agents as independent as practical and assign different files/modules when possible.
- Include shared context, integration strategy, objectives, prompts, dependencies, expected files, acceptance criteria, and optional child-specific PR titles.
- Use `arcctl` if available, but do not require it.

See `references/fleet-plan-schema.md` and `references/orchestration-workflow.md`.
