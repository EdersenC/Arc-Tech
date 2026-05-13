import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import {
  answerOrchestrationQuestion,
  connectProjectRemote,
  createCanvasPrompt,
  createCanvasPromptLink,
  createProject,
  deleteCanvasPrompt,
  deleteCanvasPromptLink,
  dispatchCanvasPromptLink,
  getProject,
  getOrchestration,
  getTaskHistory,
  launchOrchestration,
  listCanvasPrompts,
  listProjects,
  listTasks,
  logCanvasDebugEvent,
  remakeOrchestrationPlan,
  updateCanvasPrompt,
  updateOrchestrationPlan,
  updateOrchestrationSafetyRecord,
  updateCardPosition,
  type ArcCard,
  type ArcCanvasPromptBundle,
  type ArcCanvasPromptCommandKind,
  type ArcCanvasPromptLink,
  type ArcCanvasPromptNode,
  type ArcCanvasPromptTargetKind,
  type ArcLink,
  type ArcOrchestrationSafetyRecord,
  type ArcOrchestrationSafetyStatus,
  type ArcOrchestrationView,
  type ArcPlannerQuestionView,
  type ArcProject,
  type ArcTaskDetail,
} from "./api";
import { commandLabels, parsePromptText, promptText } from "./canvas-prompts/commands";
import { promptBodyTextBounds, promptCommandTextBounds, promptsToElements, promptLayoutFromElements, stripPromptTextBinding, type PromptElement } from "./canvas-prompts/elements";
import { promptBoxElementId, promptCommandElementId, promptLinkElementId, promptTextElementId } from "./canvas-prompts/ids";
import { graphToExcalidrawElements } from "./workflows/workflowElements";
import { useWorkflowStream, type WorkflowStreamStatus } from "./workflows/useWorkflowStream";
import type { ArcPersistedWorkflowGraph, ArcWorkflowNode } from "./workflows/api";

