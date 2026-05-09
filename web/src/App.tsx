import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import {
  answerOrchestrationQuestion,
  connectProjectRemote,
  createProject,
  getProject,
  getOrchestration,
  getTaskHistory,
  launchOrchestration,
  listProjects,
  listTasks,
  sendTaskMessage,
  sendOrchestrationMessage,
  submitImplement,
  submitOrchestrate,
  updateCardPosition,
  type ArcCard,
  type ArcCardMode,
  type ArcLink,
  type ArcOrchestrationView,
  type ArcPlannerQuestion,
  type ArcProject,
  type ArcTaskDetail,
} from "./api";
import { graphToExcalidrawElements, workflowNodeElementId } from "./workflows/workflowElements";
import { useWorkflowStream } from "./workflows/useWorkflowStream";
import type { ArcPersistedWorkflowGraph, ArcWorkflowNode } from "./workflows/api";

const ACTIVE_PROJECT_KEY = "arc-tech.excalidraw.activeProjectId";

type ExcalidrawApi = {
  updateScene: (scene: { elements?: readonly unknown[]; appState?: Partial<ArcAppState> }) => void;
  getSceneElements: () => readonly ArcElement[];
  getAppState: () => ArcAppState;
};

type ArcAppState = {
  scrollX?: number;
  scrollY?: number;
  zoom?: number | { value?: number };
  selectedElementIds?: Record<string, boolean>;
};

type ArcElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  link?: string | null;
  customData?: {
    arc?: {
      cardId?: string;
      type?: string;
      taskId?: string | null;
      orchestrationId?: number;
      source?: string;
      command?: string;
      status?: string;
      phase?: string;
      activity?: string;
      lastActivityAt?: string;
      feedbackState?: string | null;
      link?: string | null;
      linkLabel?: string | null;
    };
    arcWorkflow?: {
      graphId: string;
      projectId: number;
      orchestrationId: number | null;
      workflowNodeId?: string;
      workflowEdgeId?: string;
      semanticType: string;
      revision: number;
    };
  };
};

