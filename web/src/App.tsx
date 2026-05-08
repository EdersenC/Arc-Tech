import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  connectProjectRemote,
  getProject,
  listTasks,
  submitImplement,
  updateCardPosition,
  type ArcCard,
  type ArcCardMode,
  type ArcProject,
} from "./api";

type ExcalidrawApi = {
  updateScene: (scene: { elements: readonly unknown[] }) => void;
  getSceneElements: () => readonly ArcElement[];
};

type ArcElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  customData?: {
    arc?: {
      cardId?: string;
      type?: string;
      taskId?: string | null;
      source?: string;
      command?: string;
      status?: string;
      phase?: string;
      activity?: string;
      lastActivityAt?: string;
    };
  };
};

export default function App() {
  const excalidrawApiRef = useRef<ExcalidrawApi | null>(null);
  const cardsRef = useRef<ArcCard[]>([]);
  const persistTimerRef = useRef<number | null>(null);
  const [cards, setCards] = useState<ArcCard[]>([]);
  const [command, setCommand] = useState("/implement ");
  const [mode, setMode] = useState<ArcCardMode>("direct_agent");
  const [project, setProject] = useState<ArcProject | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);

  const applyCardsToScene = useCallback((nextCards: ArcCard[]) => {
    cardsRef.current = nextCards;
    setCards(nextCards);
    const api = excalidrawApiRef.current;
    if (!api) return;
    const current = api.getSceneElements();
    const nonArcElements = current.filter((element) => !isArcElement(element));
    api.updateScene({ elements: [...nonArcElements, ...cardsToElements(nextCards)] });
  }, []);

  const refresh = useCallback(async () => {
    const [tasksResponse, projectResponse] = await Promise.all([listTasks(), getProject()]);
    applyCardsToScene(tasksResponse.cards);
    setProject(projectResponse.project);
    setRemoteUrl((current) => current || projectResponse.project.remoteUrl || "");
    setError(null);
    setStatus(`${taskStatusLine(tasksResponse)} · ${projectStatusLine(projectResponse.project)}`);
  }, [applyCardsToScene]);

  useEffect(() => {
    void refresh().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : String(refreshError)));
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : String(refreshError)));
    }, 4000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const trimmed = command.trim();
    if (!/^\/implement(?:\s+|$)/i.test(trimmed)) {
      setError("Use /implement <message>.");
      return;
    }
    if (/^\/implement\s*$/i.test(trimmed)) {
      setError("Use /implement with a non-empty message.");
      return;
    }
    if (mode === "direct_agent" && (!project || !project.prReady)) {
      setError(projectBlockerText(project));
      return;
    }

    setBusy(true);
    try {
      const response = await submitImplement(trimmed, mode, nextCardX(cards.length), nextCardY(cards.length));
      applyCardsToScene([response.card, ...cardsRef.current.filter((card) => card.id !== response.card.id)]);
      setCommand("/implement ");
      setStatus(
        mode === "direct_agent"
          ? `Created task ${response.taskId} (${response.status})`
          : "Created plan card",
      );
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectRemote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const trimmed = remoteUrl.trim();
    if (!trimmed) {
      setError("Enter a GitHub remote URL before connecting the repo.");
      return;
    }

    setConnecting(true);
    try {
      const response = await connectProjectRemote(trimmed);
      setProject(response.project);
      setRemoteUrl(response.project.remoteUrl ?? trimmed);
      setStatus(`Connected repo. ${response.summary}`);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : String(connectError));
    } finally {
      setConnecting(false);
    }
  }

  function handleSceneChange(elements: readonly ArcElement[]) {
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      const updates = changedCardPositions(elements, cardsRef.current);
      for (const update of updates) {
        void updateCardPosition(update).catch((positionError) => {
          setError(positionError instanceof Error ? positionError.message : String(positionError));
        });
      }
      if (updates.length > 0) {
        cardsRef.current = cardsRef.current.map((card) => updates.find((update) => update.id === card.id) ?? card);
        setCards(cardsRef.current);
      }
    }, 600);
  }

  const directAgentBlocked = mode === "direct_agent" && (!project || !project.prReady);

  return (
    <div className="arc-shell">
      <div className="top-panel">
        <form className="command-panel" onSubmit={handleSubmit}>
          <div className="brand-block">
            <div className="brand-title">Arc-Tech Canvas</div>
            <div className="brand-subtitle">Visual command surface for implementation tasks</div>
          </div>
          <div className="mode-group" role="group" aria-label="Mode">
            <button
              type="button"
              className={mode === "direct_agent" ? "active" : ""}
              onClick={() => setMode("direct_agent")}
            >
              Direct Agent
            </button>
            <button
              type="button"
              className={mode === "plan_card_only" ? "active" : ""}
              onClick={() => setMode("plan_card_only")}
            >
              Plan Card Only
            </button>
          </div>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="/implement Add a health check endpoint"
            spellCheck={false}
          />
          <button className="submit-button" type="submit" disabled={busy || connecting || directAgentBlocked}>
            {busy ? "Submitting" : "Run"}
          </button>
          <button className="refresh-button" type="button" onClick={() => void refresh()} disabled={busy || connecting}>
            Refresh
          </button>
          <div className="status-strip" aria-live="polite">
            {error ?? status}
          </div>
        </form>
        <form className="repo-panel" onSubmit={handleConnectRemote}>
          <div className={`repo-state ${project?.prReady ? "ready" : "blocked"}`}>
            <strong>{project?.prReady ? "PR ready" : "PR blocked"}</strong>
            <span>{project ? projectStatusLine(project) : "Loading repo status"}</span>
          </div>
          <input
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
            placeholder="https://github.com/owner/repo.git"
            spellCheck={false}
            aria-label="Git remote URL"
          />
          <button className="connect-button" type="submit" disabled={connecting || busy}>
            {connecting ? "Connecting" : "Connect Repo"}
          </button>
        </form>
      </div>
      <div className="canvas-frame">
        <Excalidraw
          excalidrawAPI={(api) => {
            excalidrawApiRef.current = api as unknown as ExcalidrawApi;
            if (cardsRef.current.length > 0) {
              applyCardsToScene(cardsRef.current);
            }
          }}
          onChange={(elements) => handleSceneChange(elements as readonly ArcElement[])}
          initialData={{ appState: { viewBackgroundColor: "#f7f4ee" } }}
        />
      </div>
    </div>
  );
}