const ACTIVE_PROJECT_KEY = "arc-tech.excalidraw.activeProjectId";
const LOCAL_OWNER_KEY = "arc-tech.excalidraw.localOwnerId";
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
  editingElement?: { id?: string } | null;
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
  strokeColor?: string;
  boundElements?: Array<{ type?: string; id?: string | null }> | null;
  containerId?: string | null;
  autoResize?: boolean;
  startBinding?: { elementId?: string | null } | null;
  endBinding?: { elementId?: string | null } | null;
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
    arcWorkflow?: {
      graphId: string;
      projectId: number;
      orchestrationId: number | null;
      workflowNodeId?: string;
      workflowEdgeId?: string;
      semanticType: string;
      revision: number;
    };
    arcPrompt?: {
      source: "canvas-prompt";
      role: "box" | "text" | "command" | "arrow";
      promptId: string;
      linkId?: string;
      ownerId: string;
      projectId: number;
      commandKind: string;
      status: string;
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

type PromptDispatchTarget = {
  targetKind: ArcCanvasPromptTargetKind;
  targetId: string;
  targetOrchestrationId?: number | null;
  targetWorkflowGraphId?: string | null;
  targetWorkflowNodeId?: string | null;
};

export default function App() {
  const excalidrawApiRef = useRef<ExcalidrawApi | null>(null);
  const canvasFrameRef = useRef<HTMLDivElement | null>(null);
  const cardsRef = useRef<ArcCard[]>([]);
  const canvasPromptsRef = useRef<ArcCanvasPromptBundle>({ prompts: [], links: [] });
  const selectedPromptIdRef = useRef<string | null>(null);
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
  const promptPersistTimerRef = useRef<number | null>(null);
  const pendingPromptUpdatesRef = useRef<Map<string, Partial<ArcCanvasPromptNode> & { text?: string }>>(new Map());
  const detectedPromptArrowIdsRef = useRef<Set<string>>(new Set());
  const promptArrowDebugSignaturesRef = useRef<Map<string, string>>(new Map());
  const invalidPromptArrowIdsRef = useRef<Set<string>>(new Set());
  const deletingPromptIdsRef = useRef<Set<string>>(new Set());
  const sceneApplyUntilRef = useRef(0);
  const spawnViewportRef = useRef({ key: "", count: 0 });
  const [cards, setCards] = useState<ArcCard[]>([]);
  const [canvasPrompts, setCanvasPrompts] = useState<ArcCanvasPromptBundle>({ prompts: [], links: [] });
  const [projects, setProjects] = useState<ArcProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(activeProjectIdRef.current);
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
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

  const updatePromptState = useCallback((bundle: ArcCanvasPromptBundle) => {
    canvasPromptsRef.current = bundle;
    setCanvasPrompts(bundle);
    if (selectedPromptIdRef.current) {
      const stillSelected = bundle.prompts.some((prompt) => prompt.id === selectedPromptIdRef.current);
      if (!stillSelected) {
        selectedPromptIdRef.current = null;
        setSelectedPromptId(null);
      }
    }
  }, []);

  const applyPromptsToScene = useCallback((bundle: ArcCanvasPromptBundle, options: { preserveActiveText?: boolean } = {}) => {
    updatePromptState(bundle);
    const api = excalidrawApiRef.current;
    if (!api) return;
    const current = api.getSceneElements();
    if (options.preserveActiveText && promptTextIsEditing(current, api.getAppState(), selectedPromptIdRef.current)) {
      return;
    }
    const nonPromptElements = current.filter((element) => !isPromptElement(element));
    const targetRects = promptTargetRectsFromElements(nonPromptElements);
    const existingPromptElements = current.filter(isPromptElement);
    const promptElements = preservePromptArrowBindings(
      promptsToElements(bundle.prompts, bundle.links, targetRects) as readonly ArcElement[],
      existingPromptElements,
    );
    sceneApplyUntilRef.current = Date.now() + 250;
    api.updateScene({ elements: [...nonPromptElements, ...promptElements] });
  }, [updatePromptState]);

  const refresh = useCallback(async (projectId = activeProjectIdRef.current) => {
    if (!projectId) {
      return;
    }
    const [tasksResponse, projectResponse, promptResponse] = await Promise.all([
      listTasks(projectId),
      getProject(projectId),
      listCanvasPrompts(projectId),
    ]);
    applyCardsToScene(tasksResponse.cards);
    applyPromptsToScene(promptResponse, { preserveActiveText: true });
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
  }, [applyCardsToScene, applyPromptsToScene, loadOrchestrationDetail, loadTaskDetail]);

  const activateProject = useCallback(
    (projectId: number) => {
      if (!Number.isInteger(projectId) || projectId <= 0) return;
      activeProjectIdRef.current = projectId;
      setActiveProjectId(projectId);
      window.localStorage.setItem(ACTIVE_PROJECT_KEY, String(projectId));
      replaceProjectIdInUrl(projectId);
      cardsRef.current = [];
      canvasPromptsRef.current = { prompts: [], links: [] };
      selectedPromptIdRef.current = null;
      workflowGraphRef.current = null;
      workflowElementIdsRef.current = new Set();
      workflowElementSignaturesRef.current = new Map();
      setCards([]);
      setCanvasPrompts({ prompts: [], links: [] });
      setSelectedPromptId(null);
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

  useEffect(() => {
    const interval = window.setInterval(() => {
      pulsePromptArrows();
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

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

  async function handleNewPromptBox(kind: ArcCanvasPromptCommandKind = "orchestrate", body = "") {
    if (!project) {
      setError("Select or create an Excalidraw project first.");
      return;
    }
    setError(null);
    try {
      const owner = localCanvasOwner();
      const anchor = cardPositionInViewport(excalidrawApiRef.current, canvasFrameRef.current, spawnViewportRef);
      const response = await createCanvasPrompt(project.projectId, {
        ownerId: owner.ownerId,
        ownerLabel: owner.ownerLabel,
        commandKind: kind,
        body,
        x: anchor.x,
        y: anchor.y,
      });
      const next = {
        prompts: [...canvasPromptsRef.current.prompts.filter((prompt) => prompt.id !== response.prompt.id), response.prompt],
        links: canvasPromptsRef.current.links,
      };
      applyPromptsToScene(next);
      selectedPromptIdRef.current = response.prompt.id;
      setSelectedPromptId(response.prompt.id);
      focusPromptText(response.prompt.id);
      setStatus("Created prompt box");
    } catch (promptError) {
      setError(promptError instanceof Error ? promptError.message : String(promptError));
    }
  }

  async function handlePromptCommandChange(prompt: ArcCanvasPromptNode, commandKind: ArcCanvasPromptCommandKind) {
    try {
      const response = await updateCanvasPrompt(prompt.id, { commandKind, text: promptText(commandKind, prompt.body) });
      const next = replacePrompt(canvasPromptsRef.current, response.prompt);
      applyPromptsToScene(next);
      selectedPromptIdRef.current = response.prompt.id;
      setSelectedPromptId(response.prompt.id);
      focusPromptText(response.prompt.id);
    } catch (promptError) {
      setError(promptError instanceof Error ? promptError.message : String(promptError));
    }
  }

  async function handleDeleteSelectedPrompt() {
    if (!selectedPromptId) return;
    const prompt = canvasPromptsRef.current.prompts.find((candidate) => candidate.id === selectedPromptId);
    if (!prompt) return;
    if (promptDeletionLocked(prompt)) {
      setError("Sent prompt boxes are kept as historical workflow context.");
      applyPromptsToScene(canvasPromptsRef.current);
      return;
    }
    const previous = canvasPromptsRef.current;
    const next = {
      prompts: canvasPromptsRef.current.prompts.filter((candidate) => candidate.id !== prompt.id),
      links: canvasPromptsRef.current.links.filter((link) => link.promptNodeId !== prompt.id),
    };
    deletingPromptIdsRef.current.add(prompt.id);
    pendingPromptUpdatesRef.current.delete(prompt.id);
    selectedPromptIdRef.current = null;
    setSelectedPromptId(null);
    applyPromptsToScene(next);
    try {
      await deleteCanvasPrompt(prompt.id);
      deletingPromptIdsRef.current.delete(prompt.id);
      setStatus("Deleted prompt box");
    } catch (deleteError) {
      deletingPromptIdsRef.current.delete(prompt.id);
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      applyPromptsToScene(previous);
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
    const promptId = element.customData?.arcPrompt?.promptId;
    if (promptId) {
      selectedPromptIdRef.current = promptId;
      setSelectedPromptId(promptId);
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

  async function handleSafetyStatus(recordId: number, status: ArcOrchestrationSafetyStatus) {
    if (!orchestrationDetail) return;
    setChatBusy(true);
    setError(null);
    try {
      await updateOrchestrationSafetyRecord(recordId, status);
      const detail = await loadOrchestrationDetail(orchestrationDetail.orchestration.id);
      setStatus(`Marked safety record #${recordId} ${status}`);
      setOrchestrationDetail(detail);
    } catch (safetyError) {
      setError(safetyError instanceof Error ? safetyError.message : String(safetyError));
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
    if (!selectedWorkflowNodeId) {
      const selectedId = selectedCardIdFromAppState(elements, appState);
      if (selectedId !== selectedCardIdRef.current) {
        selectCard(selectedId);
      }
    }
    const selectedPromptIdFromScene = selectedPromptIdFromAppState(elements, appState);
    if (selectedPromptIdFromScene !== selectedPromptId) {
      selectedPromptIdRef.current = selectedPromptIdFromScene;
      setSelectedPromptId(selectedPromptIdFromScene);
    }
    const workflow = workflowGraphRef.current;
    if (workflow && workflowLayerNeedsRestore(elements, workflowElementIdsRef.current, workflowElementSignaturesRef.current)) {
      applyWorkflowToScene(workflow);
    }
    handlePromptLayerChange(elements, appState);
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

  function handlePromptLayerChange(elements: readonly ArcElement[], appState: ArcAppState) {
    const bundle = canvasPromptsRef.current;
    if (!bundle.prompts.length && !bundle.links.length) {
      detectPromptArrowLinks(elements);
      return;
    }

    const promptElements = elements.filter(isPromptElement);
    const promptElementIds = new Set(promptElements.map((element) => element.id));
    const promptLayouts = promptLayoutFromElements(promptElements as readonly PromptElement[]);
    let needsRestore = false;
    for (const prompt of bundle.prompts) {
      if (deletingPromptIdsRef.current.has(prompt.id)) {
        continue;
      }
      const hasBox = promptElementIds.has(promptBoxElementId(prompt.id));
      const hasText = promptElementIds.has(promptTextElementId(prompt.id));
      const hasCommand = promptElementIds.has(promptCommandElementId(prompt.id));
      if (!hasBox) {
        if (!promptDeletionLocked(prompt)) {
          requestPromptDelete(prompt.id);
        } else {
          needsRestore = true;
        }
        continue;
      }
      if (hasBox && (!hasText || !hasCommand)) {
        if (!promptDeletionLocked(prompt)) {
          requestPromptDelete(prompt.id);
        } else {
          needsRestore = true;
        }
        continue;
      }
      const layout = promptLayouts.get(prompt.id);
      if (!layout) {
        if (!promptDeletionLocked(prompt)) {
          requestPromptDelete(prompt.id);
        } else {
          needsRestore = true;
        }
        continue;
      }
      const parsed = layout.text !== undefined ? parsePromptText(layout.text, prompt.commandKind) : null;
      const changes: Partial<ArcCanvasPromptNode> & { text?: string } = {};
      if (layout.x !== undefined && layout.x !== prompt.x) changes.x = layout.x;
      if (layout.y !== undefined && layout.y !== prompt.y) changes.y = layout.y;
      if (layout.width !== undefined && layout.width !== prompt.width) changes.width = layout.width;
      if (layout.height !== undefined && layout.height !== prompt.height) changes.height = layout.height;
      if (parsed && (parsed.body !== prompt.body || parsed.commandKind !== prompt.commandKind)) {
        changes.text = layout.text;
        changes.commandKind = parsed.commandKind;
        changes.body = parsed.body;
      }
      if (Object.keys(changes).length) {
        pendingPromptUpdatesRef.current.set(prompt.id, { ...pendingPromptUpdatesRef.current.get(prompt.id), ...changes });
      }
    }

    for (const link of bundle.links) {
      if (!elements.some((element) => element.id === promptLinkElementId(link.id))) {
        if (link.status === "sent" || link.status === "dirty") {
          needsRestore = true;
        } else {
          void deleteCanvasPromptLink(link.id)
            .then(() => {
              const next = {
                prompts: canvasPromptsRef.current.prompts,
                links: canvasPromptsRef.current.links.filter((candidate) => candidate.id !== link.id),
              };
              applyPromptsToScene(next);
            })
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)));
        }
      }
    }
    if (needsRestore) {
      applyPromptsToScene(bundle);
    } else {
      normalizePromptElementBounds(elements, appState);
    }
    flushPromptUpdatesSoon();
    detectPromptArrowLinks(elements);
  }

  function requestPromptDelete(promptId: string) {
    if (deletingPromptIdsRef.current.has(promptId)) return;
    deletingPromptIdsRef.current.add(promptId);
    pendingPromptUpdatesRef.current.delete(promptId);
    const previous = canvasPromptsRef.current;
    const next = {
      prompts: previous.prompts.filter((candidate) => candidate.id !== promptId),
      links: previous.links.filter((link) => link.promptNodeId !== promptId),
    };
    if (selectedPromptIdRef.current === promptId) {
      selectedPromptIdRef.current = null;
      setSelectedPromptId(null);
    }
    applyPromptsToScene(next);
    void deleteCanvasPrompt(promptId)
      .then(() => {
        deletingPromptIdsRef.current.delete(promptId);
        setStatus("Deleted prompt box");
      })
      .catch((deleteError) => {
        deletingPromptIdsRef.current.delete(promptId);
        setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
        applyPromptsToScene(previous);
      });
  }

  function normalizePromptElementBounds(elements: readonly ArcElement[], appState: ArcAppState) {
    const api = excalidrawApiRef.current;
    if (!api) return;
    const byId = new Map(elements.map((element) => [element.id, element]));
    let changed = false;
    const nextElements = elements.map((element) => {
      const promptId = element.customData?.arcPrompt?.promptId;
      if (!promptId) return element;
      const box = byId.get(promptBoxElementId(promptId));
      if (!box) return element;
      if (element.id === promptTextElementId(promptId)) {
        if (promptTextIsEditing(elements, appState, promptId)) return element;
        const bounds = promptBodyTextBounds(box);
        if (!sameRect(element, bounds) || element.containerId) {
          changed = true;
          return { ...element, ...bounds, containerId: null, autoResize: false };
        }
      }
      if (element.id === promptCommandElementId(promptId)) {
        const bounds = promptCommandTextBounds(box);
        if (!sameRect(element, bounds)) {
          changed = true;
          return { ...element, ...bounds };
        }
      }
      if (element.id === promptBoxElementId(promptId) && element.boundElements?.length) {
        const nextBoundElements = stripPromptTextBinding(element.boundElements, promptId);
        if (!sameBoundElements(element.boundElements, nextBoundElements)) {
          changed = true;
          return { ...element, boundElements: nextBoundElements };
        }
      }
      return element;
    });
    if (!changed) return;
    sceneApplyUntilRef.current = Date.now() + 120;
    api.updateScene({ elements: nextElements });
  }

  function pulsePromptArrows() {
    const api = excalidrawApiRef.current;
    if (!api) return;
    const sendingArrowIds = new Set(
      canvasPromptsRef.current.links
        .filter((link) => link.status === "sending")
        .flatMap((link) => [promptLinkElementId(link.id), link.arrowElementId].filter(Boolean)),
    );
    const invalidArrowIds = new Set(invalidPromptArrowIdsRef.current);
    if (!sendingArrowIds.size && !invalidArrowIds.size) return;
    const pulseOn = Math.floor(Date.now() / 1000) % 2 === 0;
    const sendingColor = pulseOn ? "#38bdf8" : "#fbbf24";
    const invalidColor = pulseOn ? "#ef4444" : "#7f1d1d";
    const seenArrowIds = new Set<string>();
    let changed = false;
    const nextElements = api.getSceneElements().map((element) => {
      if (invalidArrowIds.has(element.id)) seenArrowIds.add(element.id);
      const color = sendingArrowIds.has(element.id) ? sendingColor : invalidArrowIds.has(element.id) ? invalidColor : null;
      if (!color || element.strokeColor === color) return element;
      changed = true;
      return { ...element, strokeColor: color };
    });
    for (const arrowId of invalidArrowIds) {
      if (!seenArrowIds.has(arrowId)) invalidPromptArrowIdsRef.current.delete(arrowId);
    }
    if (!changed) return;
    sceneApplyUntilRef.current = Date.now() + 120;
    api.updateScene({ elements: nextElements });
  }

  function flushPromptUpdatesSoon() {
    if (promptPersistTimerRef.current) {
      window.clearTimeout(promptPersistTimerRef.current);
    }
    if (pendingPromptUpdatesRef.current.size === 0) {
      return;
    }
    promptPersistTimerRef.current = window.setTimeout(() => {
      const pending = Array.from(pendingPromptUpdatesRef.current.entries());
      pendingPromptUpdatesRef.current.clear();
      for (const [promptId, changes] of pending) {
        void updateCanvasPrompt(promptId, changes)
          .then(async (response) => {
            const next = replacePrompt(canvasPromptsRef.current, response.prompt);
            const api = excalidrawApiRef.current;
            if (api && promptTextIsEditing(api.getSceneElements(), api.getAppState(), promptId)) {
              updatePromptState(next);
            } else {
              applyPromptsToScene(next);
            }
            const dirtyLink = next.links.find((link) => link.promptNodeId === promptId && (link.status === "dirty" || link.status === "linked" || link.status === "waiting_for_body" || link.status === "failed"));
            if (dirtyLink && response.prompt.body.trim()) {
              await dispatchPromptLink(dirtyLink.id);
            }
          })
          .catch((promptError) => setError(promptError instanceof Error ? promptError.message : String(promptError)));
      }
    }, 800);
  }

  function detectPromptArrowLinks(elements: readonly ArcElement[]) {
    const elementsById = new Map(elements.map((element) => [element.id, element]));
    for (const element of elements) {
      if (element.type !== "arrow" || isPromptElement(element)) continue;
      if (detectedPromptArrowIdsRef.current.has(element.id)) continue;
      const start = element.startBinding?.elementId ? elementsById.get(element.startBinding.elementId) : null;
      const end = element.endBinding?.elementId ? elementsById.get(element.endBinding.elementId) : null;
      const boundCandidates = boundEndpointCandidatesForArrow(elements, element.id);
      const resolvedStart = resolveBindingOwner(start ?? null, elements);
      const resolvedEnd = resolveBindingOwner(end ?? null, elements);
      const resolvedBoundCandidates = boundCandidates.map((candidate) => resolveBindingOwner(candidate, elements) ?? candidate);
      const detected =
        promptLinkTargetFromEndpoints(resolvedStart, resolvedEnd, workflowGraphRef.current, cardsRef.current) ??
        promptLinkTargetFromBoundCandidates(resolvedBoundCandidates, workflowGraphRef.current, cardsRef.current) ??
        promptLinkTargetFromArrowGeometry(element, resolvedStart, resolvedEnd, resolvedBoundCandidates, elements, workflowGraphRef.current, cardsRef.current) ??
        promptOnlyOrchestrateTarget(element.id, resolvedStart, resolvedEnd, resolvedBoundCandidates, canvasPromptsRef.current.prompts);
      logPromptArrowBindingDebug(element, start ?? null, end ?? null, resolvedStart, resolvedEnd, boundCandidates, resolvedBoundCandidates, detected, elements);
      if (!detected) {
        if (arrowHasPromptEndpoint(resolvedStart, resolvedEnd, resolvedBoundCandidates)) {
          invalidPromptArrowIdsRef.current.add(element.id);
          setError("Connect this prompt to a workflow node, goal, open question, or task card.");
        }
        continue;
      }
      invalidPromptArrowIdsRef.current.delete(element.id);
      detectedPromptArrowIdsRef.current.add(element.id);
      logPromptArrowDispatchTriggered(element, detected);
      void createAndDispatchPromptLink(detected.promptId, detected.target, element.id).catch((linkError) => {
        setError(linkError instanceof Error ? linkError.message : String(linkError));
        removeSceneElement(element.id);
      });
    }
  }

  function logPromptArrowBindingDebug(
    arrow: ArcElement,
    start: ArcElement | null,
    end: ArcElement | null,
    resolvedStart: ArcElement | null,
    resolvedEnd: ArcElement | null,
    boundCandidates: readonly ArcElement[],
    resolvedBoundCandidates: readonly ArcElement[],
    detected: { promptId: string; target: PromptDispatchTarget } | null,
    elements: readonly ArcElement[],
  ) {
    const endpoints = arrowEndpointPoints(arrow);
    const event = {
      event: detected ? "prompt_arrow_detected" : "prompt_arrow_binding_seen",
      arrowId: arrow.id,
      arrowEndpoints: endpoints,
      startBindingElementId: arrow.startBinding?.elementId ?? null,
      endBindingElementId: arrow.endBinding?.elementId ?? null,
      start: describeBindingEndpoint(start),
      end: describeBindingEndpoint(end),
      resolvedStart: describeBindingEndpoint(resolvedStart),
      resolvedEnd: describeBindingEndpoint(resolvedEnd),
      reverseBoundCandidates: boundCandidates.map(describeBindingEndpoint),
      resolvedReverseBoundCandidates: resolvedBoundCandidates.map(describeBindingEndpoint),
      nearestTargetsFromStart: nearestPromptTargets(endpoints.start, elements, workflowGraphRef.current, cardsRef.current, detected?.promptId ?? null).slice(0, 5),
      nearestTargetsFromEnd: nearestPromptTargets(endpoints.end, elements, workflowGraphRef.current, cardsRef.current, detected?.promptId ?? null).slice(0, 5),
      nearestRawElementsFromStart: nearestRawElements(endpoints.start, elements, detected?.promptId ?? null).slice(0, 6),
      nearestRawElementsFromEnd: nearestRawElements(endpoints.end, elements, detected?.promptId ?? null).slice(0, 6),
      detected,
    };
    const signature = JSON.stringify(event);
    if (promptArrowDebugSignaturesRef.current.get(arrow.id) === signature) return;
    promptArrowDebugSignaturesRef.current.set(arrow.id, signature);
  }

  function logPromptArrowDispatchTriggered(arrow: ArcElement, detected: { promptId: string; target: PromptDispatchTarget }) {
    void arrow;
    void detected;
  }

  async function createAndDispatchPromptLink(promptId: string, target: PromptDispatchTarget, arrowElementId: string) {
    if (!project) {
      throw new Error("Select or create an Excalidraw project first.");
    }
    const prompt = canvasPromptsRef.current.prompts.find((candidate) => candidate.id === promptId);
    if (!prompt) {
      throw new Error(`Prompt ${promptId} was not found.`);
    }
    const linkKind = promptLinkKindForTarget(prompt.commandKind, target);
    const existingLinks = canvasPromptsRef.current.links.filter((link) => link.promptNodeId === promptId);
    const sameExisting = existingLinks.find((link) => link.targetId === target.targetId && link.targetKind === target.targetKind && (link.workflowNodeId ?? link.targetWorkflowNodeId ?? null) === (target.targetWorkflowNodeId ?? null));
    if (sameExisting) {
      if (prompt.body.trim() && (sameExisting.status === "linked" || sameExisting.status === "waiting_for_body" || sameExisting.status === "dirty" || sameExisting.status === "failed")) {
        await dispatchPromptLink(sameExisting.id);
      }
      return;
    }
    if (linkKind === "question_answer" || linkKind === "question_context") {
      if (existingLinks.some((link) => link.linkKind === "workflow_dispatch" || link.linkKind === "plan_control")) {
        throw new Error("This prompt already has a workflow target. Create a new answer prompt for questions.");
      }
    } else if (existingLinks.length > 0) {
      if (existingLinks.some((link) => link.linkKind === "question_answer" || link.linkKind === "question_context")) {
        throw new Error("This prompt is already being used as a question answer. Create a new prompt box for workflow actions.");
      }
      throw new Error("Only one workflow target is allowed per prompt box right now.");
    }
    const response = await createCanvasPromptLink(project.projectId, {
      promptNodeId: promptId,
      ownerId: prompt.ownerId,
      linkKind,
      targetKind: target.targetKind,
      targetId: target.targetId,
      orchestrationId: target.targetOrchestrationId,
      workflowGraphId: target.targetWorkflowGraphId,
      workflowNodeId: target.targetWorkflowNodeId,
      questionId: target.targetKind === "open_question" ? target.targetWorkflowNodeId ?? target.targetId : undefined,
      cardId: target.targetKind === "task_card" || target.targetKind === "orchestration_parent" ? target.targetId : undefined,
      targetOrchestrationId: target.targetOrchestrationId,
      targetWorkflowGraphId: target.targetWorkflowGraphId,
      targetWorkflowNodeId: target.targetWorkflowNodeId,
      arrowElementId,
    });
    console.info("Canvas prompt dispatch starting from frontend.", {
      promptId,
      linkId: response.link.id,
      linkKind,
      commandKind: prompt.commandKind,
      targetKind: target.targetKind,
      targetId: target.targetId,
      orchestrationId: target.targetOrchestrationId ?? null,
      workflowNodeId: target.targetWorkflowNodeId ?? null,
    });
    void logCanvasDebugEvent({
      event: "canvas_prompt_dispatch_start",
      promptId,
      linkId: response.link.id,
      linkKind,
      commandKind: prompt.commandKind,
      targetKind: target.targetKind,
      targetId: target.targetId,
      orchestrationId: target.targetOrchestrationId ?? null,
      workflowNodeId: target.targetWorkflowNodeId ?? null,
      arrowElementId,
    }).catch(() => undefined);
    const next = replaceLink(canvasPromptsRef.current, response.link);
    applyPromptsToScene(markPromptLinkSending(next, response.link.id));
    await dispatchPromptLink(response.link.id);
  }

  async function dispatchPromptLink(linkId: string) {
    try {
      const response = await dispatchCanvasPromptLink(linkId);
      const next: ArcCanvasPromptBundle = {
        prompts: response.prompt ? replacePrompt(canvasPromptsRef.current, response.prompt).prompts : canvasPromptsRef.current.prompts,
        links: response.link ? replaceLink(canvasPromptsRef.current, response.link).links : canvasPromptsRef.current.links,
      };
      applyPromptsToScene(next);
      if (response.card) {
        applyCardsToScene([response.card, ...cardsRef.current.filter((card) => card.id !== response.card?.id)]);
        selectCard(response.card.id);
      }
      if (response.cards?.length) {
        const responseIds = new Set(response.cards.map((card) => card.id));
        applyCardsToScene([...response.cards, ...cardsRef.current.filter((card) => !responseIds.has(card.id))]);
        selectCard(response.cards[0].id);
      }
      if (response.workflow) {
        applyWorkflowToScene(response.workflow);
      }
      if (response.orchestration) {
        setOrchestrationDetail(response.orchestration);
      }
      setStatus("Prompt dispatched");
    } catch (dispatchError) {
      const message = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
      if (!message.includes("Prompt already sent")) {
        setError(message);
      }
      const activeProject = activeProjectIdRef.current;
      if (activeProject) {
        const refreshed = await listCanvasPrompts(activeProject).catch(() => null);
        if (refreshed) applyPromptsToScene(refreshed);
      }
    }
  }

  function focusPromptText(promptId: string): void {
    window.setTimeout(() => {
      excalidrawApiRef.current?.setActiveTool?.({ type: "text" });
      excalidrawApiRef.current?.updateScene({ appState: { selectedElementIds: { [promptTextElementId(promptId)]: true } } });
    }, 0);
  }

  function removeSceneElement(elementId: string): void {
    const api = excalidrawApiRef.current;
    if (!api) return;
    sceneApplyUntilRef.current = Date.now() + 250;
    api.updateScene({ elements: api.getSceneElements().filter((element) => element.id !== elementId) });
  }

  const sidebarOpen = Boolean(selectedCard || selectedWorkflowNode);
  const selectedPrompt = selectedPromptId
    ? canvasPrompts.prompts.find((prompt) => prompt.id === selectedPromptId) ?? null
    : null;
  const statusText = error ??
    workflowStatusText(
      workflowStream.status,
      workflowStream.revision,
      workflowStream.latestPatchReason,
      status,
      workflowStream.error,
    );

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
              if (canvasPromptsRef.current.prompts.length || canvasPromptsRef.current.links.length) {
                applyPromptsToScene(canvasPromptsRef.current);
              }
            }}
            onChange={(elements, appState) => handleSceneChange(elements as readonly ArcElement[], appState as unknown as ArcAppState)}
            onPointerDown={(activeTool, pointerDownState) => handleCanvasPointerDown(activeTool, pointerDownState as unknown as { hit?: { element?: ArcElement | null } })}
            theme="dark"
          />
          <CanvasPromptToolbar
            statusText={statusText}
            selectedPrompt={selectedPrompt}
            busy={busy || chatBusy}
            refreshDisabled={busy || chatBusy || connecting || !activeProjectId}
            onNewPrompt={() => void handleNewPromptBox("orchestrate")}
            onCommandChange={(kind) => selectedPrompt && void handlePromptCommandChange(selectedPrompt, kind)}
            onDeletePrompt={() => void handleDeleteSelectedPrompt()}
            onRefresh={() => void refresh()}
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
                void handleNewPromptBox("answer", "");
              }}
              onUpdatePlan={handleUpdateSelectedPlan}
              onRemakePlan={handleRemakeSelectedPlan}
              onClose={() => setCanvasPopover(null)}
            />
          ) : null}
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
            onOpenPlannerReply={() => void handleNewPromptBox("orchestrate", "")}
            onUpdatePlan={handleUpdateSelectedPlan}
            onRemakePlan={handleRemakeSelectedPlan}
            onLaunch={handleLaunchSelectedOrchestration}
            onSafetyStatus={handleSafetyStatus}
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
            onOpenFollowUp={() => taskDetail && void handleNewPromptBox("implement", "")}
            onClose={closeSidebar}
          />
        ) : null}
      </div>
    </div>
  );
}