export default function App() {
  const excalidrawApiRef = useRef<ExcalidrawApi | null>(null);
  const canvasFrameRef = useRef<HTMLDivElement | null>(null);
  const cardsRef = useRef<ArcCard[]>([]);
  const activeProjectIdRef = useRef<number | null>(initialProjectId());
  const selectedCardIdRef = useRef<string | null>(null);
  const selectedWorkflowNodeIdRef = useRef<string | null>(null);
  const workflowGraphRef = useRef<ArcPersistedWorkflowGraph | null>(null);
  const selectedTaskIdRef = useRef<number | null>(initialTaskId());
  const selectedOrchestrationIdRef = useRef<number | null>(null);
  const initialDeepLinkTaskIdRef = useRef<number | null>(selectedTaskIdRef.current);
  const persistTimerRef = useRef<number | null>(null);
  const pendingPositionUpdatesRef = useRef<Map<string, ArcCard>>(new Map());
  const sceneApplyUntilRef = useRef(0);
  const spawnViewportRef = useRef({ key: "", count: 0 });
  const [cards, setCards] = useState<ArcCard[]>([]);
  const [projects, setProjects] = useState<ArcProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(activeProjectIdRef.current);
  const [command, setCommand] = useState("/implement ");
  const [mode, setMode] = useState<ArcCardMode>("direct_agent");
  const [project, setProject] = useState<ArcProject | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [selectedCard, setSelectedCard] = useState<ArcCard | null>(null);
  const [selectedWorkflowNode, setSelectedWorkflowNode] = useState<ArcWorkflowNode | null>(null);
  const [taskDetail, setTaskDetail] = useState<ArcTaskDetail | null>(null);
  const [orchestrationDetail, setOrchestrationDetail] = useState<ArcOrchestrationView | null>(null);
  const [chatMessage, setChatMessage] = useState("");
  const [orchestrationMessage, setOrchestrationMessage] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const workflowStream = useWorkflowStream(activeProjectId);

  const loadTaskDetail = useCallback(async (taskId: number) => {
    const detail = await getTaskHistory(taskId);
    setTaskDetail(detail);
    setError(null);
    return detail;
  }, []);

  const loadOrchestrationDetail = useCallback(async (orchestrationId: number) => {
    const detail = await getOrchestration(orchestrationId);
    setOrchestrationDetail(detail);
    setSelectedOptions(new Set());
    setError(null);
    return detail;
  }, []);

  const applyCardsToScene = useCallback((nextCards: ArcCard[]) => {
    const mergedCards = mergeCardsWithLocalLayout(nextCards, cardsRef.current);
    cardsRef.current = mergedCards;
    setCards(mergedCards);
    if (selectedCardIdRef.current) {
      setSelectedCard(mergedCards.find((card) => card.id === selectedCardIdRef.current) ?? null);
    }
    const api = excalidrawApiRef.current;
    if (!api) return;
    const current = api.getSceneElements();
    const nonCardElements = current.filter((element) => !isArcCardElement(element));
    sceneApplyUntilRef.current = Date.now() + 250;
    api.updateScene({ elements: [...nonCardElements, ...cardsToElements(mergedCards)] });
  }, []);

  const applyWorkflowToScene = useCallback((workflow: ArcPersistedWorkflowGraph | null) => {
    workflowGraphRef.current = workflow;
    if (selectedWorkflowNodeIdRef.current) {
      setSelectedWorkflowNode(workflow?.graph.nodes.find((node) => node.id === selectedWorkflowNodeIdRef.current) ?? null);
    }
    const api = excalidrawApiRef.current;
    if (!api) return;
    const current = api.getSceneElements();
    const nonWorkflowElements = current.filter((element) => !isWorkflowElement(element));
    const workflowElements = workflow
      ? graphToExcalidrawElements(workflow.graph, {
          persisted: workflow,
          avoidRects: cardsRef.current.map((card) => ({ x: card.x, y: card.y, width: card.width, height: card.height })),
        })
      : [];
    sceneApplyUntilRef.current = Date.now() + 250;
    api.updateScene({ elements: [...nonWorkflowElements, ...workflowElements] });
  }, []);

  const refresh = useCallback(async (projectId = activeProjectIdRef.current) => {
    if (!projectId) {
      return;
    }
    const [tasksResponse, projectResponse] = await Promise.all([listTasks(projectId), getProject(projectId)]);
    applyCardsToScene(tasksResponse.cards);
    setProject(projectResponse.project);
    setProjects((current) => upsertProject(current, projectResponse.project));
    setRemoteUrl(projectResponse.project.remoteUrl || "");
    setError(null);
    setStatus(`${taskStatusLine(tasksResponse)} · ${projectStatusLine(projectResponse.project)}`);
    if (selectedTaskIdRef.current) {
      if (!selectedCardIdRef.current) {
        const card = tasksResponse.cards.find((candidate) => candidate.taskId === selectedTaskIdRef.current) ?? null;
        selectedCardIdRef.current = card?.id ?? null;
        setSelectedCard(card);
      }
      await loadTaskDetail(selectedTaskIdRef.current).catch((detailError) => {
        setError(detailError instanceof Error ? detailError.message : String(detailError));
      });
    }
    if (selectedOrchestrationIdRef.current) {
      await loadOrchestrationDetail(selectedOrchestrationIdRef.current).catch((detailError) => {
        setError(detailError instanceof Error ? detailError.message : String(detailError));
      });
    }
  }, [applyCardsToScene, loadOrchestrationDetail, loadTaskDetail]);

  const activateProject = useCallback(
    (projectId: number) => {
      if (!Number.isInteger(projectId) || projectId <= 0) return;
      activeProjectIdRef.current = projectId;
      setActiveProjectId(projectId);
      window.localStorage.setItem(ACTIVE_PROJECT_KEY, String(projectId));
      cardsRef.current = [];
      workflowGraphRef.current = null;
      setCards([]);
      setSelectedCard(null);
      setSelectedWorkflowNode(null);
      setTaskDetail(null);
      setOrchestrationDetail(null);
      selectedCardIdRef.current = null;
      selectedWorkflowNodeIdRef.current = null;
      selectedTaskIdRef.current = initialDeepLinkTaskIdRef.current;
      selectedOrchestrationIdRef.current = null;
      initialDeepLinkTaskIdRef.current = null;
      const api = excalidrawApiRef.current;
      if (api) {
        const nonArcElements = api.getSceneElements().filter((element) => !isArcManagedElement(element));
        sceneApplyUntilRef.current = Date.now() + 250;
        api.updateScene({ elements: nonArcElements });
      }
      void refresh(projectId).catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : String(refreshError)));
    },
    [refresh],
  );

  const selectCard = useCallback(
    (cardId: string | null) => {
      selectedCardIdRef.current = cardId;
      selectedWorkflowNodeIdRef.current = null;
      setSelectedWorkflowNode(null);
      const card = cardId ? cardsRef.current.find((candidate) => candidate.id === cardId) ?? null : null;
      setSelectedCard(card);
      const orchestrationId = card?.metadata?.orchestrationId ?? null;
      const cardType = card?.metadata?.type ?? card?.mode;
      if (orchestrationId && cardType && String(cardType).startsWith("orchestration_") && cardType !== "orchestration_agent") {
        selectedOrchestrationIdRef.current = orchestrationId;
        selectedTaskIdRef.current = null;
        setTaskDetail(null);
        void loadOrchestrationDetail(orchestrationId).catch((detailError) => {
          setError(detailError instanceof Error ? detailError.message : String(detailError));
        });
        return;
      }
      selectedOrchestrationIdRef.current = null;
      setOrchestrationDetail(null);
      if (card?.taskId) {
        selectedTaskIdRef.current = card.taskId;
        void loadTaskDetail(card.taskId).catch((detailError) => {
          setError(detailError instanceof Error ? detailError.message : String(detailError));
        });
        return;
      }
      selectedTaskIdRef.current = null;
      setTaskDetail(null);
    },
    [loadOrchestrationDetail, loadTaskDetail],
  );

  const selectWorkflowNode = useCallback((nodeId: string | null) => {
    selectedWorkflowNodeIdRef.current = nodeId;
    selectedCardIdRef.current = null;
    selectedTaskIdRef.current = null;
    selectedOrchestrationIdRef.current = null;
    setSelectedCard(null);
    setTaskDetail(null);
    setOrchestrationDetail(null);
    setSelectedWorkflowNode(nodeId ? workflowGraphRef.current?.graph.nodes.find((node) => node.id === nodeId) ?? null : null);
  }, []);

  const closeSidebar = useCallback(() => {
    selectedCardIdRef.current = null;
    selectedWorkflowNodeIdRef.current = null;
    selectedTaskIdRef.current = null;
    selectedOrchestrationIdRef.current = null;
    setSelectedCard(null);
    setSelectedWorkflowNode(null);
    setTaskDetail(null);
    setOrchestrationDetail(null);
    setSelectedOptions(new Set());
    const api = excalidrawApiRef.current;
    if (api) {
      sceneApplyUntilRef.current = Date.now() + 250;
      api.updateScene({ appState: { selectedElementIds: {} } });
    }
  }, []);

  useEffect(() => {
    applyWorkflowToScene(workflowStream.graph);
  }, [applyWorkflowToScene, workflowStream.graph]);

  useEffect(() => {
    const parts = [
      workflowStream.status === "connected" ? "Workflow connected" : workflowStream.status === "connecting" ? "Workflow connecting" : "Workflow disconnected",
      workflowStream.revision !== null ? `rev ${workflowStream.revision}` : "no graph",
      workflowStream.latestPatchReason ? `latest: ${workflowStream.latestPatchReason}` : null,
    ].filter(Boolean);
    if (parts.length) {
      setStatus((current) => (current.startsWith("Moved ") ? current : parts.join(" · ")));
    }
    if (workflowStream.error) {
      setError(workflowStream.error);
    }
  }, [workflowStream.status, workflowStream.revision, workflowStream.latestPatchReason, workflowStream.error]);

  useEffect(() => {
    let canceled = false;
    void listProjects()
      .then((response) => {
        if (canceled) return;
        setProjects(response.projects);
        const selected = chooseInitialProject(response.projects, activeProjectIdRef.current);
        if (selected) {
          activateProject(selected);
        }
      })
      .catch((projectError) => setError(projectError instanceof Error ? projectError.message : String(projectError)));
    return () => {
      canceled = true;
    };
  }, [activateProject]);

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
    const isImplement = /^\/implement(?:\s+|$)/i.test(trimmed);
    const isOrchestrate = /^\/orchestrate(?:\s+|$)/i.test(trimmed);
    if (!isImplement && !isOrchestrate) {
      setError("Use /implement <message> or /orchestrate <message>.");
      return;
    }
    if (/^\/(?:implement|orchestrate)\s*$/i.test(trimmed)) {
      setError("Enter a non-empty command message.");
      return;
    }
    if (!project) {
      setError("Select or create an Excalidraw project first.");
      return;
    }
    if (isImplement && mode === "direct_agent" && (!project || !project.prReady)) {
      setError(projectBlockerText(project));
      return;
    }

    setBusy(true);
    try {
      const position = cardPositionInViewport(excalidrawApiRef.current, canvasFrameRef.current, spawnViewportRef);
      if (isOrchestrate) {
        const response = await submitOrchestrate(trimmed, project.projectId, position.x, position.y);
        applyCardsToScene([response.card, ...cardsRef.current.filter((card) => card.id !== response.card.id)]);
        setOrchestrationDetail(response.orchestration);
        selectCard(response.card.id);
        setCommand("/orchestrate ");
        setStatus(`Created orchestration #${response.orchestration.orchestration.id}`);
      } else {
        const response = await submitImplement(trimmed, mode, project.projectId, position.x, position.y);
        applyCardsToScene([response.card, ...cardsRef.current.filter((card) => card.id !== response.card.id)]);
        selectCard(response.card.id);
        setCommand("/implement ");
        setStatus(
          mode === "direct_agent"
            ? `Created task ${response.taskId} (${response.status})`
            : "Created plan card",
        );
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectRemote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!project) {
      setError("Select a project before connecting a repo.");
      return;
    }
    const trimmed = remoteUrl.trim();
    if (!trimmed) {
      setError("Enter a GitHub remote URL before connecting the repo.");
      return;
    }

    setConnecting(true);
    try {
      const response = await connectProjectRemote(project.projectId, trimmed);
      setProject(response.project);
      setProjects((current) => upsertProject(current, response.project));
      setRemoteUrl(response.project.remoteUrl ?? trimmed);
      setStatus(`Connected repo for ${response.project.projectName}. ${response.summary}`);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : String(connectError));
    } finally {
      setConnecting(false);
    }
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const name = newProjectName.trim();
    if (!name) {
      setError("Enter a project name.");
      return;
    }
    setCreatingProject(true);
    try {
      const response = await createProject(name);
      setProjects((current) => upsertProject(current, response.project));
      setNewProjectName("");
      activateProject(response.project.projectId);
      setStatus(`Created project ${response.project.projectName}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!taskDetail) {
      setError("Select a task card before sending a follow-up.");
      return;
    }
    const content = chatMessage.trim();
    if (!content) {
      setError("Enter a follow-up message.");
      return;
    }
    setChatBusy(true);
    try {
      const detail = await sendTaskMessage(taskDetail.numericTaskId, content);
      setTaskDetail(detail);
      setChatMessage("");
      setStatus(`Queued follow-up for task #${detail.projectTaskNumber}`);
      await refresh(detail.projectId);
    } catch (chatError) {
      setError(chatError instanceof Error ? chatError.message : String(chatError));
    } finally {
      setChatBusy(false);
    }
  }

  async function handleSendOrchestrationMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!orchestrationDetail) {
      setError("Select an orchestration card before sending planner input.");
      return;
    }
    const content = orchestrationMessage.trim();
    if (!content) {
      setError("Enter a planner message.");
      return;
    }
    setChatBusy(true);
    try {
      const detail = await sendOrchestrationMessage(orchestrationDetail.orchestration.id, content);
      setOrchestrationDetail(detail);
      setOrchestrationMessage("");
      setStatus(`Updated orchestration #${detail.orchestration.id}`);
      await refresh(detail.orchestration.projectId);
    } catch (chatError) {
      setError(chatError instanceof Error ? chatError.message : String(chatError));
    } finally {
      setChatBusy(false);
    }
  }

  async function submitOptionAnswer(question: ArcPlannerQuestion, selected: string[], customText = "") {
    if (!orchestrationDetail) return;
    setChatBusy(true);
    setError(null);
    try {
      const detail = await answerOrchestrationQuestion(orchestrationDetail.orchestration.id, question.id, selected, customText);
      setOrchestrationDetail(detail);
      setSelectedOptions(new Set());
      setStatus(`Planner updated orchestration #${detail.orchestration.id}`);
      await refresh(detail.orchestration.projectId);
    } catch (answerError) {
      setError(answerError instanceof Error ? answerError.message : String(answerError));
    } finally {
      setChatBusy(false);
    }
  }

  async function handleLaunchSelectedOrchestration() {
    if (!orchestrationDetail) return;
    if (!project?.prReady) {
      setError(projectBlockerText(project));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const position = cardPositionInViewport(excalidrawApiRef.current, canvasFrameRef.current, spawnViewportRef);
      const response = await launchOrchestration(orchestrationDetail.orchestration.id, position.x, position.y);
      applyCardsToScene([...response.cards, ...cardsRef.current.filter((card) => !response.cards.some((next) => next.id === card.id))]);
      setOrchestrationDetail(response.orchestration);
      setStatus(`Spawned ${response.orchestration.agents.length} agents for orchestration #${response.orchestration.orchestration.id}`);
      await refresh(response.orchestration.orchestration.projectId);
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : String(launchError));
    } finally {
      setBusy(false);
    }
  }

  function handleSceneChange(elements: readonly ArcElement[], appState: ArcAppState = {}) {
    if (Date.now() < sceneApplyUntilRef.current) {
      return;
    }
    const selectedWorkflowNodeId = selectedWorkflowNodeIdFromAppState(elements, appState);
    if (selectedWorkflowNodeId !== selectedWorkflowNodeIdRef.current) {
      if (selectedWorkflowNodeId) {
        selectWorkflowNode(selectedWorkflowNodeId);
      } else if (selectedWorkflowNodeIdRef.current) {
        selectWorkflowNode(null);
      }
    }
    if (!selectedWorkflowNodeId) {
      const selectedId = selectedCardIdFromAppState(elements, appState);
      if (selectedId !== selectedCardIdRef.current) {
        selectCard(selectedId);
      }
    }
    const workflow = workflowGraphRef.current;
    if (workflow && workflowLayerNeedsRestore(elements, workflow)) {
      applyWorkflowToScene(workflow);
    }
    const updates = changedCardPositions(elements, cardsRef.current);
    if (updates.length === 0) {
      return;
    }

    cardsRef.current = cardsRef.current.map((card) => updates.find((update) => update.id === card.id) ?? card);
    setCards(cardsRef.current);
    if (selectedCardIdRef.current) {
      setSelectedCard(cardsRef.current.find((card) => card.id === selectedCardIdRef.current) ?? null);
    }
    for (const update of updates) {
      pendingPositionUpdatesRef.current.set(update.id, update);
    }

    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      const pending = Array.from(pendingPositionUpdatesRef.current.values());
      pendingPositionUpdatesRef.current.clear();
      for (const update of pending) {
        void updateCardPosition(update).catch((positionError) => {
          setError(positionError instanceof Error ? positionError.message : String(positionError));
        });
      }
      if (pending.length > 0) {
        setStatus(`Moved ${pending.length} card${pending.length === 1 ? "" : "s"}`);
      }
    }, 600);
  }

  const directAgentBlocked = /^\/implement/i.test(command.trim()) && mode === "direct_agent" && (!project || !project.prReady);
  const sidebarOpen = Boolean(selectedCard || selectedWorkflowNode);

  return (
    <div className={`arc-shell ${sidebarOpen ? "with-sidebar" : ""}`}>
      <div className="top-panel">
        <div className="project-panel">
          <div className="brand-block">
            <div className="brand-title">Arc-Tech Canvas</div>
            <div className="brand-subtitle">Project-based visual runner</div>
          </div>
          <label className="project-selector">
            <span>Project</span>
            <select
              value={activeProjectId ?? ""}
              onChange={(event) => activateProject(Number(event.target.value))}
              disabled={busy || connecting || creatingProject}
            >
              {projects.map((candidate) => (
                <option key={candidate.projectId} value={candidate.projectId}>
                  {candidate.projectName}
                </option>
              ))}
            </select>
          </label>
          <form className="project-create" onSubmit={handleCreateProject}>
            <input
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              placeholder="New project name"
              spellCheck={false}
            />
            <button type="submit" disabled={creatingProject || busy || connecting}>
              {creatingProject ? "Creating" : "New"}
            </button>
          </form>
          <div className={`repo-state ${project?.prReady ? "ready" : "blocked"}`}>
            <strong>{project?.projectName ?? "No project"}</strong>
            <span>{project ? projectStatusLine(project) : "Loading project status"}</span>
          </div>
        </div>
        <form className="command-panel" onSubmit={handleSubmit}>
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
            <button
              type="button"
              className={/^\/orchestrate/i.test(command.trim()) ? "active" : ""}
              onClick={() => setCommand("/orchestrate ")}
            >
              Orchestrate
            </button>
          </div>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="/implement Add a health check endpoint or /orchestrate Plan a feature"
            spellCheck={false}
          />
          <button className="submit-button" type="submit" disabled={busy || connecting || directAgentBlocked}>
            {busy ? "Submitting" : "Run"}
          </button>
          <button
            className="refresh-button"
            type="button"
            onClick={() => void refresh()}
            disabled={busy || connecting || !activeProjectId}
          >
            Refresh
          </button>
          <div className="status-strip" aria-live="polite">
            {error ?? workflowStatusText(workflowStream.status, workflowStream.revision, workflowStream.latestPatchReason, status)}
          </div>
        </form>
        <form className="repo-panel" onSubmit={handleConnectRemote}>
          <input
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
            placeholder="https://github.com/owner/repo.git"
            spellCheck={false}
            aria-label="Git remote URL"
          />
          <button className="connect-button" type="submit" disabled={connecting || busy || !project}>
            {connecting ? "Connecting" : "Connect Repo"}
          </button>
        </form>
      </div>
      <div className="workspace-row">
        <div className="canvas-frame" ref={canvasFrameRef}>
          <Excalidraw
            excalidrawAPI={(api) => {
              excalidrawApiRef.current = api as unknown as ExcalidrawApi;
              if (cardsRef.current.length > 0) {
                applyCardsToScene(cardsRef.current);
              }
              if (workflowGraphRef.current) {
                applyWorkflowToScene(workflowGraphRef.current);
              }
            }}
            onChange={(elements, appState) => handleSceneChange(elements as readonly ArcElement[], appState as unknown as ArcAppState)}
            initialData={{ appState: { viewBackgroundColor: "#f7f4ee" } }}
          />
        </div>
        {selectedWorkflowNode ? (
          <WorkflowSidebar
            node={selectedWorkflowNode}
            workflow={workflowGraphRef.current}
            streamStatus={workflowStream.status}
            latestPatchReason={workflowStream.latestPatchReason}
            onClose={closeSidebar}
          />
        ) : selectedCard && orchestrationDetail ? (
          <OrchestrationSidebar
            card={selectedCard}
            detail={orchestrationDetail}
            selectedOptions={selectedOptions}
            chatMessage={orchestrationMessage}
            chatBusy={chatBusy || busy}
            onSelectedOptionsChange={setSelectedOptions}
            onSubmitOption={submitOptionAnswer}
            onChatMessageChange={setOrchestrationMessage}
            onSubmitMessage={handleSendOrchestrationMessage}
            onLaunch={handleLaunchSelectedOrchestration}
            onOpenTask={(taskId) => {
              const card = cardsRef.current.find((candidate) => candidate.taskId === taskId);
              selectCard(card?.id ?? null);
            }}
            onClose={closeSidebar}
          />
        ) : selectedCard ? (
          <TaskSidebar
            card={selectedCard}
            detail={taskDetail}
            chatMessage={chatMessage}
            chatBusy={chatBusy}
            onChatMessageChange={setChatMessage}
            onSubmitMessage={handleSendMessage}
            onClose={closeSidebar}
          />
        ) : null}
      </div>
    </div>
  );
}

