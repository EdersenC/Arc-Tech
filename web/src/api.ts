export type ArcCardMode = "direct_agent" | "plan_card_only";
export type ArcStatus = "queued" | "running" | "completed" | "failed" | "planned";

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
  lastActivityAt: string;
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

export interface ImplementResponse {
  taskId: string | null;
  status: ArcStatus;
  rawStatus: string;
  title: string;
  branch: string | null;
  card: ArcCard;
}

export async function submitImplement(message: string, mode: ArcCardMode, x: number, y: number): Promise<ImplementResponse> {
  const response = await fetch("/api/implement", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      mode: mode === "direct_agent" ? "agent" : "plan_card_only",
      source: "excalidraw",
      x,
      y,
    }),
  });
  return parseJsonResponse(response);
}

export async function listTasks(): Promise<{ tasks: ArcTask[]; cards: ArcCard[] }> {
  const response = await fetch("/api/tasks");
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
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return body as T;
}
