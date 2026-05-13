import type { ArcPersistedWorkflowGraph } from "./workflows/api";

export type ArcCardMode =
  | "direct_agent"
  | "plan_card_only"
  | "orchestration_parent"
  | "orchestration_agent"
  | "orchestration_border"
  | "orchestration_question";
export type ArcStatus = "queued" | "running" | "completed" | "failed" | "planned";

export interface ArcLink {
  label: string;
  url: string;
}

export interface ArcCard {
  id: string;
  taskId: number | null;
  projectId: number | null;
  source: "excalidraw";
  mode: ArcCardMode;
  command: string;
  title: string;
  label: string;
  status: string;
  branch: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  links: ArcLink[];
  parentCardId?: string | null;
  metadata?: ArcCardMetadata | null;
  progress?: ArcTaskProgress;
  createdAt: string;
  updatedAt: string;
}

export interface ArcCardMetadata {
  type?: string;
  orchestrationId?: number;
  projectId?: number;
  taskId?: number;
  parentOrchestrationId?: number;
  agentIndex?: number;
  agentName?: string;
  agentRole?: string;
  goal?: string;
  planSummary?: string;
  questionId?: string;
  status?: string;
}

export interface ArcTaskProgress {
  rawStatus: string;
  phase: string;
  activity: string;
  currentCommand: string | null;
  changedFiles: string[];
  recentEvents: string[];
  messageCounts: {
    queued: number;
    processing: number;
    processed: number;
    failed: number;
  };
  error: string | null;
  summary: string | null;
  pullRequestUrl: string | null;
  pullRequestFeedback: ArcPullRequestFeedbackProgress | null;
  lastActivityAt: string;
}

export interface ArcPullRequestFeedbackProgress {
  state: "queued" | "resolving" | "resolved" | "failed";
  total: number;
  active: number;
  reacted: number;
  reactionFailed: number;
  latestAt: string | null;
  lastError: string | null;
}

export interface ArcPullRequestFeedbackSummary {
  taskId: number;
  total: number;
  queued: number;
  processing: number;
  processed: number;
  failed: number;
  reacted: number;
  reactionFailed: number;
  latestFeedbackAt: string | null;
  latestDeliveredAt: string | null;
  lastError: string | null;
}

