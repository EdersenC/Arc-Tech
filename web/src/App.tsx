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
  remakeOrchestrationPlan,
  sendTaskMessage,
  sendOrchestrationMessage,
  submitImplement,
  submitOrchestrate,
  updateOrchestrationPlan,
  updateCardPosition,
  type ArcCard,
  type ArcCardMode,
  type ArcLink,
  type ArcOrchestrationView,
  type ArcPlannerQuestionView,
  type ArcProject,
  type ArcTaskDetail,
} from "./api";
import { graphToExcalidrawElements } from "./workflows/workflowElements";
import { useWorkflowStream, type WorkflowStreamStatus } from "./workflows/useWorkflowStream";
import type { ArcPersistedWorkflowGraph, ArcWorkflowNode } from "./workflows/api";

const ACTIVE_PROJECT_KEY = "arc-tech.excalidraw.activeProjectId";
const FONT_FAMILY = { Helvetica: 2 } as const;

type ExcalidrawApi = {
  updateScene: (scene: { elements?: readonly unknown[]; appState?: Partial<ArcAppState> }) => void;
  getSceneElements: () => readonly ArcElement[];
  getAppState: () => ArcAppState;
  setActiveTool?: (tool: { type: string; locked?: boolean }) => void;
};

type ArcAppState = {
  scrollX?: number;
  scrollY?: number;
  zoom?: number | { value?: number };
  selectedElementIds?: Record<string, boolean>;
  theme?: "dark" | "light";
};

type ArcElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: number[][];
  text?: string;
  link?: string | null;
  locked?: boolean;
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
      action?: "launch_orchestration";
    };
    arcComposer?: {
      source: "canvas-composer";
      role: "box" | "text";
      targetKey: string;
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

type CanvasPopover =
  | {
      type: "question";
      left: number;
      top: number;
      orchestrationId: number;
      questionId: string;
      title: string;
    }
  | {
      type: "workflow";
      left: number;
      top: number;
      orchestrationId: number | null;
      workflowNodeId: string;
      questionId?: string;
      title: string;
    };

type CanvasCommandKind = ArcCardMode | "orchestrate";

type CanvasComposerTarget =
  | { type: "command" }
  | { type: "task_message"; taskId: number; title: string }
  | { type: "orchestration_message"; orchestrationId: number; title: string }
  | { type: "question_message"; orchestrationId: number; questionId: string; title: string };

export default function App() {
  const excalidrawApiRef = useRef<ExcalidrawApi | null>(null);
  const canvasFrameRef = useRef<HTMLDivElement | null>(null);
  const cardsRef = useRef<ArcCard[]>([]);
  const activeProjectIdRef = useRef<number | null>(initialProjectId());
  const selectedCardIdRef = useRef<string | null>(null);
  const selectedWorkflowNodeIdRef = useRef<string | null>(null);
  const workflowGraphRef = useRef<ArcPersistedWorkflowGraph | null>(null);
  const workflowElementIdsRef = useRef<Set<string>>(new Set());
  const workflowElementSignaturesRef = useRef<Map<string, string>>(new Map());
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
  const [commandKind, setCommandKind] = useState<CanvasCommandKind>("direct_agent");
  const [composerTarget, setComposerTarget] = useState<CanvasComposerTarget>({ type: "command" });
  const [project, setProject] = useState<ArcProject | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [selectedCard, setSelectedCard] = useState<ArcCard | null>(null);
  const [selectedWorkflowNode, setSelectedWorkflowNode] = useState<ArcWorkflowNode | null>(null);
  const [taskDetail, setTaskDetail] = useState<ArcTaskDetail | null>(null);
  const [orchestrationDetail, setOrchestrationDetail] = useState<ArcOrchestrationView | null>(null);
  const [canvasPopover, setCanvasPopover] = useState<CanvasPopover | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const streamProjectId = activeProjectId && projects.some((candidate) => candidate.projectId === activeProjectId) ? activeProjectId : null;
  const workflowStream = useWorkflowStream(streamProjectId);

  const loadTaskDetail = useCallback(async (taskId: number) => {
    const detail = await getTaskHistory(taskId);
    setTaskDetail(detail);
    setError(null);
    return detail;
  }, []);

  const loadOrchestrationDetail = useCallback(async (orchestrationId: number) => {
    const detail = await getOrchestration(orchestrationId);
    setOrchestrationDetail(detail);
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
    const workflowElements = workflow
      ? graphToExcalidrawElements(workflow.graph, {
          persisted: workflow,
          avoidRects: cardsRef.current.map((card) => ({ x: card.x, y: card.y, width: card.width, height: card.height })),
        })
      : [];
    workflowElementIdsRef.current = new Set(workflowElements.map((element) => element.id));
    workflowElementSignaturesRef.current = workflowElementSignatureMap(workflowElements as readonly ArcElement[]);
    const api = excalidrawApiRef.current;
    if (!api) return;
    const current = api.getSceneElements();
    const nonWorkflowElements = current.filter((element) => !isWorkflowElement(element));
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
      replaceProjectIdInUrl(projectId);
      cardsRef.current = [];
      workflowGraphRef.current = null;
      workflowElementIdsRef.current = new Set();
      workflowElementSignaturesRef.current = new Map();
      setCards([]);
      setSelectedCard(null);
      setSelectedWorkflowNode(null);
      setTaskDetail(null);
      setOrchestrationDetail(null);
      setCanvasPopover(null);
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
    setSelectedCard(null);
    setTaskDetail(null);
    const node = nodeId ? workflowGraphRef.current?.graph.nodes.find((candidate) => candidate.id === nodeId) ?? null : null;
    setSelectedWorkflowNode(node);
    const orchestrationId = node?.kind === "open_question" ? workflowGraphRef.current?.orchestrationId ?? null : null;
    selectedOrchestrationIdRef.current = orchestrationId;
    if (orchestrationId) {
      void loadOrchestrationDetail(orchestrationId).catch((detailError) => {
        setError(detailError instanceof Error ? detailError.message : String(detailError));
      });
    } else {
      setOrchestrationDetail(null);
    }
  }, [loadOrchestrationDetail]);

  const closeSidebar = useCallback(() => {
    selectedCardIdRef.current = null;
    selectedWorkflowNodeIdRef.current = null;
    selectedTaskIdRef.current = null;
    selectedOrchestrationIdRef.current = null;
    setSelectedCard(null);
    setSelectedWorkflowNode(null);
    setTaskDetail(null);
    setOrchestrationDetail(null);
    setCanvasPopover(null);
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
    const nextStatus = workflowStatusText(
      workflowStream.status,
      workflowStream.revision,
      workflowStream.latestPatchReason,
      "Workflow idle",
      workflowStream.error,
    );
    setStatus((current) => (current.startsWith("Moved ") ? current : nextStatus));
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

  function focusCanvasComposer(): void {
    window.setTimeout(() => {
      const api = excalidrawApiRef.current;
      api?.setActiveTool?.({ type: "text" });
      api?.updateScene({ appState: { selectedElementIds: { [canvasComposerTextElementId()]: true } } });
    }, 0);
  }

  function openCanvasComposer(target: CanvasComposerTarget, initialText = ""): void {
    setComposerTarget(target);
    syncCanvasComposerTextBox(target, sameCanvasComposerTarget(composerTarget, target) ? undefined : initialText);
    focusCanvasComposer();
  }

  function openCommandComposer(kind = commandKind, clear = false): void {
    const target: CanvasComposerTarget = { type: "command" };
    setCommandKind(kind);
    setComposerTarget(target);
    syncCanvasComposerTextBox(target, clear ? "" : undefined, kind);
    focusCanvasComposer();
  }

  async function handleCanvasComposerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const content = getCanvasComposerText().trim();
    if (!content) {
      setError(composerEmptyMessage(composerTarget));
      syncCanvasComposerTextBox(composerTarget);
      return;
    }

    if (composerTarget.type === "command") {
      if (!project) {
        setError("Select or create an Excalidraw project first.");
        return;
      }
      if (commandKind === "direct_agent" && !project.prReady) {
        setError(projectBlockerText(project));
        return;
      }

      setBusy(true);
      try {
        const position = cardPositionInViewport(excalidrawApiRef.current, canvasFrameRef.current, spawnViewportRef);
        if (commandKind === "orchestrate") {
          const response = await submitOrchestrate(`/orchestrate ${content}`, project.projectId, position.x, position.y);
          applyCardsToScene([response.card, ...cardsRef.current.filter((card) => card.id !== response.card.id)]);
          if (response.workflow) {
            applyWorkflowToScene(response.workflow);
          }
          if (response.orchestration.questionCards?.length) {
            applyCardsToScene([
              response.card,
              ...response.orchestration.questionCards,
              ...cardsRef.current.filter((card) => card.id !== response.card.id && !response.orchestration.questionCards?.some((next) => next.id === card.id)),
            ]);
          }
          setOrchestrationDetail(response.orchestration);
          selectCard(response.card.id);
          clearCanvasComposerTextBox();
          setStatus(`Created orchestration #${response.orchestration.orchestration.id}`);
        } else {
          const response = await submitImplement(`/implement ${content}`, commandKind, project.projectId, position.x, position.y);
          applyCardsToScene([response.card, ...cardsRef.current.filter((card) => card.id !== response.card.id)]);
          selectCard(response.card.id);
          clearCanvasComposerTextBox();
          setStatus(
            commandKind === "direct_agent"
              ? `Created task ${response.taskId} (${response.status})`
              : "Created plan card",
          );
        }
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : String(submitError));
      } finally {
        setBusy(false);
      }
      return;
    }

    setChatBusy(true);
    try {
      if (composerTarget.type === "task_message") {
        const detail = await sendTaskMessage(composerTarget.taskId, content);
        setTaskDetail(detail);
        clearCanvasComposerTextBox();
        setStatus(`Queued follow-up for task #${detail.projectTaskNumber}`);
        await refresh(detail.projectId);
        return;
      }
      if (composerTarget.type === "orchestration_message") {
        const detail = await sendOrchestrationMessage(composerTarget.orchestrationId, content);
        setOrchestrationDetail(detail);
        clearCanvasComposerTextBox();
        setStatus(`Updated orchestration #${detail.orchestration.id}`);
        await refresh(detail.orchestration.projectId);
        return;
      }
      const detail = await answerOrchestrationQuestion(composerTarget.orchestrationId, composerTarget.questionId, [], content);
      setOrchestrationDetail(detail);
      clearCanvasComposerTextBox();
      setStatus(`Saved question answer for orchestration #${detail.orchestration.id}`);
      await refresh(detail.orchestration.projectId);
    } catch (chatError) {
      setError(chatError instanceof Error ? chatError.message : String(chatError));
    } finally {
      setChatBusy(false);
    }
  }

  function getCanvasComposerText(): string {
    const textElement = excalidrawApiRef.current?.getSceneElements().find((element) => element.id === canvasComposerTextElementId());
    const text = textElement?.text ?? "";
    return text === canvasComposerPlaceholder(composerTarget, commandKind) ? "" : text;
  }

  function clearCanvasComposerTextBox(): void {
    const api = excalidrawApiRef.current;
    if (!api) return;
    const elements = api.getSceneElements().filter((element) => !isCanvasComposerElement(element));
    sceneApplyUntilRef.current = Date.now() + 250;
    api.updateScene({ elements, appState: { selectedElementIds: {} } });
  }

  function syncCanvasComposerTextBox(target: CanvasComposerTarget, nextText?: string, kind = commandKind): void {
    const api = excalidrawApiRef.current;
    if (!api) return;
    const targetKey = canvasComposerTargetKey(target);
    const current = api.getSceneElements();
    const existingText = current.find((element) => element.id === canvasComposerTextElementId());
    const existingKey = existingText?.customData?.arcComposer?.targetKey;
    const existingValue = existingText?.text ?? "";
    const existingPlaceholder = canvasComposerPlaceholder(target, kind);
    const text = nextText !== undefined
      ? nextText || existingPlaceholder
      : existingKey === targetKey && existingValue
        ? existingValue
        : existingPlaceholder;
    const anchor = composerTextBoxPosition(api, canvasFrameRef.current);
    const nextElements = current.filter((element) => !isCanvasComposerElement(element));
    const composerElements = convertToExcalidrawElements(
      canvasComposerElements(target, targetKey, text, anchor.x, anchor.y, kind),
      { regenerateIds: false },
    );
    sceneApplyUntilRef.current = Date.now() + 250;
    api.updateScene({
      elements: [...nextElements, ...composerElements],
      appState: { selectedElementIds: { [canvasComposerTextElementId()]: true } },
    });
  }

  async function submitOptionAnswer(question: ArcPlannerQuestionView, selected: string[], customText = "") {
    if (!orchestrationDetail) return;
    setChatBusy(true);
    setError(null);
    try {
      const detail = await answerOrchestrationQuestion(orchestrationDetail.orchestration.id, question.id, selected, customText);
      setOrchestrationDetail(detail);
      setStatus(`Saved answer for orchestration #${detail.orchestration.id}`);
      await refresh(detail.orchestration.projectId);
    } catch (answerError) {
      setError(answerError instanceof Error ? answerError.message : String(answerError));
    } finally {
      setChatBusy(false);
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

  async function openQuestionPopoverFromCard(card: ArcCard, element: ArcElement) {
    const orchestrationId = card.metadata?.orchestrationId;
    const questionId = card.metadata?.questionId;
    if (!orchestrationId || !questionId) return;
    selectedCardIdRef.current = card.id;
    selectedWorkflowNodeIdRef.current = null;
    selectedTaskIdRef.current = null;
    selectedOrchestrationIdRef.current = orchestrationId;
    setSelectedCard(card);
    setSelectedWorkflowNode(null);
    setTaskDetail(null);
    const anchor = popoverAnchorForElement(element, excalidrawApiRef.current, canvasFrameRef.current);
    const detail = await loadOrchestrationDetail(orchestrationId);
    const question = detail.orchestration.questions?.find((candidate) => candidate.id === questionId);
    setCanvasPopover({
      type: "question",
      left: anchor.left,
      top: anchor.top,
      orchestrationId,
      questionId,
      title: question?.text ?? card.title,
    });
    openCanvasComposer({
      type: "question_message",
      orchestrationId,
      questionId,
      title: question?.text ?? card.title,
    });
  }

  async function openWorkflowPopoverFromElement(element: ArcElement) {
    const workflowNodeId = element.customData?.arcWorkflow?.workflowNodeId;
    if (!workflowNodeId) return;
    const node = workflowGraphRef.current?.graph.nodes.find((candidate) => candidate.id === workflowNodeId) ?? null;
    const orchestrationId = element.customData?.arcWorkflow?.orchestrationId ?? workflowGraphRef.current?.orchestrationId ?? null;
    selectedWorkflowNodeIdRef.current = workflowNodeId;
    selectedCardIdRef.current = null;
    selectedTaskIdRef.current = null;
    selectedOrchestrationIdRef.current = orchestrationId;
    setSelectedWorkflowNode(node);
    setSelectedCard(null);
    setTaskDetail(null);
    const anchor = popoverAnchorForElement(element, excalidrawApiRef.current, canvasFrameRef.current);
    let questionId: string | undefined;
    if (orchestrationId) {
      const detail = await loadOrchestrationDetail(orchestrationId);
      const question = detail.orchestration.questions?.find((candidate) => candidate.workflowNodeId === workflowNodeId || candidate.id === workflowNodeId);
      questionId = question?.id;
      if (questionId) {
        openCanvasComposer({
          type: "question_message",
          orchestrationId,
          questionId,
          title: question?.text ?? node?.title ?? workflowNodeId,
        });
      }
    } else {
      setOrchestrationDetail(null);
    }
    setCanvasPopover({
      type: "workflow",
      left: anchor.left,
      top: anchor.top,
      orchestrationId,
      workflowNodeId,
      questionId,
      title: node?.title ?? workflowNodeId,
    });
  }

  function handleCanvasPointerDown(_activeTool: unknown, pointerDownState: { hit?: { element?: ArcElement | null } }) {
    const element = pointerDownState.hit?.element;
    if (!element) {
      setCanvasPopover(null);
      return;
    }
    const cardId = cardIdFromElement(element);
    if (cardId) {
      const card = cardsRef.current.find((candidate) => candidate.id === cardId);
      if (element.customData?.arc?.action === "launch_orchestration" && card?.metadata?.orchestrationId) {
        void handleCanvasLaunchOrchestration(card.metadata.orchestrationId, card).catch((launchError) => {
          setError(launchError instanceof Error ? launchError.message : String(launchError));
        });
        return;
      }
      if (card?.metadata?.type === "orchestration_question") {
        void openQuestionPopoverFromCard(card, element).catch((popoverError) => {
          setError(popoverError instanceof Error ? popoverError.message : String(popoverError));
        });
        return;
      }
      if (card) {
        selectCard(card.id);
        setCanvasPopover(null);
        return;
      }
    }
    if (element.customData?.arcWorkflow?.workflowNodeId) {
      void openWorkflowPopoverFromElement(element).catch((popoverError) => {
        setError(popoverError instanceof Error ? popoverError.message : String(popoverError));
      });
      return;
    }
    setCanvasPopover(null);
  }

  async function handleUpdateSelectedPlan() {
    if (!orchestrationDetail) return;
    setChatBusy(true);
    setError(null);
    try {
      const detail = await updateOrchestrationPlan(orchestrationDetail.orchestration.id);
      setOrchestrationDetail(detail);
      setStatus(`Updated plan for orchestration #${detail.orchestration.id}`);
      await refresh(detail.orchestration.projectId);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setChatBusy(false);
    }
  }

  async function handleRemakeSelectedPlan() {
    if (!orchestrationDetail) return;
    setChatBusy(true);
    setError(null);
    try {
      const detail = await remakeOrchestrationPlan(orchestrationDetail.orchestration.id);
      setOrchestrationDetail(detail);
      setStatus(`Remade plan for orchestration #${detail.orchestration.id}`);
      await refresh(detail.orchestration.projectId);
    } catch (remakeError) {
      setError(remakeError instanceof Error ? remakeError.message : String(remakeError));
    } finally {
      setChatBusy(false);
    }
  }

  async function runOrchestrationLaunch(orchestrationId: number, sourceCard?: ArcCard | null) {
    const detail =
      orchestrationDetail?.orchestration.id === orchestrationId
        ? orchestrationDetail
        : await getOrchestration(orchestrationId);
    const readyToSpawn = orchestrationReadyForSpawn(detail.orchestration.status);
    if (readyToSpawn && !project?.prReady) {
      setError(projectBlockerText(project));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fallbackPosition = cardPositionInViewport(excalidrawApiRef.current, canvasFrameRef.current, spawnViewportRef);
      const response = await launchOrchestration(
        orchestrationId,
        sourceCard?.x ?? fallbackPosition.x,
        sourceCard?.y ?? fallbackPosition.y,
      );
      const responseCards = response.cards.length
        ? response.cards
        : response.orchestration.parentCard
          ? [response.orchestration.parentCard]
          : [];
      if (responseCards.length) {
        applyCardsToScene([...responseCards, ...cardsRef.current.filter((card) => !responseCards.some((next) => next.id === card.id))]);
      }
      setOrchestrationDetail(response.orchestration);
      if (response.orchestration.parentCard) {
        selectedCardIdRef.current = response.orchestration.parentCard.id;
        setSelectedCard(response.orchestration.parentCard);
      }
      setStatus(
        response.requiresApproval
          ? `Plan ready for review for orchestration #${response.orchestration.orchestration.id}`
          : `Spawned ${response.orchestration.agents.length} agents for orchestration #${response.orchestration.orchestration.id}`,
      );
      await refresh(response.orchestration.orchestration.projectId);
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : String(launchError));
    } finally {
      setBusy(false);
    }
  }

  async function handleLaunchSelectedOrchestration() {
    if (!orchestrationDetail) return;
    await runOrchestrationLaunch(orchestrationDetail.orchestration.id, selectedCard);
  }

  async function handleCanvasLaunchOrchestration(orchestrationId: number, sourceCard: ArcCard | null) {
    selectedWorkflowNodeIdRef.current = null;
    selectedTaskIdRef.current = null;
    selectedOrchestrationIdRef.current = orchestrationId;
    setSelectedWorkflowNode(null);
    setTaskDetail(null);
    if (sourceCard) {
      selectedCardIdRef.current = sourceCard.id;
      setSelectedCard(sourceCard);
    }
    await runOrchestrationLaunch(orchestrationId, sourceCard);
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
    if (!selectedWorkflowNodeId && !selectedCanvasComposerFromAppState(elements, appState)) {
      const selectedId = selectedCardIdFromAppState(elements, appState);
      if (selectedId !== selectedCardIdRef.current) {
        selectCard(selectedId);
      }
    }
    const workflow = workflowGraphRef.current;
    if (workflow && workflowLayerNeedsRestore(elements, workflowElementIdsRef.current, workflowElementSignaturesRef.current)) {
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

  const directAgentBlocked = composerTarget.type === "command" && commandKind === "direct_agent" && (!project || !project.prReady);
  const sidebarOpen = Boolean(selectedCard || selectedWorkflowNode);
  const composerBusy = composerTarget.type === "command" ? busy : chatBusy;
  const composerDisabled = composerBusy || connecting || directAgentBlocked;

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
            onPointerDown={(activeTool, pointerDownState) => handleCanvasPointerDown(activeTool, pointerDownState as unknown as { hit?: { element?: ArcElement | null } })}
            theme="dark"
          />
          {canvasPopover ? (
            <CanvasPopoverPanel
              popover={canvasPopover}
              detail={orchestrationDetail}
              node={canvasPopover.type === "workflow" ? selectedWorkflowNode : null}
              busy={chatBusy || busy}
              onSubmitQuestion={submitOptionAnswer}
              onOpenQuestionComposer={(question) => {
                const orchestrationId = canvasPopover.orchestrationId ?? orchestrationDetail?.orchestration.id;
                if (!orchestrationId) {
                  setError("Select an orchestration before replying to this question.");
                  return;
                }
                openCanvasComposer({
                  type: "question_message",
                  orchestrationId,
                  questionId: question.id,
                  title: question.text,
                });
              }}
              onUpdatePlan={handleUpdateSelectedPlan}
              onRemakePlan={handleRemakeSelectedPlan}
              onClose={() => setCanvasPopover(null)}
            />
          ) : null}
          <CanvasCommandDock
            target={composerTarget}
            commandKind={commandKind}
            statusText={error ??
              workflowStatusText(
                workflowStream.status,
                workflowStream.revision,
                workflowStream.latestPatchReason,
                status,
                workflowStream.error,
              )}
            busy={composerBusy}
            disabled={composerDisabled}
            onCommandKindChange={(kind) => {
              setCommandKind(kind);
              const target: CanvasComposerTarget = { type: "command" };
              setComposerTarget(target);
              syncCanvasComposerTextBox(target, undefined, kind);
              focusCanvasComposer();
            }}
            onNewCommand={() => openCommandComposer(commandKind, true)}
            onEnsureTextBox={() => syncCanvasComposerTextBox(composerTarget)}
            onSubmit={handleCanvasComposerSubmit}
            onRefresh={() => void refresh()}
            refreshDisabled={busy || chatBusy || connecting || !activeProjectId}
          />
        </div>
        {selectedWorkflowNode ? (
          <WorkflowSidebar
            node={selectedWorkflowNode}
            workflow={workflowGraphRef.current}
            orchestrationDetail={orchestrationDetail}
            streamStatus={workflowStream.status}
            streamError={workflowStream.error}
            latestPatchReason={workflowStream.latestPatchReason}
            onClose={closeSidebar}
          />
        ) : selectedCard && orchestrationDetail ? (
          <OrchestrationSidebar
            card={selectedCard}
            detail={orchestrationDetail}
            chatBusy={chatBusy || busy}
            onOpenPlannerReply={() => openCanvasComposer({
              type: "orchestration_message",
              orchestrationId: orchestrationDetail.orchestration.id,
              title: `Orchestration #${orchestrationDetail.orchestration.id}`,
            })}
            onUpdatePlan={handleUpdateSelectedPlan}
            onRemakePlan={handleRemakeSelectedPlan}
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
            chatBusy={chatBusy}
            onOpenFollowUp={() => taskDetail && openCanvasComposer({
              type: "task_message",
              taskId: taskDetail.numericTaskId,
              title: `Task #${taskDetail.projectTaskNumber}`,
            })}
            onClose={closeSidebar}
          />
        ) : null}
      </div>
    </div>
  );
}

function CanvasCommandDock(props: {
  target: CanvasComposerTarget;
  commandKind: CanvasCommandKind;
  statusText: string;
  busy: boolean;
  disabled: boolean;
  refreshDisabled: boolean;
  onCommandKindChange: (kind: CanvasCommandKind) => void;
  onNewCommand: () => void;
  onEnsureTextBox: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRefresh: () => void;
}) {
  return (
    <form className="canvas-command-dock" onSubmit={props.onSubmit}>
      <div className="composer-row">
        <label className="composer-command-select">
          <span>Command</span>
          <select
            value={props.commandKind}
            onChange={(event) => props.onCommandKindChange(event.target.value as CanvasCommandKind)}
            disabled={props.busy}
          >
            <option value="direct_agent">Direct Agent</option>
            <option value="plan_card_only">Plan Card Only</option>
            <option value="orchestrate">Orchestrate</option>
          </select>
        </label>
        <div className="composer-target">
          <span>{props.target.type === "command" ? "New command" : "Canvas reply"}</span>
          <strong>{composerTargetTitle(props.target, props.commandKind)}</strong>
        </div>
        {props.target.type !== "command" ? (
          <button className="refresh-button" type="button" onClick={props.onNewCommand} disabled={props.busy}>
            New Command
          </button>
        ) : null}
      </div>
      <div className="composer-actions">
        <button className="submit-button" type="submit" disabled={props.disabled}>
          {props.busy ? "Sending" : composerSubmitLabel(props.target, props.commandKind)}
        </button>
        <button className="refresh-button" type="button" onClick={props.onEnsureTextBox} disabled={props.busy}>
          Text Box
        </button>
        <button className="refresh-button" type="button" onClick={props.onRefresh} disabled={props.refreshDisabled}>
          Refresh
        </button>
        <div className="status-strip" aria-live="polite">
          {props.statusText}
        </div>
      </div>
    </form>
  );
}

function OrchestrationSidebar(props: {
  card: ArcCard;
  detail: ArcOrchestrationView;
  chatBusy: boolean;
  onOpenPlannerReply: () => void;
  onUpdatePlan: () => void;
  onRemakePlan: () => void;
  onLaunch: () => void;
  onOpenTask: (taskId: number) => void;
  onClose: () => void;
}) {
  const { detail } = props;
  const orchestration = detail.orchestration;
  const questions = orchestration.questions ?? [];
  const questionBatch = questionBatchState(questions);
  const canSpawn = orchestrationReadyForSpawn(orchestration.status);
  const canPreparePlan = orchestrationCanPreparePlan(orchestration.status);
  const workflowPatch = orchestration.latestWorkflowPatch;
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
        <span>Workflow</span>
        <strong>{orchestration.workflow ? `rev ${orchestration.workflow.revision}` : "not created"}</strong>
        <span>Patch</span>
        <strong>{workflowPatch ? workflowPatchLine(workflowPatch) : "none"}</strong>
      </div>
      {workflowPatch?.status === "rejected" && workflowPatch.error ? (
        <div className="sidebar-section error-block">
          <h3>Workflow Patch Rejected</h3>
          <pre>{workflowPatch.error}</pre>
        </div>
      ) : null}
      <div className="sidebar-section">
        <h3>Goal</h3>
        <pre>{orchestration.goal}</pre>
      </div>
      <div className="sidebar-section question-list">
        <h3>Open Questions</h3>
        {questionBatch.total ? (
          <div className={questionBatch.complete ? "question-batch-status complete" : "question-batch-status"}>
            <strong>{questionBatch.complete ? "Question batch complete" : `${questionBatch.unanswered} unanswered`}</strong>
            <span>
              {questionBatch.complete
                ? "Continue Planning can ask another wave, or Prepare Plan can build the agent plan."
                : "Answer the current wave before continuing the planner."}
            </span>
          </div>
        ) : null}
        {questions.length ? (
          questions.map((question) => (
            <QuestionSummary key={question.id} question={question} />
          ))
        ) : (
          <p>No planner questions recorded yet.</p>
        )}
      </div>
      <div className="sidebar-section action-row">
        <button
          type="button"
          onClick={props.onLaunch}
          disabled={(!canSpawn && !canPreparePlan) || props.chatBusy || (!canSpawn && questionBatch.total > 0 && !questionBatch.complete)}
        >
          {canSpawn ? "Spawn Agents" : "Prepare Plan"}
        </button>
        <button
          type="button"
          onClick={props.onUpdatePlan}
          disabled={props.chatBusy || !questionBatch.complete || orchestration.status === "agents_spawned"}
        >
          Continue Planning
        </button>
        <button
          type="button"
          onClick={props.onRemakePlan}
          disabled={props.chatBusy || orchestration.status === "agents_spawned"}
        >
          Remake Plan
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
      <div className="sidebar-section action-row">
        <button type="button" onClick={props.onOpenPlannerReply} disabled={props.chatBusy}>
          Reply to Planner
        </button>
      </div>
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

function CanvasPopoverPanel(props: {
  popover: CanvasPopover;
  detail: ArcOrchestrationView | null;
  node: ArcWorkflowNode | null;
  busy: boolean;
  onSubmitQuestion: (question: ArcPlannerQuestionView, selected: string[], customText?: string) => void;
  onOpenQuestionComposer: (question: ArcPlannerQuestionView) => void;
  onUpdatePlan: () => void;
  onRemakePlan: () => void;
  onClose: () => void;
}) {
  const question = props.popover.questionId
    ? props.detail?.orchestration.questions?.find((candidate) => candidate.id === props.popover.questionId) ?? null
    : null;
  const questionBatch = questionBatchState(props.detail?.orchestration.questions ?? []);
  return (
    <div className="canvas-popover" style={{ left: props.popover.left, top: props.popover.top }}>
      <div className="canvas-popover-header">
        <div>
          <span>{props.popover.type === "question" ? "Question" : "Workflow"}</span>
          <strong>{question?.text ?? props.node?.title ?? props.popover.title}</strong>
        </div>
        <button type="button" onClick={props.onClose} aria-label="Close canvas popover">
          Close
        </button>
      </div>
      {props.node && !question ? (
        <div className="canvas-popover-section">
          <p>{props.node.body ?? props.node.summary ?? "No description recorded."}</p>
          <span className="muted-copy">{props.node.kind} · {props.node.status}</span>
        </div>
      ) : null}
      {question ? (
        <QuestionAnswerControl
          question={question}
          disabled={props.busy || question.status === "deprecated"}
          onSubmitOption={(optionId) => props.onSubmitQuestion(question, [optionId])}
          onOpenComposer={() => props.onOpenQuestionComposer(question)}
        />
      ) : null}
      {props.detail ? (
        <div className="canvas-popover-actions">
          <button
            type="button"
            onClick={props.onUpdatePlan}
            disabled={props.busy || props.detail.orchestration.status === "agents_spawned" || (questionBatch.total > 0 && !questionBatch.complete)}
          >
            Continue Planning
          </button>
          <button type="button" onClick={props.onRemakePlan} disabled={props.busy || props.detail.orchestration.status === "agents_spawned"}>
            Remake Plan
          </button>
        </div>
      ) : null}
    </div>
  );
}

function QuestionSummary({ question }: { question: ArcPlannerQuestionView }) {
  return (
    <div className="question-summary">
      <strong>{question.text}</strong>
      <span>{question.source} · {question.status}</span>
      {question.recommendationRationale ? <p>{question.recommendationRationale}</p> : null}
      {question.answer ? <p>{question.answer.content}</p> : <p className="muted-copy">Click the question on the canvas to answer or chat.</p>}
    </div>
  );
}

function questionBatchState(questions: ArcPlannerQuestionView[]): { total: number; unanswered: number; complete: boolean } {
  const active = questions.filter((question) => question.status !== "deprecated");
  const unanswered = active.filter((question) => !question.answer && question.status !== "resolved");
  return {
    total: active.length,
    unanswered: unanswered.length,
    complete: active.length > 0 && unanswered.length === 0,
  };
}

function QuestionAnswerControl(props: {
  question: ArcPlannerQuestionView;
  disabled: boolean;
  onSubmitOption: (optionId: string) => void;
  onOpenComposer: () => void;
}) {
  function sendOption(optionId: string) {
    props.onSubmitOption(optionId);
  }
  const recommended = new Set(props.question.recommendedOptionIds ?? []);
  const saved = new Set(props.question.answer?.selectedOptionIds ?? []);
  return (
    <div className="question-answer">
      <div className="question-title">
        <strong>{props.question.text}</strong>
        <span>{props.question.source} · {props.question.status}</span>
      </div>
      {props.question.detail ? <p>{props.question.detail}</p> : null}
      {props.question.recommendationRationale ? (
        <p className="muted-copy">Recommended: {props.question.recommendationRationale}</p>
      ) : null}
      {props.question.options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={[saved.has(option.id) ? "selected" : "", recommended.has(option.id) ? "recommended" : ""].filter(Boolean).join(" ")}
          onClick={() => sendOption(option.id)}
          disabled={props.disabled}
        >
          <strong>
            {option.label}
            {saved.has(option.id) ? " (saved)" : recommended.has(option.id) ? " (recommended)" : ""}
          </strong>
          <span>{option.description}</span>
        </button>
      ))}
      {props.question.messages.length ? (
        <div className="question-thread">
          {props.question.messages.map((message) => (
            <div className="question-thread-message" key={message.id}>
              <span>{message.role} · {message.createdAt}</span>
              <p>{message.content}</p>
            </div>
          ))}
        </div>
      ) : null}
      {props.question.answer ? <p className="muted-copy">Latest: {props.question.answer.content}</p> : null}
      <button type="button" onClick={props.onOpenComposer} disabled={props.disabled}>
        Type custom answer
      </button>
    </div>
  );
}

function TaskSidebar(props: {
  card: ArcCard;
  detail: ArcTaskDetail | null;
  chatBusy: boolean;
  onOpenFollowUp: () => void;
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
          <div className="sidebar-section action-row">
            <button type="button" onClick={props.onOpenFollowUp} disabled={props.chatBusy}>
              Send Follow-up
            </button>
          </div>
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
  orchestrationDetail: ArcOrchestrationView | null;
  streamStatus: WorkflowStreamStatus;
  streamError: string | null;
  latestPatchReason: string | null;
  onClose: () => void;
}) {
  const workflowQuestion = props.orchestrationDetail?.orchestration.questions?.find((question) => question.workflowNodeId === props.node.id || question.id === props.node.id);
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
        <p>{workflowStatusText(props.streamStatus, props.workflow?.revision ?? null, props.latestPatchReason, "Workflow idle", props.streamError)}</p>
        <p className="muted-copy">Workflow nodes are read-only on the canvas in v1.</p>
      </div>
      {workflowQuestion ? (
        <div className="sidebar-section question-list">
          <h3>Question</h3>
          <QuestionSummary question={workflowQuestion} />
        </div>
      ) : null}
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
      const action = orchestrationActionForCard(card);
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
      const textHeight = isOrchestrationContainer && action ? Math.max(180, card.height - 104) : isOrchestrationContainer ? 132 : card.height - (links.length ? 70 : 36);
      const textWidth = card.width - 36;
      const textFontSize = isOrchestration ? 14 : 16;
      const displayLabel = fitCanvasText(card.label, textWidth, Math.max(80, textHeight), textFontSize);
      const elements = [
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
          boundElements: [{ type: "text", id: textElementId(card.id) }],
          groupIds: [card.id],
          locked: isOrchestrationContainer,
          customData: metadata,
        },
        {
          id: textElementId(card.id),
          type: "text",
          x: card.x + 18,
          y: card.y + 18,
          width: textWidth,
          height: Math.max(80, textHeight),
          text: displayLabel,
          originalText: displayLabel,
          fontSize: textFontSize,
          fontFamily: FONT_FAMILY.Helvetica,
          containerId: rectElementId(card.id),
          autoResize: false,
          lineHeight: 1.25,
          textAlign: "left",
          verticalAlign: "top",
          strokeColor: "#1f2937",
          backgroundColor: "transparent",
          groupIds: [card.id],
          locked: isOrchestrationContainer,
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
          fontFamily: FONT_FAMILY.Helvetica,
          textAlign: "left",
          verticalAlign: "top",
          strokeColor: "#1d4ed8",
          backgroundColor: "transparent",
          link: normalizeCanvasLink(link.url),
          groupIds: [card.id],
          customData: metadata,
        })),
      ];
      if (action) {
        const buttonWidth = 190;
        const buttonHeight = 46;
        const buttonX = card.x + card.width - buttonWidth - 32;
        const buttonY = card.y + 24;
        const actionMetadata = { arc: { ...metadata.arc, action: action.action } };
        elements.push(
          {
            id: actionButtonElementId(card.id),
            type: "rectangle",
            x: buttonX,
            y: buttonY,
            width: buttonWidth,
            height: buttonHeight,
            strokeColor: "#1d4ed8",
            backgroundColor: "#1d4ed8",
            fillStyle: "solid",
            roughness: 0,
            opacity: 100,
            roundness: { type: 3 },
            groupIds: [card.id],
            customData: actionMetadata,
          },
          {
            id: actionButtonLabelElementId(card.id),
            type: "text",
            x: buttonX + 20,
            y: buttonY + 13,
            width: buttonWidth - 40,
            height: 22,
            text: action.label,
            fontSize: 16,
            fontFamily: FONT_FAMILY.Helvetica,
            textAlign: "center",
            verticalAlign: "middle",
            strokeColor: "#ffffff",
            backgroundColor: "transparent",
            groupIds: [card.id],
            customData: actionMetadata,
          },
        );
      }
      return elements;
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

