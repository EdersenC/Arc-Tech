# WorkflowPatch Contract

A `WorkflowPatch` is the only planner-owned mutation contract for workflow v1.

Required patch fields:
- `id`: stable patch id.
- `graphId`: current workflow graph id.
- `baseRevision`: current graph revision. Required unless creating a graph.
- `reason`: concise reason for the semantic change.
- `author`: normally `planner`.
- `createdAt`: ISO timestamp.
- `operations`: one or more semantic operations.

Supported operations:
- `create_graph`
- `add_node`, `update_node`, `remove_node`
- `add_edge`, `update_edge`, `remove_edge`
- `replace_decision`
- `mark_deprecated`
- `add_risk`
- `add_open_question`
- `resolve_open_question`
- `relayout_section`

Patch rules:
- Emit a patch only when graph semantics change.
- Preserve unrelated nodes, edges, decisions, risks, and questions.
- Prefer `mark_deprecated` or `replace_decision` when a user changes direction; do not erase history unless removal is explicitly correct.
- Include downstream consequences: requirements, architecture, risks, tests, deployment, and agent-task changes.
- Ask a question and emit no patch when the user input is materially ambiguous.
- Never include raw Excalidraw scene fields such as `elements`, `appState`, `files`, `x`, `y`, `width`, or `height`.

Planner block format:

```ARC_WORKFLOW_PATCH_JSON
{
  "id": "patch-short-purpose-rev-3",
  "graphId": "workflow-project-1-orchestration-9",
  "baseRevision": 3,
  "reason": "Short semantic reason.",
  "author": "planner",
  "createdAt": "2026-05-09T12:00:00.000Z",
  "operations": []
}
```