export interface ArcTask {
  taskId: string;
  numericTaskId: number;
  status: ArcStatus;
  rawStatus: string;
  title: string;
  branch: string | null;
  prompt: string;
  progress: ArcTaskProgress;
  card: ArcCard | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArcProject {
  projectId: number;
  projectName: string;
  projectSlug: string;
  channelId: string;
  repoPath: string;
  worktreesPath: string;
  remoteStatus: "missing" | "configured" | "skipped";
  remoteUrl: string | null;
  githubPrEnabled: boolean;
  githubPrFeedbackEnabled: boolean;
  githubBaseBranch: string;
  githubRemote: string;
  prReady: boolean;
  blockers: string[];
  taskCount: number;
}

export interface ArcTaskMessage {
  id: number;
  taskId: number;
  discordMessageId: string | null;
  discordAuthorId: string | null;
  role: "user";
  content: string;
  status: "queued" | "processing" | "processed" | "failed";
  createdAt: string;
  processedAt: string | null;
}

export interface ArcCodexEvent {
  eventType: string;
  itemType: string | null;
  payloadJson: string;
  createdAt: string;
}

export interface ArcPullRequestFeedbackEvent {
  id: number;
  trackedPrId: number;
  taskId: number;
  externalId: string;
  kind: string;
  author: string | null;
  body: string;
  htmlUrl: string | null;
  path: string | null;
  line: number | null;
  reviewState: string | null;
  githubCreatedAt: string | null;
  githubUpdatedAt: string | null;
  deliveredTaskMessageId: number | null;
  deliveredAt: string | null;
  reactionStatus: string;
  reactionError: string | null;
  reactedAt: string | null;
  createdAt: string;
}

export interface ArcTaskDetail extends ArcTask {
  project: ArcProject | null;
  projectId: number;
  projectName: string | null;
  projectTaskNumber: number;
  guildId: string;
  channelId: string;
  mode: string;
  sandbox: string;
  model: string;
  effort: string;
  mergeStatus: string;
  baseBranch: string | null;
  taskBranch: string | null;
  worktreePath: string | null;
  codexThreadId: string | null;
  discordThreadId: string | null;
  discordThreadUrl: string | null;
  pullRequestUrl: string | null;
  finalSummary: string | null;
  completionSummary: string | null;
  error: string | null;
  latestPhase: string;
  latestActivity: string;
  currentCommand: string | null;
  changedFiles: string[];
  messageCounts: ArcTaskProgress["messageCounts"];
  messages: ArcTaskMessage[];
  codexEvents: ArcCodexEvent[];
  pullRequestFeedback: {
    summary: ArcPullRequestFeedbackSummary | null;
    events: ArcPullRequestFeedbackEvent[];
  };
}

export interface ArcPlannerOption {
  id: string;
  label: string;
  description?: string;
}

export interface ArcPlannerQuestion {
  id: string;
  text: string;
  allowMultiSelect: boolean;
  options: ArcPlannerOption[];
}

export interface ArcPlannerQuestionAnswer {
  selectedOptionIds: string[];
  selectedLabels: string[];
  customText?: string;
  content: string;
  createdAt: string;
  source?: string;
}

export interface ArcPlannerQuestionMessage {
  id: number;
  role: "user" | "planner" | "system";
  content: string;
  createdAt: string;
}

export interface ArcPlannerQuestionView extends ArcPlannerQuestion {
  source: "planner" | "workflow";
  status: "open" | "answered" | "resolved" | "deprecated";
  answer: ArcPlannerQuestionAnswer | null;
  workflowNodeId?: string;
  detail?: string;
  recommendedOptionIds?: string[];
  recommendationRationale?: string;
  messages: ArcPlannerQuestionMessage[];
}

export interface ArcOrchestrationMessage {
  id: number;
  role: "user" | "planner" | "system";
  content: string;
  metadata?: {
    kind?: string;
    question?: ArcPlannerQuestion;
    selectedLabels?: string[];
    selectedOptionIds?: string[];
    readySummary?: string;
    plan?: unknown;
    workflow?: unknown;
    workflowPatch?: ArcWorkflowPatchStatus;
    plannerPrompt?: string;
  } | null;
  createdAt: string;
}

export interface ArcWorkflowPatchStatus {
  status?: "none" | "applied" | "rejected" | string;
  patchId?: string;
  reason?: string;
  baseRevision?: number;
  resultingRevision?: number;
  error?: string;
}

export interface ArcOrchestrationAgent {
  id: number;
  orchestrationId: number;
  childTaskId: number | null;
  agentIndex: number;
  agentName: string;
  role: string;
  prompt: string;
  status: string;
  branchName: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  completionSummary: string | null;
}

export interface ArcOrchestration {
  id: number;
  projectId: number;
  projectName: string | null;
  projectSlug: string | null;
  repoPath: string | null;
  worktreesPath: string | null;
  remoteStatus: string | null;
  remoteUrl: string | null;
  status: string;
  goal: string;
  parentCardId: string | null;
  borderCardId: string | null;
  finalPlanJson: string | null;
  finalPlan?: {
    orchestrationGoal?: string;
    architectureSummary?: string;
    agentCount?: number;
    sharedContext?: string;
    integrationStrategy?: string;
    agents?: Array<{ name?: string; role?: string; objective?: string; prompt?: string; acceptanceCriteria?: string[] }>;
  } | null;
  latestQuestion?: ArcPlannerQuestion | null;
  questions?: ArcPlannerQuestionView[];
  workflow?: ArcPersistedWorkflowGraph | null;
  latestWorkflowPatch?: ArcWorkflowPatchStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArcOrchestrationView {
  orchestration: ArcOrchestration;
  messages: ArcOrchestrationMessage[];
  agents: ArcOrchestrationAgent[];
  parentCard: ArcCard | null;
  borderCard: ArcCard | null;
  childCards: ArcCard[];
  questionCards?: ArcCard[];
  aggregate: {
    total: number;
    done: number;
    running: number;
    failed: number;
    branches: string[];
    prs: string[];
  };
}

export type ArcCanvasPromptCommandKind =
  | "orchestrate"
  | "implement"
  | "plan"
  | "answer"
  | "continue_planning"
  | "start_work"
  | "remake_plan";
export type ArcCanvasPromptStatus = "draft" | "linked" | "waiting_for_body" | "sending" | "sent" | "failed" | "dirty" | "historical";
export type ArcCanvasPromptTargetKind = "workflow_node" | "open_question" | "task_card" | "orchestration_parent";
export type ArcCanvasPromptLinkKind = "workflow_dispatch" | "question_answer" | "question_context" | "plan_control";
export type ArcCanvasPromptLinkStatus = "linked" | "waiting_for_body" | "sending" | "sent" | "failed" | "dirty" | "historical";

export interface ArcCanvasPromptNode {
  id: string;
  projectId: number;
  ownerId: string;
  ownerLabel: string;
  commandKind: ArcCanvasPromptCommandKind;
  commandText: string;
  body: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status: ArcCanvasPromptStatus;
  lastDispatchHash: string | null;
  lastDispatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ArcCanvasPromptLink {
  id: string;
  projectId: number;
  promptNodeId: string;
  linkKind: ArcCanvasPromptLinkKind;
  ownerId: string;
  sourceKind: string | null;
  sourceId: string | null;
  targetKind: ArcCanvasPromptTargetKind;
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
  status: ArcCanvasPromptLinkStatus;
  dispatchHash: string | null;
  dispatchedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ArcCanvasPromptBundle {
  prompts: ArcCanvasPromptNode[];
  links: ArcCanvasPromptLink[];
}

export interface ImplementResponse {
  taskId: string | null;
  status: ArcStatus;
  rawStatus: string;
  title: string;
  branch: string | null;
  card: ArcCard;
}

export interface ConnectProjectRemoteResponse {
  project: ArcProject;
  baseBranch: string;
  summary: string;
}

export async function submitImplement(message: string, mode: ArcCardMode, projectId: number, x: number, y: number): Promise<ImplementResponse> {
  const response = await fetch("/api/implement", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      mode: mode === "direct_agent" ? "agent" : "plan_card_only",
      source: "excalidraw",
      projectId,
      x,
      y,
    }),
  });
  return parseJsonResponse(response);
}

export async function submitOrchestrate(
  message: string,
  projectId: number,
  x: number,
  y: number,
): Promise<{ orchestration: ArcOrchestrationView; card: ArcCard; workflow?: ArcPersistedWorkflowGraph }> {
  const response = await fetch("/api/orchestrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, projectId, x, y }),
  });
  return parseJsonResponse(response);
}

