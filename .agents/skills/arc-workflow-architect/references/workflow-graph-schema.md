# WorkflowGraph Schema

`WorkflowGraph` is semantic project state. It is not an Excalidraw scene.

Required graph fields:
- `id`: stable lowercase graph id.
- `projectId`: optional stable project id.
- `title`, `description`.
- `revision`: integer current revision.
- `nodes`: semantic `WorkflowNode[]`.
- `edges`: semantic `WorkflowEdge[]`.
- `decisions`, `risks`, `openQuestions`, `layoutHints`, `revisions`.
- `createdAt`, `updatedAt`.

Node fields:
- `id`: stable lowercase id.
- `kind`: `goal`, `requirement`, `decision`, `system_component`, `frontend_component`, `backend_component`, `data_store`, `external_service`, `agent_task`, `milestone`, `risk`, `open_question`, or `note`.
- `status`: `proposed`, `active`, `in_progress`, `blocked`, `complete`, or `deprecated`.
- `title`, optional `summary`, `body`, `tags`, `owner`.
- `createdAt`, `updatedAt`.

Edge fields:
- `id`: stable lowercase id.
- `kind`: `depends_on`, `implements`, `contains`, `blocks`, `relates_to`, `replaces`, `answers`, `mitigates`, `produces`, or `consumes`.
- `fromNodeId`, `toNodeId`.
- Optional `label`, `status`, replacement/deprecation fields.
- `createdAt`, `updatedAt`.

Integrity rules:
- Node, edge, decision, risk, question, and layout hint IDs must be unique within their collections.
- Edges must point to existing nodes.
- Decision, risk, question, and layout references must point to existing IDs.
- Stable IDs are lowercase and do not depend on screen position.
