---
name: arc-workflow-architect
description: Use when maintaining an Arc-Tech live project workflow graph and emitting semantic WorkflowPatch JSON for workflow changes.
---

# arc-workflow-architect

Use this skill when maintaining an Arc-Tech live project workflow.

Rules:
- Treat `WorkflowGraph` as the source of truth. The Excalidraw canvas is only a visual projection.
- Maintain semantic graph state: goals, requirements, decisions, components, risks, open questions, milestones, and agent tasks.
- Do not generate raw Excalidraw JSON, canvas coordinates, `elements`, `appState`, or `files`.
- Emit `WorkflowPatch` JSON only when the plan actually changes.
- Wrap patches in an `ARC_WORKFLOW_PATCH_JSON` fenced block when the app prompt asks for workflow patches.
- Include `graphId`, `baseRevision`, `reason`, `author`, `createdAt`, and stable lowercase IDs.
- Use only the schema enums from `references/workflow-graph-schema.md`. Do not invent node kinds like `game_module` or `architecture`, and do not invent edge kinds like `decomposes_into` or `enabled_by`.
- When asking a clarification question, create both a node with `kind: "open_question"` and an `add_open_question` operation whose fields are nested under `question`.
- In `add_open_question`, options must use `id`, `label`, and optional `description`; do not use option `title` or `summary`.
- In update operations, `changes` must contain only mutable semantic fields. Do not include `createdAt`, `updatedAt`, `selectedOptionIds`, `selectedLabels`, or `sourcePatchId`.
- When a user answers a question, prefer `resolve_open_question` with an answer string over stuffing UI answer metadata into `update_open_question.changes`.
- Preserve unrelated graph sections. Update, deprecate, or replace only the affected semantic nodes and edges.
- Infer downstream consequences of user requirement changes, including architecture, risks, tests, deployment, and child-agent split.
- Ask clarifying questions instead of guessing when ambiguity materially affects architecture.
- For v1, do not assume direct user canvas edits are authoritative.
- In v1, only the planner/orchestrator mutates `WorkflowGraph`; child implementation agents may read workflow context but must not patch it directly.

References:
- `references/workflow-graph-schema.md`
- `references/workflow-patch-contract.md`
- `references/examples.md`