function selectedCanvasComposerFromAppState(elements: readonly ArcElement[], appState: ArcAppState): boolean {
  const selectedIds = appState.selectedElementIds ?? {};
  return elements.some((element) => selectedIds[element.id] && isCanvasComposerElement(element));
}

function isArcCardElement(element: ArcElement): boolean {
  return element.customData?.arc?.source === "excalidraw" || Boolean(cardIdFromElement(element));
}

function isWorkflowElement(element: ArcElement): boolean {
  return Boolean(element.customData?.arcWorkflow);
}

function isCanvasComposerElement(element: ArcElement): boolean {
  return element.customData?.arcComposer?.source === "canvas-composer";
}

function isArcManagedElement(element: ArcElement): boolean {
  return isArcCardElement(element) || isWorkflowElement(element) || isCanvasComposerElement(element);
}

function workflowLayerNeedsRestore(
  elements: readonly ArcElement[],
  expectedIds: ReadonlySet<string>,
  expectedSignatures: ReadonlyMap<string, string>,
): boolean {
  const actualElements = elements.filter(isWorkflowElement);
  const actualIds = new Set(actualElements.map((element) => element.id));
  if (actualIds.size !== expectedIds.size) {
    return true;
  }
  for (const expectedId of expectedIds) {
    if (!actualIds.has(expectedId)) return true;
  }
  for (const element of actualElements) {
    const expected = expectedSignatures.get(element.id);
    if (expected && expected !== workflowElementSignature(element)) return true;
  }
  return false;
}