export async function getOrchestration(orchestrationId: number): Promise<ArcOrchestrationView> {
  const response = await fetch(`/api/orchestrations/${encodeURIComponent(String(orchestrationId))}`);
  return parseJsonResponse(response);
}

export async function answerOrchestrationQuestion(
  orchestrationId: number,
  questionId: string,
  selectedOptionIds: string[],
  customText = "",
): Promise<ArcOrchestrationView> {
  const response = await fetch(
    `/api/orchestrations/${encodeURIComponent(String(orchestrationId))}/questions/${encodeURIComponent(questionId)}/answer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selectedOptionIds, customText }),
    },
  );
  return parseJsonResponse(response);
}

export async function sendOrchestrationQuestionMessage(
  orchestrationId: number,
  questionId: string,
  payload: { content?: string; selectedOptionIds?: string[]; customText?: string },
): Promise<ArcOrchestrationView> {
  const response = await fetch(
    `/api/orchestrations/${encodeURIComponent(String(orchestrationId))}/questions/${encodeURIComponent(questionId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return parseJsonResponse(response);
}

export async function updateOrchestrationPlan(orchestrationId: number): Promise<ArcOrchestrationView> {
  const response = await fetch(`/api/orchestrations/${encodeURIComponent(String(orchestrationId))}/plan/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  return parseJsonResponse(response);
}

export async function remakeOrchestrationPlan(orchestrationId: number): Promise<ArcOrchestrationView> {
  const response = await fetch(`/api/orchestrations/${encodeURIComponent(String(orchestrationId))}/plan/remake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  return parseJsonResponse(response);
}

export async function sendOrchestrationMessage(orchestrationId: number, content: string): Promise<ArcOrchestrationView> {
  const response = await fetch(`/api/orchestrations/${encodeURIComponent(String(orchestrationId))}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return parseJsonResponse(response);
}

export async function launchOrchestration(
  orchestrationId: number,
  x: number,
  y: number,
): Promise<{ orchestration: ArcOrchestrationView; cards: ArcCard[]; requiresApproval?: boolean }> {
  const response = await fetch(`/api/orchestrations/${encodeURIComponent(String(orchestrationId))}/launch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x, y }),
  });
  return parseJsonResponse(response);
}

export async function listProjects(): Promise<{ projects: ArcProject[] }> {
  const response = await fetch("/api/excalidraw/projects");
  return parseJsonResponse(response);
}

export async function createProject(name: string): Promise<{ project: ArcProject }> {
  const response = await fetch("/api/excalidraw/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return parseJsonResponse(response);
}

export async function getProject(projectId?: number): Promise<{ project: ArcProject }> {
  const response = await fetch(`/api/excalidraw/project${projectId ? `?projectId=${encodeURIComponent(String(projectId))}` : ""}`);
  return parseJsonResponse(response);
}

export async function connectProjectRemote(projectId: number, remoteUrl: string): Promise<ConnectProjectRemoteResponse> {
  const response = await fetch("/api/excalidraw/project/remote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, remoteUrl }),
  });
  return parseJsonResponse(response);
}

export async function listTasks(projectId: number): Promise<{ tasks: ArcTask[]; cards: ArcCard[] }> {
  const response = await fetch(`/api/tasks?projectId=${encodeURIComponent(String(projectId))}`);
  return parseJsonResponse(response);
}

export async function getTaskHistory(taskId: number): Promise<ArcTaskDetail> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(String(taskId))}/history`);
  return parseJsonResponse(response);
}

export async function sendTaskMessage(taskId: number, content: string): Promise<ArcTaskDetail> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(String(taskId))}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, source: "excalidraw" }),
  });
  return parseJsonResponse(response);
}

export async function updateCardPosition(card: Pick<ArcCard, "id" | "x" | "y" | "width" | "height">): Promise<void> {
  const response = await fetch(`/api/excalidraw/cards/${encodeURIComponent(card.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x: card.x, y: card.y, width: card.width, height: card.height }),
  });
  await parseJsonResponse(response);
}

