export type ArcCardMode = "direct_agent" | "plan_card_only";
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
  progress?: ArcTaskProgress;
  createdAt: string;
  updatedAt: string;
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

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string; project?: ArcProject };
  if (!response.ok) {
    const suffix = body.code ? ` (${body.code})` : "";
    throw new Error(`${body.error ?? `Request failed with ${response.status}`}${suffix}`);
  }
  return body as T;
}