function cardsToElements(cards: ArcCard[]) {
  return convertToExcalidrawElements(
    cards.flatMap((card) => {
      const metadata = {
        arc: {
          type: card.mode === "plan_card_only" ? "plan" : "task",
          taskId: card.taskId ? String(card.taskId) : null,
          cardId: card.id,
          source: "excalidraw",
          command: "/implement",
          status: card.status,
          phase: card.progress?.phase,
          activity: card.progress?.activity,
          lastActivityAt: card.progress?.lastActivityAt,
        },
      };
      return [
        {
          id: rectElementId(card.id),
          type: "rectangle",
          x: card.x,
          y: card.y,
          width: card.width,
          height: card.height,
          strokeColor: strokeFor(card.status),
          backgroundColor: backgroundFor(card.status),
          fillStyle: "solid",
          roughness: 1,
          opacity: 100,
          roundness: { type: 3 },
          groupIds: [card.id],
          customData: metadata,
        },
        {
          id: textElementId(card.id),
          type: "text",
          x: card.x + 18,
          y: card.y + 18,
          width: card.width - 36,
          height: card.height - 36,
          text: card.label,
          fontSize: 16,
          fontFamily: 1,
          textAlign: "left",
          verticalAlign: "top",
          strokeColor: "#1f2937",
          backgroundColor: "transparent",
          groupIds: [card.id],
          customData: metadata,
        },
      ];
    }) as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: false },
  );
}

function changedCardPositions(elements: readonly ArcElement[], cards: ArcCard[]): ArcCard[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return elements
    .filter((element) => isArcElement(element) && element.id.startsWith("arc-card-") && !element.id.endsWith("-text"))
    .map((element) => {
      const cardId = element.customData?.arc?.cardId;
      const card = cardId ? byId.get(cardId) : null;
      if (!card) return null;
      const next = {
        ...card,
        x: Math.round(element.x),
        y: Math.round(element.y),
        width: Math.round(element.width),
        height: Math.round(element.height),
      };
      return samePosition(card, next) ? null : next;
    })
    .filter((card): card is ArcCard => Boolean(card));
}

function isArcElement(element: ArcElement): boolean {
  return element.customData?.arc?.source === "excalidraw";
}

function samePosition(left: ArcCard, right: ArcCard): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function rectElementId(cardId: string): string {
  return `arc-card-${cardId}`;
}

function textElementId(cardId: string): string {
  return `arc-card-${cardId}-text`;
}

function nextCardX(count: number): number {
  return 80 + (count % 3) * 410;
}

function nextCardY(count: number): number {
  return 90 + Math.floor(count / 3) * 230;
}

function strokeFor(status: string): string {
  if (status === "running") return "#2563eb";
  if (status === "completed") return "#15803d";
  if (status === "failed") return "#b91c1c";
  if (status === "planned") return "#7c3aed";
  return "#475569";
}

function backgroundFor(status: string): string {
  if (status === "running") return "#dbeafe";
  if (status === "completed") return "#dcfce7";
  if (status === "failed") return "#fee2e2";
  if (status === "planned") return "#ede9fe";
  return "#f8fafc";
}

function taskStatusLine(response: { tasks: Array<{ status: string; progress?: { lastActivityAt?: string } }>; cards: ArcCard[] }): string {
  const running = response.tasks.filter((task) => task.status === "running").length;
  const queued = response.tasks.filter((task) => task.status === "queued").length;
  const failed = response.tasks.filter((task) => task.status === "failed").length;
  const completed = response.tasks.filter((task) => task.status === "completed").length;
  const latest = latestActivity(response.cards);
  const parts = [
    `${response.cards.length} card${response.cards.length === 1 ? "" : "s"}`,
    running ? `${running} running` : null,
    queued ? `${queued} queued` : null,
    completed ? `${completed} completed` : null,
    failed ? `${failed} failed` : null,
    latest ? `last activity ${latest}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function latestActivity(cards: ArcCard[]): string | null {
  const latest = cards
    .map((card) => card.progress?.lastActivityAt ?? card.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  return latest ? latest.replace("T", " ").slice(0, 19) : null;
}

function projectStatusLine(project: ArcProject): string {
  const remote = project.remoteUrl ?? project.remoteStatus;
  const pr = project.githubPrEnabled ? "PR config on" : "PR config off";
  const ready = project.prReady ? "ready" : project.blockers.join(" ");
  return `${remote} · ${pr} · ${ready}`;
}

function projectBlockerText(project: ArcProject | null): string {
  if (!project) return "Project PR status is still loading.";
  return project.blockers.length ? project.blockers.join(" ") : "Project is ready.";
}