export async function listCanvasPrompts(projectId: number): Promise<ArcCanvasPromptBundle> {
  const response = await fetch(`/api/projects/${encodeURIComponent(String(projectId))}/canvas-prompts`);
  return parseJsonResponse(response);
}

export async function createCanvasPrompt(
  projectId: number,
  prompt: {
    ownerId: string;
    ownerLabel: string;
    commandKind: ArcCanvasPromptCommandKind;
    body?: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
  },
): Promise<{ prompt: ArcCanvasPromptNode }> {
  const response = await fetch(`/api/projects/${encodeURIComponent(String(projectId))}/canvas-prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prompt),
  });
  return parseJsonResponse(response);
}

export async function updateCanvasPrompt(
  promptId: string,
  changes: Partial<Pick<ArcCanvasPromptNode, "ownerId" | "ownerLabel" | "commandKind" | "commandText" | "body" | "x" | "y" | "width" | "height">> & { text?: string },
): Promise<{ prompt: ArcCanvasPromptNode }> {
  const response = await fetch(`/api/canvas-prompts/${encodeURIComponent(promptId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(changes),
  });
  return parseJsonResponse(response);
}

export async function deleteCanvasPrompt(promptId: string): Promise<void> {
  const response = await fetch(`/api/canvas-prompts/${encodeURIComponent(promptId)}`, { method: "DELETE" });
  await parseJsonResponse(response);
}

export async function createCanvasPromptLink(
  projectId: number,
  link: {
    promptNodeId: string;
    ownerId: string;
    linkKind?: ArcCanvasPromptLinkKind;
    sourceKind?: string | null;
    sourceId?: string | null;
    targetKind: ArcCanvasPromptTargetKind;
    targetId: string;
    orchestrationId?: number | null;
    questionId?: string | null;
    workflowGraphId?: string | null;
    workflowNodeId?: string | null;
    taskId?: number | null;
    cardId?: string | null;
    targetOrchestrationId?: number | null;
    targetWorkflowGraphId?: string | null;
    targetWorkflowNodeId?: string | null;
    arrowElementId?: string;
  },
): Promise<{ link: ArcCanvasPromptLink }> {
  const response = await fetch(`/api/projects/${encodeURIComponent(String(projectId))}/canvas-prompt-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(link),
  });
  return parseJsonResponse(response);
}

export async function deleteCanvasPromptLink(linkId: string): Promise<void> {
  const response = await fetch(`/api/canvas-prompt-links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
  await parseJsonResponse(response);
}

export async function dispatchCanvasPromptLink(linkId: string): Promise<{
  prompt: ArcCanvasPromptNode;
  link: ArcCanvasPromptLink;
  orchestration?: ArcOrchestrationView;
  card?: ArcCard;
  cards?: ArcCard[];
  workflow?: ArcPersistedWorkflowGraph;
}> {
  const response = await fetch(`/api/canvas-prompt-links/${encodeURIComponent(linkId)}/dispatch`, { method: "POST" });
  return parseJsonResponse(response);
}

export async function logCanvasDebugEvent(event: Record<string, unknown>): Promise<void> {
  const response = await fetch("/api/canvas-debug-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  await parseJsonResponse(response);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string; project?: ArcProject };
  if (!response.ok) {
    const suffix = body.code ? ` (${body.code})` : "";
    throw new Error(`${body.error ?? `Request failed with ${response.status}`}${suffix}`);
  }
  return body as T;
}
