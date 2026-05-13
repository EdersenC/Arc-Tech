export type CanvasPromptCommandKind =
  | "orchestrate"
  | "implement"
  | "plan"
  | "answer"
  | "continue_planning"
  | "start_work"
  | "remake_plan";
export type CanvasPromptStatus = "draft" | "linked" | "waiting_for_body" | "sending" | "sent" | "failed" | "dirty" | "historical";
export type CanvasPromptTargetKind = "workflow_node" | "open_question" | "task_card" | "orchestration_parent";
export type CanvasPromptLinkKind = "workflow_dispatch" | "question_answer" | "question_context" | "plan_control";
export type CanvasPromptLinkStatus = "linked" | "waiting_for_body" | "sending" | "sent" | "failed" | "dirty" | "historical";

export interface CanvasPromptNode {
  id: string;
  projectId: number;
  ownerId: string;
  ownerLabel: string;
  commandKind: CanvasPromptCommandKind;
  commandText: string;
  body: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status: CanvasPromptStatus;
  lastDispatchHash: string | null;
  lastDispatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CanvasPromptLink {
  id: string;
  projectId: number;
  promptNodeId: string;
  linkKind: CanvasPromptLinkKind;
  ownerId: string;
  sourceKind: string | null;
  sourceId: string | null;
  targetKind: CanvasPromptTargetKind;
  targetId: string;
  orchestrationId: number | null;
  questionId: string | null;
  workflowGraphId: string | null;
  workflowNodeId: string | null;
  taskId: number | null;
  cardId: string | null;
  targetOrchestrationId?: number | null;
  targetWorkflowGraphId?: string | null;
  targetWorkflowNodeId?: string | null;
  arrowElementId: string;
  status: CanvasPromptLinkStatus;
  dispatchHash: string | null;
  dispatchedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CanvasPromptBundle {
  prompts: CanvasPromptNode[];
  links: CanvasPromptLink[];
}