function OrchestrationSidebar(props: {
  card: ArcCard;
  detail: ArcOrchestrationView;
  selectedOptions: Set<string>;
  chatMessage: string;
  chatBusy: boolean;
  onSelectedOptionsChange: (value: Set<string>) => void;
  onSubmitOption: (question: ArcPlannerQuestion, selected: string[], customText?: string) => void;
  onChatMessageChange: (value: string) => void;
  onSubmitMessage: (event: FormEvent<HTMLFormElement>) => void;
  onLaunch: () => void;
  onOpenTask: (taskId: number) => void;
  onClose: () => void;
}) {
  const { detail } = props;
  const orchestration = detail.orchestration;
  const question = orchestration.latestQuestion;
  const canSpawn = ["ready_for_approval", "READY_TO_ORCHESTRATE"].includes(orchestration.status);
  const canAnswerQuestion = ["waiting_for_user_choice", "asking_questions", "refining_plan", "draft_created"].includes(orchestration.status);
  return (
    <aside className="task-sidebar orchestration-sidebar">
      <div className="sidebar-header">
        <div>
          <div className="sidebar-kicker">Orchestration</div>
          <h2>Orchestration #{orchestration.id}</h2>
        </div>
        <button type="button" onClick={props.onClose} aria-label="Close orchestration details">
          Close
        </button>
      </div>
      <div className="sidebar-section details-grid">
        <span>Status</span>
        <strong>{orchestration.status}</strong>
        <span>Project</span>
        <strong>{orchestration.projectName ?? orchestration.projectId}</strong>
        <span>Repo</span>
        <strong>{orchestration.repoPath ?? "unknown"}</strong>
        <span>Remote</span>
        <strong>{orchestration.remoteUrl ?? orchestration.remoteStatus ?? "unknown"}</strong>
        <span>Agents</span>
        <strong>{detail.aggregate.done} done / {detail.aggregate.total} total</strong>
        <span>Branches</span>
        <strong>{detail.aggregate.branches.length || "none"}</strong>
      </div>
      <div className="sidebar-section">
        <h3>Goal</h3>
        <pre>{orchestration.goal}</pre>
      </div>
      {question && canAnswerQuestion ? (
        <OptionPoll
          question={question}
          selectedOptions={props.selectedOptions}
          disabled={props.chatBusy}
          onSelectedOptionsChange={props.onSelectedOptionsChange}
          onSubmit={(selected) => props.onSubmitOption(question, selected)}
        />
      ) : null}
      <div className="sidebar-section action-row">
        <button type="button" onClick={props.onLaunch} disabled={!canSpawn || props.chatBusy}>
          Spawn Agents
        </button>
        <button
          type="button"
          onClick={() => props.onSubmitOption(question ?? fallbackQuestion(orchestration.id), [], "Continue planning")}
          disabled={props.chatBusy || orchestration.status === "agents_spawned"}
        >
          Continue Planning
        </button>
      </div>
      {orchestration.finalPlan ? (
        <div className="sidebar-section">
          <h3>Master Plan</h3>
          <pre>{JSON.stringify(orchestration.finalPlan, null, 2)}</pre>
        </div>
      ) : null}
      <div className="sidebar-section">
        <h3>Spawned Agents</h3>
        <div className="history-list">
          {detail.agents.length ? (
            detail.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="agent-link-row"
                onClick={() => agent.childTaskId && props.onOpenTask(agent.childTaskId)}
                disabled={!agent.childTaskId}
              >
                #{agent.agentIndex} {agent.agentName} · {agent.status} · {agent.branchName ?? "no branch"}
              </button>
            ))
          ) : (
            <p>No child agents spawned yet.</p>
          )}
        </div>
      </div>
      <form className="chat-panel" onSubmit={props.onSubmitMessage}>
        <textarea
          value={props.chatMessage}
          onChange={(event) => props.onChatMessageChange(event.target.value)}
          placeholder="Reply to the planner..."
          rows={4}
        />
        <button type="submit" disabled={props.chatBusy}>
          {props.chatBusy ? "Sending" : "Send Planner Reply"}
        </button>
      </form>
      <div className="sidebar-section">
        <h3>Planning History</h3>
        <div className="history-list">
          {detail.messages.map((message) => (
            <div className="history-item" key={message.id}>
              <div>{message.createdAt} · {message.role}</div>
              <pre>{message.content}</pre>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function OptionPoll(props: {
  question: ArcPlannerQuestion;
  selectedOptions: Set<string>;
  disabled: boolean;
  onSelectedOptionsChange: (value: Set<string>) => void;
  onSubmit: (selected: string[]) => void;
}) {
  function toggle(optionId: string) {
    const next = new Set(props.question.allowMultiSelect ? props.selectedOptions : []);
    if (next.has(optionId)) {
      next.delete(optionId);
    } else {
      next.add(optionId);
    }
    props.onSelectedOptionsChange(next);
    if (!props.question.allowMultiSelect) {
      props.onSubmit([optionId]);
    }
  }
  return (
    <div className="sidebar-section option-poll">
      <h3>{props.question.text}</h3>
      {props.question.options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={props.selectedOptions.has(option.id) ? "selected" : ""}
          onClick={() => toggle(option.id)}
          disabled={props.disabled}
        >
          <strong>{option.label}</strong>
          <span>{option.description}</span>
        </button>
      ))}
      {props.question.allowMultiSelect ? (
        <button type="button" onClick={() => props.onSubmit(Array.from(props.selectedOptions))} disabled={props.disabled || props.selectedOptions.size === 0}>
          Submit Selection
        </button>
      ) : null}
    </div>
  );
}

function fallbackQuestion(orchestrationId: number): ArcPlannerQuestion {
  return { id: `orch-${orchestrationId}-custom`, text: "Custom planner input", allowMultiSelect: false, options: [] };
}

function TaskSidebar(props: {
  card: ArcCard;
  detail: ArcTaskDetail | null;
  chatMessage: string;
  chatBusy: boolean;
  onChatMessageChange: (value: string) => void;
  onSubmitMessage: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const { card, detail } = props;
  return (
    <aside className="task-sidebar">
      <div className="sidebar-header">
        <div>
          <div className="sidebar-kicker">{card.mode === "plan_card_only" ? "Plan card" : "Agent task"}</div>
          <h2>{detail?.title ?? card.title}</h2>
        </div>
        <button type="button" onClick={props.onClose} aria-label="Close task details">
          Close
        </button>
      </div>

      {card.mode === "plan_card_only" || !card.taskId ? (
        <div className="sidebar-section">
          <h3>Plan</h3>
          <p>{card.title}</p>
          <pre>{card.command}</pre>
        </div>
      ) : detail ? (
        <>
          <div className="sidebar-section details-grid">
            <span>Status</span>
            <strong>{detail.status} ({detail.rawStatus})</strong>
            <span>Project</span>
            <strong>{detail.projectName ?? "unknown"}</strong>
            <span>Branch</span>
            <strong>{detail.taskBranch ?? detail.branch ?? "not created"}</strong>
            <span>Worktree</span>
            <strong>{detail.worktreePath ?? "not created"}</strong>
            <span>Phase</span>
            <strong>{detail.latestPhase}</strong>
            <span>Activity</span>
            <strong>{detail.latestActivity}</strong>
            <span>Messages</span>
            <strong>{messageCountsLine(detail.messageCounts)}</strong>
          </div>
          <LinkList links={card.links} />
          <div className="sidebar-section">
            <h3>Prompt</h3>
            <pre>{detail.prompt}</pre>
          </div>
          <div className="sidebar-section">
            <h3>Latest Command</h3>
            <pre>{detail.currentCommand ?? "No command event yet."}</pre>
          </div>
          <div className="sidebar-section">
            <h3>Changed Files</h3>
            <ListOrEmpty values={detail.changedFiles} empty="No file change events recorded yet." />
          </div>
          <div className="sidebar-section">
            <h3>Summary</h3>
            <pre>{detail.error ?? detail.completionSummary ?? detail.finalSummary ?? "No summary yet."}</pre>
          </div>
          <div className="sidebar-section">
            <h3>PR Feedback</h3>
            <pre>{prFeedbackLine(detail)}</pre>
          </div>
          <form className="chat-panel" onSubmit={props.onSubmitMessage}>
            <textarea
              value={props.chatMessage}
              onChange={(event) => props.onChatMessageChange(event.target.value)}
              placeholder="Ask the agent for changes..."
              rows={4}
            />
            <button type="submit" disabled={props.chatBusy}>
              {props.chatBusy ? "Sending" : "Send Follow-up"}
            </button>
          </form>
          <div className="sidebar-section">
            <h3>Message History</h3>
            <div className="history-list">
              {detail.messages.length ? (
                detail.messages.map((message) => (
                  <div className="history-item" key={message.id}>
                    <div>{message.createdAt} · {message.status}</div>
                    <pre>{message.content}</pre>
                  </div>
                ))
              ) : (
                <p>No task messages recorded.</p>
              )}
            </div>
          </div>
          <div className="sidebar-section">
            <h3>Recent Codex Events</h3>
            <div className="event-list">
              {detail.codexEvents.slice(-30).map((event, index) => (
                <div className="event-item" key={`${event.createdAt}-${index}`}>
                  <span>{event.createdAt}</span>
                  <strong>{event.itemType ? `${event.eventType} ${event.itemType}` : event.eventType}</strong>
                  <pre>{compactJson(event.payloadJson)}</pre>
                </div>
              ))}
              {detail.codexEvents.length === 0 ? <p>No Codex events recorded.</p> : null}
            </div>
          </div>
        </>
      ) : (
        <div className="sidebar-section">
          <p>Loading task details...</p>
        </div>
      )}
    </aside>
  );
}

function WorkflowSidebar(props: {
  node: ArcWorkflowNode;
  workflow: ArcPersistedWorkflowGraph | null;
  streamStatus: string;
  latestPatchReason: string | null;
  onClose: () => void;
}) {
  return (
    <aside className="task-sidebar workflow-sidebar">
      <div className="sidebar-header">
        <div>
          <div className="sidebar-kicker">Workflow Node</div>
          <h2>{props.node.title}</h2>
        </div>
        <button type="button" onClick={props.onClose} aria-label="Close workflow details">
          Close
        </button>
      </div>
      <div className="sidebar-section details-grid">
        <span>Status</span>
        <strong>{props.node.status}</strong>
        <span>Kind</span>
        <strong>{props.node.kind}</strong>
        <span>Node ID</span>
        <strong>{props.node.id}</strong>
        <span>Graph</span>
        <strong>{props.workflow?.graph.id ?? "unknown"}</strong>
        <span>Revision</span>
        <strong>{props.workflow?.revision ?? "none"}</strong>
        <span>Stream</span>
        <strong>{props.streamStatus}</strong>
      </div>
      <div className="sidebar-section">
        <h3>Description</h3>
        <pre>{props.node.body ?? props.node.summary ?? "No description recorded."}</pre>
      </div>
      {props.node.tags?.length ? (
        <div className="sidebar-section">
          <h3>Tags</h3>
          <ListOrEmpty values={props.node.tags} empty="No tags recorded." />
        </div>
      ) : null}
      <div className="sidebar-section">
        <h3>Workflow Status</h3>
        <p>{workflowStatusText(props.streamStatus, props.workflow?.revision ?? null, props.latestPatchReason, "Workflow idle")}</p>
        <p className="muted-copy">Workflow nodes are read-only on the canvas in v1.</p>
      </div>
    </aside>
  );
}

function LinkList({ links }: { links: ArcLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="sidebar-links">
      {links.map((link) => (
        <a key={`${link.label}-${link.url}`} href={link.url} target="_blank" rel="noreferrer">
          {link.label}
        </a>
      ))}
    </div>
  );
}

function ListOrEmpty({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <p>{empty}</p>;
  return (
    <ul>
      {values.map((value) => (
        <li key={value}>{value}</li>
      ))}
    </ul>
  );
}

function canvasCardDrawOrder(cards: ArcCard[]): ArcCard[] {
  return [...cards].sort((left, right) => cardDrawPriority(left) - cardDrawPriority(right));
}

function cardDrawPriority(card: ArcCard): number {
  const type = card.metadata?.type ?? card.mode;
  if (type === "orchestration_parent" || type === "orchestration_border") return 0;
  if (card.parentCardId) return 2;
  return 1;
}

function cardsToElements(cards: ArcCard[]) {
  return convertToExcalidrawElements(
    canvasCardDrawOrder(cards).flatMap((card) => {
      const links = cardLinks(card).slice(0, 4);
      const primaryLink = links[0] ?? null;
      const isOrchestration = (card.metadata?.type ?? card.mode).startsWith("orchestration_");
      const isOrchestrationContainer = card.metadata?.type === "orchestration_parent" || card.mode === "orchestration_border";
      const metadata = {
        arc: {
          type: card.metadata?.type ?? (card.mode === "plan_card_only" ? "plan" : "task"),
          taskId: card.taskId ? String(card.taskId) : null,
          orchestrationId: card.metadata?.orchestrationId,
          cardId: card.id,
          source: "excalidraw",
          command: card.command,
          status: card.status,
          phase: card.progress?.phase,
          activity: card.progress?.activity,
          lastActivityAt: card.progress?.lastActivityAt,
          feedbackState: card.progress?.pullRequestFeedback?.state ?? null,
          link: primaryLink?.url ?? null,
          linkLabel: primaryLink?.label ?? null,
        },
      };
      const linkTop = card.y + card.height - 28;
      const textHeight = isOrchestrationContainer ? 132 : card.height - (links.length ? 70 : 36);
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
          height: Math.max(80, textHeight),
          text: card.label,
          fontSize: isOrchestration ? 14 : 16,
          fontFamily: 1,
          textAlign: "left",
          verticalAlign: "top",
          strokeColor: "#1f2937",
          backgroundColor: "transparent",
          groupIds: [card.id],
          customData: metadata,
        },
        ...links.map((link, index) => ({
          id: linkElementId(card.id, index),
          type: "text",
          x: card.x + 18 + index * 78,
          y: linkTop,
          width: 68,
          height: 22,
          text: link.label,
          fontSize: 14,
          fontFamily: 1,
          textAlign: "left",
          verticalAlign: "top",
          strokeColor: "#1d4ed8",
          backgroundColor: "transparent",
          link: normalizeCanvasLink(link.url),
          groupIds: [card.id],
          customData: metadata,
        })),
      ];
    }) as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: false },
  );
}

