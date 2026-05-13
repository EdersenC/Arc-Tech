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

`add_open_question` shape:

```json
{
  "op": "add_open_question",
  "question": {
    "id": "question-visual-style",
    "question": "Visual style?",
    "detail": "Choose the first visual target so implementation agents can split work correctly.",
    "status": "open",
    "allowMultiSelect": false,
    "options": [
      {
        "id": "option-visual-2d",
        "label": "2D top-down",
        "description": "Fastest to implement and test."
      }
    ],
    "recommendedOptionIds": ["option-visual-2d"],
    "recommendationRationale": "2D top-down is the safest first playable target.",
    "nodeIds": ["node-question-visual-style"],
    "createdAt": "2026-05-09T12:00:00.000Z",
    "updatedAt": "2026-05-09T12:00:00.000Z"
  }
}
```

Patch rules:
- Emit a patch only when graph semantics change.
- Preserve unrelated nodes, edges, decisions, risks, and questions.
- Prefer `mark_deprecated` or `replace_decision` when a user changes direction; do not erase history unless removal is explicitly correct.
- Include downstream consequences: requirements, architecture, risks, tests, deployment, and agent-task changes.
- Ask a question and emit no patch when the user input is materially ambiguous.
- Never include raw Excalidraw scene fields such as `elements`, `appState`, `files`, `x`, `y`, `width`, or `height`.
- Never put `nodeId`, `detail`, `options`, or `recommendedOptionIds` directly on an `add_open_question` operation. They belong inside `question`.
- Never use option `title` or `summary`; use `label` and `description`.
- Never put `createdAt`, `updatedAt`, `selectedOptionIds`, `selectedLabels`, or `sourcePatchId` inside `changes` for update operations.
- User answer metadata is orchestration history, not workflow patch state. Resolve answered questions with `resolve_open_question`.

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