function workflowElementSignatureMap(elements: readonly ArcElement[]): Map<string, string> {
  return new Map(elements.map((element) => [element.id, workflowElementSignature(element)]));
}

function workflowElementSignature(element: ArcElement): string {
  return JSON.stringify({
    type: element.type,
    x: Math.round(element.x),
    y: Math.round(element.y),
    width: Math.round(element.width),
    height: Math.round(element.height),
    points: element.points?.map((point) => point.map((value) => Math.round(value))),
    text: element.text,
  });
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

function actionButtonElementId(cardId: string): string {
  return `arc-card-${cardId}-action`;
}

function actionButtonLabelElementId(cardId: string): string {
  return `arc-card-${cardId}-action-label`;
}

function canvasComposerBoxElementId(): string {
  return "arc-canvas-composer-box";
}

function canvasComposerTextElementId(): string {
  return "arc-canvas-composer-text";
}

function canvasComposerTargetKey(target: CanvasComposerTarget): string {
  if (target.type === "command") return "command";
  if (target.type === "task_message") return `task:${target.taskId}`;
  if (target.type === "orchestration_message") return `orchestration:${target.orchestrationId}`;
  return `question:${target.orchestrationId}:${target.questionId}`;
}

function canvasComposerPlaceholder(target: CanvasComposerTarget, commandKind: CanvasCommandKind): string {
  return composerPlaceholder(target, commandKind);
}

function canvasComposerElements(
  target: CanvasComposerTarget,
  targetKey: string,
  text: string,
  x: number,
  y: number,
  commandKind: CanvasCommandKind,
): Parameters<typeof convertToExcalidrawElements>[0] {
  const width = 620;
  const height = 156;
  const placeholder = canvasComposerPlaceholder(target, commandKind);
  return [
    {
      id: canvasComposerBoxElementId(),
      type: "rectangle",
      x,
      y,
      width,
      height,
      strokeColor: "#2563eb",
      backgroundColor: "#111827",
      fillStyle: "solid",
      roughness: 1,
      opacity: 92,
      roundness: { type: 3 },
      groupIds: ["arc-canvas-composer"],
      customData: { arcComposer: { source: "canvas-composer", role: "box", targetKey } },
    },
    {
      id: canvasComposerTextElementId(),
      type: "text",
      x: x + 18,
      y: y + 16,
      width: width - 36,
      height: height - 32,
      text,
      originalText: text,
      fontSize: 20,
      fontFamily: FONT_FAMILY.Helvetica,
      lineHeight: 1.25,
      textAlign: "left",
      verticalAlign: "top",
      strokeColor: text === placeholder ? "#94a3b8" : "#e5edf8",
      backgroundColor: "transparent",
      autoResize: false,
      groupIds: ["arc-canvas-composer"],
      customData: { arcComposer: { source: "canvas-composer", role: "text", targetKey } },
    },
  ];
}

function cardIdFromElement(element: ArcElement): string | null {
  const metadataId = element.customData?.arc?.cardId;
  if (metadataId) return metadataId;
  const match = /^arc-card-(.+?)(?:-(?:text|link-\d+|action|action-label))?$/.exec(element.id);
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

function orchestrationActionForCard(card: ArcCard): { action: "launch_orchestration"; label: string } | null {
  const type = card.metadata?.type ?? card.mode;
  if (type !== "orchestration_parent" || !card.metadata?.orchestrationId) return null;
  if (card.status === "ready" || orchestrationReadyForSpawn(card.metadata.status ?? "")) {
    return { action: "launch_orchestration", label: "Start Plan" };
  }
  return null;
}

function fitCanvasText(text: string, width: number, height: number, fontSize: number): string {
  const charsPerLine = Math.max(10, Math.floor(width / (fontSize * 0.55)));
  const maxLines = Math.max(1, Math.floor(height / (fontSize * 1.25)));
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (lines.length >= maxLines) break;
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      if (!current) {
        current = word;
      } else if (`${current} ${word}`.length <= charsPerLine) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
      while (current.length > charsPerLine) {
        lines.push(current.slice(0, charsPerLine));
        current = current.slice(charsPerLine);
      }
      if (lines.length >= maxLines) break;
    }
    if (lines.length < maxLines && current) {
      lines.push(current);
    }
  }
  if (lines.length === 0) return "";
  const sourceHasMore = text.split("\n").length > lines.length || lines.join(" ").length < text.replace(/\s+/g, " ").trim().length;
  if (sourceHasMore) {
    const last = lines[lines.length - 1] ?? "";
    lines[lines.length - 1] = `${last.slice(0, Math.max(0, charsPerLine - 3)).trimEnd()}...`;
  }
  return lines.join("\n");
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

function composerTextBoxPosition(api: ExcalidrawApi, frame: HTMLDivElement | null): { x: number; y: number } {
  const appState = api.getAppState();
  const zoom = zoomValue(appState.zoom);
  const frameWidth = frame?.clientWidth ?? window.innerWidth;
  const frameHeight = frame?.clientHeight ?? window.innerHeight;
  const screenX = Math.max(28, Math.round((frameWidth - 620) / 2));
  const screenY = Math.max(110, frameHeight - 250);
  return {
    x: Math.round((screenX - (appState.scrollX ?? 0)) / zoom),
    y: Math.round((screenY - (appState.scrollY ?? 0)) / zoom),
  };
}

function popoverAnchorForElement(
  element: Pick<ArcElement, "x" | "y" | "width" | "height">,
  api: ExcalidrawApi | null,
  frame: HTMLDivElement | null,
): { left: number; top: number } {
  const appState = api?.getAppState();
  const zoom = zoomValue(appState?.zoom);
  const frameWidth = frame?.clientWidth ?? window.innerWidth;
  const frameHeight = frame?.clientHeight ?? window.innerHeight;
  const rawLeft = (element.x + element.width + 14) * zoom + (appState?.scrollX ?? 0);
  const rawTop = element.y * zoom + (appState?.scrollY ?? 0);
  return {
    left: Math.round(Math.max(16, Math.min(frameWidth - 396, rawLeft))),
    top: Math.round(Math.max(16, Math.min(frameHeight - 300, rawTop))),
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

function workflowStatusText(
  streamStatus: WorkflowStreamStatus,
  revision: number | null,
  latestPatchReason: string | null,
  fallback: string,
  streamError?: string | null,
): string {
  let connected: string;
  switch (streamStatus) {
    case "idle":
      connected = "Workflow idle";
      break;
    case "connecting":
      connected = "Workflow connecting";
      break;
    case "connected":
      connected = "Workflow connected";
      break;
    case "reconnecting":
      connected = streamError ? `Workflow reconnecting: ${streamError}` : "Workflow reconnecting";
      break;
    case "disconnected":
      connected = streamError ? `Workflow disconnected: ${streamError}` : "Workflow disconnected";
      break;
    case "error":
      connected = streamError ? `Workflow stream error: ${streamError}` : "Workflow stream error";
      break;
  }
  const parts = [connected, revision !== null ? `rev ${revision}` : "no graph", latestPatchReason ? `latest: ${latestPatchReason}` : fallback].filter(Boolean);
  return parts.join(" · ");
}

function orchestrationReadyForSpawn(status: string): boolean {
  return ["ready_for_approval", "READY_TO_ORCHESTRATE", "approved_for_spawn"].includes(status);
}

function orchestrationCanPreparePlan(status: string): boolean {
  return ["PLANNING", "WAITING_USER", "waiting_for_user_choice", "asking_questions", "refining_plan", "draft_created"].includes(status);
}

function workflowPatchLine(patch: { status?: string; reason?: string; resultingRevision?: number; error?: string }): string {
  if (patch.status === "applied") {
    return `applied${patch.resultingRevision !== undefined ? ` rev ${patch.resultingRevision}` : ""}${patch.reason ? ` · ${patch.reason}` : ""}`;
  }
  if (patch.status === "rejected") {
    return `rejected${patch.reason ? ` · ${patch.reason}` : ""}${patch.error ? ` · ${patch.error}` : ""}`;
  }
  return patch.status ?? "none";
}

function sameCanvasComposerTarget(left: CanvasComposerTarget, right: CanvasComposerTarget): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "command" && right.type === "command") return true;
  if (left.type === "task_message" && right.type === "task_message") return left.taskId === right.taskId;
  if (left.type === "orchestration_message" && right.type === "orchestration_message") return left.orchestrationId === right.orchestrationId;
  if (left.type === "question_message" && right.type === "question_message") {
    return left.orchestrationId === right.orchestrationId && left.questionId === right.questionId;
  }
  return false;
}

function composerTargetTitle(target: CanvasComposerTarget, commandKind: CanvasCommandKind): string {
  switch (target.type) {
    case "command":
      return commandKindLabel(commandKind);
    case "task_message":
      return `Follow-up to ${target.title}`;
    case "orchestration_message":
      return `Planner reply for ${target.title}`;
    case "question_message":
      return target.title;
  }
}

function composerPlaceholder(target: CanvasComposerTarget, commandKind: CanvasCommandKind): string {
  switch (target.type) {
    case "task_message":
      return "Ask the agent for changes...";
    case "orchestration_message":
      return "Reply to the planner...";
    case "question_message":
      return "Type your own answer for this question...";
    case "command":
      if (commandKind === "orchestrate") return "Describe the workflow you want the planner to create...";
      if (commandKind === "plan_card_only") return "Describe the plan card you want to place on the canvas...";
      return "Describe the implementation task for a direct agent...";
  }
}

function composerSubmitLabel(target: CanvasComposerTarget, commandKind: CanvasCommandKind): string {
  if (target.type === "command") {
    return commandKind === "orchestrate" ? "Run Orchestrate" : "Run";
  }
  if (target.type === "question_message") return "Save Answer";
  if (target.type === "orchestration_message") return "Send Planner Reply";
  return "Send Follow-up";
}

function composerEmptyMessage(target: CanvasComposerTarget): string {
  if (target.type === "command") return "Enter a non-empty command message.";
  if (target.type === "question_message") return "Enter an answer.";
  if (target.type === "orchestration_message") return "Enter a planner message.";
  return "Enter a follow-up message.";
}

function commandKindLabel(kind: CanvasCommandKind): string {
  if (kind === "orchestrate") return "Orchestrate";
  if (kind === "plan_card_only") return "Plan Card Only";
  return "Direct Agent";
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
  if (preferredId) {
    window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
  }
  return projects[0]?.projectId ?? null;
}

function replaceProjectIdInUrl(projectId: number): void {
  const url = new URL(window.location.href);
  url.searchParams.set("projectId", String(projectId));
  url.searchParams.delete("taskId");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
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