function changedCardPositions(elements: readonly ArcElement[], cards: ArcCard[]): ArcCard[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return Array.from(cardLayoutFromElements(elements).entries())
    .map(([cardId, layout]) => {
      const card = byId.get(cardId);
      if (!card) return null;
      const next = { ...card, ...layout };
      return samePosition(card, next) ? null : next;
    })
    .filter((card): card is ArcCard => Boolean(card));
}

function selectedCardIdFromAppState(elements: readonly ArcElement[], appState: ArcAppState): string | null {
  const selectedIds = appState.selectedElementIds ?? {};
  for (const element of elements) {
    if (!selectedIds[element.id]) continue;
    const cardId = cardIdFromElement(element);
    if (cardId) return cardId;
  }
  return null;
}

function selectedWorkflowNodeIdFromAppState(elements: readonly ArcElement[], appState: ArcAppState): string | null {
  const selectedIds = appState.selectedElementIds ?? {};
  for (const element of elements) {
    if (!selectedIds[element.id]) continue;
    const nodeId = element.customData?.arcWorkflow?.workflowNodeId;
    if (nodeId) return nodeId;
  }
  return null;
}

function isArcCardElement(element: ArcElement): boolean {
  return element.customData?.arc?.source === "excalidraw" || Boolean(cardIdFromElement(element));
}