function CanvasPromptToolbar(props: {
  statusText: string;
  selectedPrompt: ArcCanvasPromptNode | null;
  busy: boolean;
  refreshDisabled: boolean;
  onNewPrompt: () => void;
  onCommandChange: (kind: ArcCanvasPromptCommandKind) => void;
  onDeletePrompt: () => void;
  onRefresh: () => void;
}) {
  const deleteLocked = props.selectedPrompt ? promptDeletionLocked(props.selectedPrompt) : true;
  return (
    <div className="canvas-prompt-toolbar">
      <button className="submit-button" type="button" onClick={props.onNewPrompt} disabled={props.busy}>
        New Prompt
      </button>
      {props.selectedPrompt ? (
        <>
          <label className="toolbar-command-select">
            <span>Command</span>
            <select
              value={props.selectedPrompt.commandKind}
              onChange={(event) => props.onCommandChange(event.target.value as ArcCanvasPromptCommandKind)}
              disabled={props.busy}
            >
              {(["orchestrate", "implement", "plan", "answer", "continue_planning", "remake_plan", "start_work"] as ArcCanvasPromptCommandKind[]).map((kind) => (
                <option value={kind} key={kind}>
                  {commandLabels[kind]}
                </option>
              ))}
            </select>
          </label>
          <button className="refresh-button" type="button" onClick={props.onDeletePrompt} disabled={props.busy || deleteLocked}>
            Delete Prompt
          </button>
        </>
      ) : null}
      <button className="refresh-button" type="button" onClick={props.onRefresh} disabled={props.refreshDisabled}>
        Refresh
      </button>
      <div className="status-strip" aria-live="polite">
        {props.statusText}
      </div>
    </div>
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
  onSafetyStatus: (recordId: number, status: ArcOrchestrationSafetyStatus) => void;
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
  const safety = detail.safety ?? [];
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
      <SafetySection
        title="Needs Action"
        records={safety.filter((record) => record.needsOrchestratorAction || record.needsUserAction)}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Context Query History"
        records={safety.filter((record) => record.kind === "query_project_context" || record.kind === "query_contract")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Plan History Requests"
        records={safety.filter((record) => record.kind === "query_plan_history")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="User Decisions"
        records={safety.filter((record) => record.kind === "query_user_decisions")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Prompt Artifact Context"
        records={safety.filter((record) => record.kind === "query_prompt_artifacts")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Validation Results"
        records={safety.filter((record) => record.kind === "report_validation_result")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Failed Validation Alerts"
        records={safety.filter((record) => record.kind === "report_validation_result" && record.needsOrchestratorAction)}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Integration Handoffs"
        records={safety.filter((record) => record.kind === "handoff_to_integration")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Retry / Reassignment / Abort"
        records={safety.filter((record) =>
          record.kind === "request_retry" || record.kind === "request_reassignment" || record.kind === "abort_with_reason"
        )}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Scope Change Requests"
        records={safety.filter((record) => record.kind === "request_scope_change")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Interface Change Requests"
        records={safety.filter((record) => record.kind === "request_interface_change")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Contract Deviations"
        records={safety.filter((record) => record.kind === "report_contract_deviation")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Assumptions"
        records={safety.filter((record) => record.kind === "declare_assumption")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Risk Register"
        records={safety.filter((record) => record.kind === "risk_register_update")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Dependencies"
        records={safety.filter((record) => record.kind === "notify_dependency_ready" || record.kind === "request_dependency_status")}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <SafetySection
        title="Coordination"
        records={safety.filter((record) =>
          record.kind === "sync_with_orchestrator" || record.kind === "request_peer_coordination" || record.kind === "request_test_help"
        )}
        chatBusy={props.chatBusy}
        onStatus={props.onSafetyStatus}
      />
      <div className="sidebar-section safety-section">
        <h3>Contract Revisions</h3>
        {detail.contractRevisions?.length ? (
          <div className="history-list">
            {detail.contractRevisions.map((revision) => (
              <div className="safety-record" key={`contract-revision-${revision.id}`}>
                <div className="safety-record-header">
                  <strong>{revision.summary}</strong>
                  <span className="safety-pill">{revision.revisionKind}</span>
                </div>
                <div className="safety-meta">
                  <span>{revision.createdAt}</span>
                  {revision.safetyRecordId ? <span>Safety #{revision.safetyRecordId}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p>No contract revisions recorded.</p>
        )}
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

function SafetySection(props: {
  title: string;
  records: ArcOrchestrationSafetyRecord[];
  chatBusy: boolean;
  onStatus: (recordId: number, status: ArcOrchestrationSafetyStatus) => void;
}) {
  return (
    <div className="sidebar-section safety-section">
      <h3>{props.title}</h3>
      {props.records.length ? (
        <div className="history-list">
          {props.records.map((record) => (
            <div className="safety-record" key={`${props.title}-${record.id}`}>
              <div className="safety-record-header">
                <strong>{record.title}</strong>
                <span className={`safety-pill safety-${record.status}`}>{record.status}</span>
              </div>
              <div className="safety-meta">
                <span>{record.kind}</span>
                {record.severity ? <span>{record.severity}</span> : null}
                {record.agentId ? <span>Agent #{record.agentId}</span> : null}
                {record.taskId ? <span>Task #{record.taskId}</span> : null}
                {record.needsUserAction ? <span>User action</span> : null}
                {record.needsOrchestratorAction ? <span>Orchestrator action</span> : null}
              </div>
              {record.body ? <p>{record.body}</p> : null}
              {record.status === "open" ? (
                <div className="safety-actions">
                  {(record.kind === "request_scope_change" || record.kind === "request_interface_change") ? (
                    <>
                      <button type="button" disabled={props.chatBusy} onClick={() => props.onStatus(record.id, "approved")}>
                        Approve
                      </button>
                      <button type="button" disabled={props.chatBusy} onClick={() => props.onStatus(record.id, "denied")}>
                        Deny
                      </button>
                    </>
                  ) : null}
                  <button type="button" disabled={props.chatBusy} onClick={() => props.onStatus(record.id, "resolved")}>
                    Resolve
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p>No records.</p>
      )}
    </div>
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

function selectedPromptIdFromAppState(elements: readonly ArcElement[], appState: ArcAppState): string | null {
  const selectedIds = appState.selectedElementIds ?? {};
  for (const element of elements) {
    if (!selectedIds[element.id]) continue;
    const promptId = element.customData?.arcPrompt?.promptId;
    if (promptId) return promptId;
  }
  return null;
}

function promptTextIsEditing(elements: readonly ArcElement[], appState: ArcAppState, promptId: string | null): boolean {
  if (!promptId) return false;
  const textElementId = promptTextElementId(promptId);
  return appState.editingElement?.id === textElementId && elements.some((element) => element.id === textElementId);
}

function preservePromptArrowBindings(nextPromptElements: readonly ArcElement[], existingPromptElements: readonly ArcElement[]): readonly ArcElement[] {
  const existingById = new Map(existingPromptElements.map((element) => [element.id, element]));
  return nextPromptElements.map((element) => {
    const metadata = element.customData?.arcPrompt;
    if (!metadata) return element;
    const existing = existingById.get(element.id);
    if (!existing?.boundElements?.length) return element;
    const merged = mergeBoundElements(element.boundElements, existing.boundElements);
    const boundElements = metadata.role === "box" ? stripPromptTextBinding(merged, metadata.promptId) : merged;
    return sameBoundElements(element.boundElements, boundElements) ? element : { ...element, boundElements };
  });
}

function mergeBoundElements(left: ArcElement["boundElements"], right: ArcElement["boundElements"]): ArcElement["boundElements"] {
  const byId = new Map<string, NonNullable<ArcElement["boundElements"]>[number]>();
  for (const boundElement of [...(left ?? []), ...(right ?? [])]) {
    if (!boundElement.id) continue;
    if (boundElement.type === "text") continue;
    byId.set(boundElement.id, boundElement);
  }
  const merged = Array.from(byId.values());
  return merged.length ? merged : null;
}

function sameRect(left: Pick<ArcElement, "x" | "y" | "width" | "height">, right: Pick<ArcElement, "x" | "y" | "width" | "height">): boolean {
  return Math.round(left.x) === Math.round(right.x) &&
    Math.round(left.y) === Math.round(right.y) &&
    Math.round(left.width) === Math.round(right.width) &&
    Math.round(left.height) === Math.round(right.height);
}

function sameBoundElements(left: ArcElement["boundElements"], right: ArcElement["boundElements"]): boolean {
  const leftIds = (left ?? []).map((element) => `${element.type ?? ""}:${element.id ?? ""}`).sort();
  const rightIds = (right ?? []).map((element) => `${element.type ?? ""}:${element.id ?? ""}`).sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

function isArcCardElement(element: ArcElement): boolean {
  return element.customData?.arc?.source === "excalidraw" || Boolean(cardIdFromElement(element));
}

function isWorkflowElement(element: ArcElement): boolean {
  return Boolean(element.customData?.arcWorkflow);
}

function isPromptElement(element: ArcElement): boolean {
  return element.customData?.arcPrompt?.source === "canvas-prompt";
}

function isArcManagedElement(element: ArcElement): boolean {
  return isArcCardElement(element) || isWorkflowElement(element) || isPromptElement(element);
}

function promptDeletionLocked(prompt: Pick<ArcCanvasPromptNode, "status">): boolean {
  return prompt.status === "sent" || prompt.status === "sending" || prompt.status === "dirty" || prompt.status === "historical";
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

function promptTargetRectsFromElements(elements: readonly ArcElement[]): Map<string, { x: number; y: number; width: number; height: number }> {
  const rects = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const element of elements) {
    const workflowNodeId = element.customData?.arcWorkflow?.workflowNodeId;
    if (workflowNodeId && element.customData?.arcWorkflow?.semanticType === "node") {
      rects.set(workflowNodeId, roundedLayout(element));
      continue;
    }
    const cardId = cardIdFromElement(element);
    if (cardId && element.id === rectElementId(cardId)) {
      rects.set(cardId, roundedLayout(element));
    }
  }
  return rects;
}

function promptLinkTargetFromEndpoints(
  left: ArcElement | null,
  right: ArcElement | null,
  workflow: ArcPersistedWorkflowGraph | null,
  cards: ArcCard[],
): { promptId: string; target: PromptDispatchTarget } | null {
  const leftPromptId = left?.customData?.arcPrompt?.promptId ?? null;
  const rightPromptId = right?.customData?.arcPrompt?.promptId ?? null;
  if (leftPromptId && rightPromptId) return null;
  if (leftPromptId) {
    const target = promptDispatchTargetFromElement(right, workflow, cards);
    return target ? { promptId: leftPromptId, target } : null;
  }
  if (rightPromptId) {
    const target = promptDispatchTargetFromElement(left, workflow, cards);
    return target ? { promptId: rightPromptId, target } : null;
  }
  return null;
}

function promptLinkTargetFromBoundCandidates(
  candidates: readonly ArcElement[],
  workflow: ArcPersistedWorkflowGraph | null,
  cards: ArcCard[],
): { promptId: string; target: PromptDispatchTarget } | null {
  for (const left of candidates) {
    for (const right of candidates) {
      if (left.id === right.id) continue;
      const detected = promptLinkTargetFromEndpoints(left, right, workflow, cards);
      if (detected) return detected;
    }
  }
  return null;
}

function promptOnlyOrchestrateTarget(
  arrowId: string,
  start: ArcElement | null,
  end: ArcElement | null,
  boundCandidates: readonly ArcElement[],
  prompts: readonly ArcCanvasPromptNode[],
): { promptId: string; target: PromptDispatchTarget } | null {
  const promptId = start?.customData?.arcPrompt?.promptId ??
    end?.customData?.arcPrompt?.promptId ??
    boundCandidates.find((element) => element.customData?.arcPrompt?.promptId)?.customData?.arcPrompt?.promptId ??
    null;
  if (!promptId) return null;
  const prompt = prompts.find((candidate) => candidate.id === promptId);
  if (prompt?.commandKind !== "orchestrate") return null;
  return {
    promptId,
    target: {
      targetKind: "orchestration_parent",
      targetId: `new-orchestration:${promptId}:${arrowId}`,
      targetOrchestrationId: null,
      targetWorkflowGraphId: null,
      targetWorkflowNodeId: null,
    },
  };
}

function promptLinkKindForTarget(
  commandKind: ArcCanvasPromptCommandKind,
  target: PromptDispatchTarget,
): ArcCanvasPromptLink["linkKind"] {
  if (target.targetKind === "open_question") {
    return commandKind === "answer" ? "question_answer" : "question_context";
  }
  if (commandKind === "continue_planning" || commandKind === "start_work" || commandKind === "remake_plan") {
    return "plan_control";
  }
  return "workflow_dispatch";
}

function promptLinkTargetFromArrowGeometry(
  arrow: ArcElement,
  start: ArcElement | null,
  end: ArcElement | null,
  boundCandidates: readonly ArcElement[],
  elements: readonly ArcElement[],
  workflow: ArcPersistedWorkflowGraph | null,
  cards: ArcCard[],
): { promptId: string; target: PromptDispatchTarget } | null {
  const promptEndpoint = [start, end, ...boundCandidates].find((candidate) => candidate?.customData?.arcPrompt?.promptId);
  const promptId = promptEndpoint?.customData?.arcPrompt?.promptId ?? null;
  if (!promptId) return null;
  const points = arrowEndpointPoints(arrow);
  const targetPoints = start?.customData?.arcPrompt?.promptId === promptId
    ? [points.end]
    : end?.customData?.arcPrompt?.promptId === promptId
      ? [points.start]
      : [points.end, points.start];
  for (const point of targetPoints) {
    const target = promptDispatchTargetFromPoint(point, elements, workflow, cards, promptId);
    if (target) return { promptId, target };
  }
  return null;
}

function nearestPromptTargets(
  point: { x: number; y: number },
  elements: readonly ArcElement[],
  workflow: ArcPersistedWorkflowGraph | null,
  cards: ArcCard[],
  promptId: string | null,
): Array<Record<string, unknown>> {
  return targetCandidatesForPoint(point, elements, workflow, cards, promptId)
    .slice(0, 8)
    .map((candidate) => ({
      distance: Math.round(candidate.distance),
      target: candidate.target,
      element: describeBindingEndpoint(candidate.element),
    }));
}

function promptDispatchTargetFromPoint(
  point: { x: number; y: number },
  elements: readonly ArcElement[],
  workflow: ArcPersistedWorkflowGraph | null,
  cards: ArcCard[],
  promptId: string,
): PromptDispatchTarget | null {
  const best = targetCandidatesForPoint(point, elements, workflow, cards, promptId)[0] ?? null;
  return best && best.distance <= 180 ? best.target : null;
}

function targetCandidatesForPoint(
  point: { x: number; y: number },
  elements: readonly ArcElement[],
  workflow: ArcPersistedWorkflowGraph | null,
  cards: ArcCard[],
  promptId: string | null,
): Array<{ target: PromptDispatchTarget; distance: number; element: ArcElement }> {
  const bestByTarget = new Map<string, { target: PromptDispatchTarget; distance: number; element: ArcElement }>();
  for (const element of elements) {
    if (promptId && element.customData?.arcPrompt?.promptId === promptId) continue;
    const target = promptDispatchTargetFromElement(element, workflow, cards);
    if (!target) continue;
    const distance = distanceToRect(point, element);
    const key = `${target.targetKind}:${target.targetId}:${target.targetWorkflowNodeId ?? ""}`;
    const existing = bestByTarget.get(key);
    if (!existing || distance < existing.distance) {
      bestByTarget.set(key, { target, distance, element });
    }
  }
  return Array.from(bestByTarget.values()).sort((left, right) => left.distance - right.distance);
}

function arrowEndpointPoints(arrow: ArcElement): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const points = arrow.points?.length ? arrow.points : [[0, 0], [arrow.width, arrow.height]];
  const first = points[0] ?? [0, 0];
  const last = points[points.length - 1] ?? [arrow.width, arrow.height];
  return {
    start: { x: arrow.x + (first[0] ?? 0), y: arrow.y + (first[1] ?? 0) },
    end: { x: arrow.x + (last[0] ?? arrow.width), y: arrow.y + (last[1] ?? arrow.height) },
  };
}

function distanceToRect(point: { x: number; y: number }, rect: Pick<ArcElement, "x" | "y" | "width" | "height">): number {
  const left = Math.min(rect.x, rect.x + rect.width);
  const right = Math.max(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);
  const bottom = Math.max(rect.y, rect.y + rect.height);
  const dx = point.x < left ? left - point.x : point.x > right ? point.x - right : 0;
  const dy = point.y < top ? top - point.y : point.y > bottom ? point.y - bottom : 0;
  return Math.hypot(dx, dy);
}

function boundEndpointCandidatesForArrow(elements: readonly ArcElement[], arrowElementId: string): ArcElement[] {
  const candidates: ArcElement[] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    if (!element.boundElements?.some((boundElement) => boundElement.id === arrowElementId)) continue;
    if (seen.has(element.id)) continue;
    seen.add(element.id);
    candidates.push(element);
  }
  return candidates;
}

function arrowHasPromptEndpoint(
  start: ArcElement | null,
  end: ArcElement | null,
  boundCandidates: readonly ArcElement[],
): boolean {
  return Boolean(
    start?.customData?.arcPrompt?.promptId ||
    end?.customData?.arcPrompt?.promptId ||
    boundCandidates.some((element) => element.customData?.arcPrompt?.promptId),
  );
}

function resolveBindingOwner(element: ArcElement | null, elements: readonly ArcElement[]): ArcElement | null {
  if (!element) return null;
  const byId = new Map(elements.map((candidate) => [candidate.id, candidate]));
  if (element.customData?.arcPrompt?.promptId && element.customData.arcPrompt.role !== "box") {
    return byId.get(promptBoxElementId(element.customData.arcPrompt.promptId)) ?? element;
  }
  if (element.containerId) {
    const container = byId.get(element.containerId);
    if (container) return container;
  }
  const workflow = element.customData?.arcWorkflow;
  if (workflow?.workflowNodeId && workflow.semanticType !== "node") {
    const owner = elements.find((candidate) =>
      candidate.customData?.arcWorkflow?.semanticType === "node" &&
      candidate.customData.arcWorkflow.workflowNodeId === workflow.workflowNodeId
    );
    if (owner) return owner;
  }
  const cardId = cardIdFromElement(element);
  if (cardId && element.id !== rectElementId(cardId)) {
    return byId.get(rectElementId(cardId)) ?? element;
  }
  return element;
}

function describeBindingEndpoint(element: ArcElement | null): Record<string, unknown> | null {
  if (!element) return null;
  return {
    id: element.id,
    type: element.type,
    arcPromptRole: element.customData?.arcPrompt?.role ?? null,
    promptId: element.customData?.arcPrompt?.promptId ?? null,
    arcWorkflowSemanticType: element.customData?.arcWorkflow?.semanticType ?? null,
    workflowNodeId: element.customData?.arcWorkflow?.workflowNodeId ?? null,
    arcCardType: element.customData?.arc?.type ?? null,
    cardId: cardIdFromElement(element),
    containerId: element.containerId ?? null,
  };
}

function nearestRawElements(
  point: { x: number; y: number },
  elements: readonly ArcElement[],
  promptId: string | null,
): Array<Record<string, unknown>> {
  return elements
    .filter((element) => element.type !== "arrow")
    .filter((element) => !promptId || element.customData?.arcPrompt?.promptId !== promptId)
    .map((element) => ({
      distance: Math.round(distanceToRect(point, element)),
      element: describeBindingEndpoint(element),
    }))
    .sort((left, right) => Number(left.distance) - Number(right.distance))
    .slice(0, 12);
}

function promptDispatchTargetFromElement(
  element: ArcElement | null,
  workflowGraph: ArcPersistedWorkflowGraph | null,
  cards: ArcCard[],
): PromptDispatchTarget | null {
  if (!element) return null;
  const workflow = element.customData?.arcWorkflow;
  if (workflow?.workflowNodeId) {
    const nodeId = workflow.workflowNodeId;
    const node = workflowGraph?.graph.nodes.find((candidate) => candidate.id === nodeId);
    return {
      targetKind: node?.kind === "open_question" ? "open_question" : "workflow_node",
      targetId: nodeId,
      targetOrchestrationId: workflow.orchestrationId,
      targetWorkflowGraphId: workflow.graphId,
      targetWorkflowNodeId: nodeId,
    };
  }
  const cardId = cardIdFromElement(element);
  if (!cardId) return null;
  const card = cards.find((candidate) => candidate.id === cardId);
  const type = card?.metadata?.type ?? card?.mode;
  if (type === "orchestration_parent" || type === "orchestration_border") {
    return {
      targetKind: "orchestration_parent",
      targetId: cardId,
      targetOrchestrationId: card?.metadata?.orchestrationId ?? null,
    };
  }
  if (type === "orchestration_question") {
    return {
      targetKind: "open_question",
      targetId: card?.metadata?.questionId ?? cardId,
      targetOrchestrationId: card?.metadata?.orchestrationId ?? null,
      targetWorkflowNodeId: card?.metadata?.questionId,
    };
  }
  if (card?.taskId) {
    return { targetKind: "task_card", targetId: cardId };
  }
  return null;
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

function replacePrompt(bundle: ArcCanvasPromptBundle, prompt: ArcCanvasPromptNode): ArcCanvasPromptBundle {
  return {
    prompts: [...bundle.prompts.filter((candidate) => candidate.id !== prompt.id), prompt],
    links: bundle.links,
  };
}

function replaceLink(bundle: ArcCanvasPromptBundle, link: ArcCanvasPromptLink): ArcCanvasPromptBundle {
  return {
    prompts: bundle.prompts,
    links: [...bundle.links.filter((candidate) => candidate.id !== link.id), link],
  };
}

function markPromptLinkSending(bundle: ArcCanvasPromptBundle, linkId: string): ArcCanvasPromptBundle {
  const link = bundle.links.find((candidate) => candidate.id === linkId);
  if (!link) return bundle;
  return {
    prompts: bundle.prompts.map((prompt) =>
      prompt.id === link.promptNodeId ? { ...prompt, status: "sending" } : prompt,
    ),
    links: bundle.links.map((candidate) =>
      candidate.id === linkId ? { ...candidate, status: "sending", error: null } : candidate,
    ),
  };
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

function localCanvasOwner(): { ownerId: string; ownerLabel: string } {
  let ownerId = window.localStorage.getItem(LOCAL_OWNER_KEY);
  if (!ownerId) {
    ownerId = `local-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(LOCAL_OWNER_KEY, ownerId);
  }
  // This local identity is UI metadata only. Real permission enforcement needs real auth.
  return { ownerId, ownerLabel: "You" };
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