function isWorkflowElement(element: ArcElement): boolean {
  return Boolean(element.customData?.arcWorkflow);
}

function isArcManagedElement(element: ArcElement): boolean {
  return isArcCardElement(element) || isWorkflowElement(element);
}

function workflowLayerNeedsRestore(elements: readonly ArcElement[], workflow: ArcPersistedWorkflowGraph): boolean {
  const elementIds = new Set(elements.filter(isWorkflowElement).map((element) => element.id));
  return workflow.graph.nodes.some((node) => !elementIds.has(workflowNodeElementId(workflow.graph.id, node.id)));
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

function linkElementId(cardId: string, index: number): string {
  return `arc-card-${cardId}-link-${index}`;
}

function cardIdFromElement(element: ArcElement): string | null {
  const metadataId = element.customData?.arc?.cardId;
  if (metadataId) return metadataId;
  const match = /^arc-card-(.+?)(?:-(?:text|link-\d+))?$/.exec(element.id);
  return match?.[1] ?? null;
}

function cardLayoutFromElements(elements: readonly ArcElement[]): Map<string, Pick<ArcCard, "x" | "y" | "width" | "height">> {
  const layouts = new Map<string, Pick<ArcCard, "x" | "y" | "width" | "height">>();
  for (const element of elements) {
    const cardId = cardIdFromElement(element);
    if (!cardId) continue;
    if (element.id === rectElementId(cardId)) {
      layouts.set(cardId, roundedLayout(element));
      continue;
    }
    if (!layouts.has(cardId) && element.id === textElementId(cardId)) {
      layouts.set(cardId, {
        x: Math.round(element.x - 18),
        y: Math.round(element.y - 18),
        width: Math.round(element.width + 36),
        height: Math.round(element.height + 36),
      });
    }
  }
  return layouts;
}

function roundedLayout(element: ArcElement): Pick<ArcCard, "x" | "y" | "width" | "height"> {
  return {
    x: Math.round(element.x),
    y: Math.round(element.y),
    width: Math.round(element.width),
    height: Math.round(element.height),
  };
}

function mergeCardsWithLocalLayout(serverCards: ArcCard[], localCards: ArcCard[]): ArcCard[] {
  const localById = new Map(localCards.map((card) => [card.id, card]));
  return serverCards.map((serverCard) => {
    const localCard = localById.get(serverCard.id);
    if (!localCard) return serverCard;
    return {
      ...serverCard,
      x: localCard.x,
      y: localCard.y,
      width: Math.max(serverCard.width, localCard.width),
      height: Math.max(serverCard.height, localCard.height),
    };
  });
}

function cardLinks(card: ArcCard): ArcLink[] {
  const links: ArcLink[] = [];
  for (const link of card.links ?? []) {
    addLink(links, link.label, link.url);
  }
  addLink(links, "PR", card.progress?.pullRequestUrl);
  addLinksFromText(links, card.progress?.summary ?? null);
  addLinksFromText(links, card.progress?.error ?? null);
  return dedupeLinks(links);
}

function addLink(links: ArcLink[], label: string, value: string | null | undefined): void {
  const url = normalizeCanvasLink(value);
  if (!url) return;
  links.push({ label, url });
}

function addLinksFromText(links: ArcLink[], value: string | null): void {
  if (!value) return;
  for (const [, label, url] of value.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    addLink(links, label, url);
  }
  for (const [url] of value.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    addLink(links, "Link", url);
  }
}

function normalizeCanvasLink(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function dedupeLinks(links: ArcLink[]): ArcLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function cardPositionInViewport(
  api: ExcalidrawApi | null,
  frame: HTMLDivElement | null,
  spawnRef: MutableRefObject<{ key: string; count: number }>,
): { x: number; y: number } {
  const appState = api?.getAppState();
  const rect = frame?.getBoundingClientRect();
  const zoom = zoomValue(appState?.zoom);
  const viewportWidth = rect?.width ?? window.innerWidth;
  const viewportHeight = rect?.height ?? window.innerHeight;
  const centerX = (viewportWidth / 2 - (appState?.scrollX ?? 0)) / zoom;
  const centerY = (viewportHeight / 2 - (appState?.scrollY ?? 0)) / zoom;
  const key = `${Math.round(centerX / 200)}:${Math.round(centerY / 160)}:${Math.round(zoom * 100)}`;
  if (spawnRef.current.key !== key) {
    spawnRef.current = { key, count: 0 };
  }
  const offset = (spawnRef.current.count % 6) * 28;
  spawnRef.current.count += 1;
  return {
    x: Math.round(centerX - 230 + offset),
    y: Math.round(centerY - 120 + offset),
  };
}

function zoomValue(zoom: ArcAppState["zoom"]): number {
  if (typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0) return zoom;
  if (zoom && typeof zoom.value === "number" && Number.isFinite(zoom.value) && zoom.value > 0) return zoom.value;
  return 1;
}

function strokeFor(status: string): string {
  if (status === "running") return "#2563eb";
  if (status === "completed") return "#15803d";
  if (status === "failed") return "#b91c1c";
  if (status === "planned" || status === "planning" || status === "ready") return "#7c3aed";
  return "#475569";
}

function backgroundFor(status: string): string {
  if (status === "running") return "#dbeafe";
  if (status === "completed") return "#dcfce7";
  if (status === "failed") return "#fee2e2";
  if (status === "planned" || status === "planning" || status === "ready") return "#ede9fe";
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
  return `${remote} · ${pr} · ${ready} · ${project.taskCount} task${project.taskCount === 1 ? "" : "s"}`;
}

function workflowStatusText(streamStatus: string, revision: number | null, latestPatchReason: string | null, fallback: string): string {
  const connected =
    streamStatus === "connected"
      ? "Workflow connected"
      : streamStatus === "connecting"
        ? "Workflow connecting"
        : streamStatus === "error"
          ? "Workflow reconnecting"
          : "Workflow disconnected";
  const parts = [connected, revision !== null ? `rev ${revision}` : "no graph", latestPatchReason ? `latest: ${latestPatchReason}` : fallback].filter(Boolean);
  return parts.join(" · ");
}

function projectBlockerText(project: ArcProject | null): string {
  if (!project) return "Project PR status is still loading.";
  return project.blockers.length ? project.blockers.join(" ") : "Project is ready.";
}

function initialProjectId(): number | null {
  const query = new URLSearchParams(window.location.search).get("projectId");
  const value = query ?? window.localStorage.getItem(ACTIVE_PROJECT_KEY);
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function initialTaskId(): number | null {
  const parsed = Number(new URLSearchParams(window.location.search).get("taskId") ?? "");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function chooseInitialProject(projects: ArcProject[], preferredId: number | null): number | null {
  if (preferredId && projects.some((project) => project.projectId === preferredId)) return preferredId;
  return projects[0]?.projectId ?? null;
}

function upsertProject(projects: ArcProject[], project: ArcProject): ArcProject[] {
  const next = [project, ...projects.filter((candidate) => candidate.projectId !== project.projectId)];
  return next.sort((left, right) => left.projectName.localeCompare(right.projectName));
}

function messageCountsLine(counts: ArcTaskDetail["messageCounts"]): string {
  const parts = [
    counts.queued ? `${counts.queued} queued` : null,
    counts.processing ? `${counts.processing} processing` : null,
    counts.processed ? `${counts.processed} done` : null,
    counts.failed ? `${counts.failed} failed` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "none";
}

function prFeedbackLine(detail: ArcTaskDetail): string {
  const summary = detail.pullRequestFeedback.summary;
  if (!summary) return "No PR feedback recorded.";
  return JSON.stringify(summary, null, 2);
}

function compactJson(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2).slice(0, 900);
  } catch {
    return payload.slice(0, 900);
  }
}
