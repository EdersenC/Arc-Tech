import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { PullRequestFeedbackRepo } from "../github/PullRequestFeedbackRepo.js";
import type { PullRequestFeedbackWorker } from "../github/PullRequestFeedbackWorker.js";
import { stableJson } from "../orchestrations/AgentFleetPlanValidator.js";
import type { OrchestrationPlannerService } from "../orchestrations/OrchestrationPlannerService.js";
import type { OrchestrationAgentsRepo } from "../orchestrations/repos/OrchestrationAgentsRepo.js";
import type { OrchestrationMessagesRepo } from "../orchestrations/repos/OrchestrationMessagesRepo.js";
import type { OrchestrationsRepo } from "../orchestrations/repos/OrchestrationsRepo.js";
import type {
  AgentFleetPlan,
  AgentFleetPlanAgent,
  Orchestration,
  OrchestrationMessage,
  PlannerQuestionView,
} from "../orchestrations/types.js";
import type { ProjectStore, TaskStore } from "../stores.js";
import type { ImplementService } from "../tasks/ImplementService.js";
import { DEFAULT_MODEL, type Effort, type Project, type Task } from "../types.js";
import { parsePlannerWorkflowPatch } from "../workflows/index.js";
import type {
  PersistedWorkflowGraph,
  PersistedWorkflowPatch,
  WorkflowGraph,
  WorkflowEvent,
  WorkflowEventBus,
  WorkflowService,
  WorkflowOpenQuestion,
  WorkflowPatch,
} from "../workflows/index.js";
import { ExcalidrawCardsRepo } from "./ExcalidrawCardsRepo.js";
import { buildTaskProgress } from "./taskProgress.js";
import {
  mapTaskStatus,
  oneLine,
  taskCardLabelWithProgress,
  taskCardSize,
  taskTitle,
  type ExcalidrawCard,
  type ExcalidrawCardLink,
  type ExcalidrawTaskProgress,
  type ExcalidrawTaskView,
} from "./types.js";

interface ApiDeps {
  config: AppConfig;
  projects: ProjectStore;
  tasks: TaskStore;
  implementService: ImplementService;
  cards: ExcalidrawCardsRepo;
  feedback?: PullRequestFeedbackRepo;
  prFeedbackWorker?: Pick<PullRequestFeedbackWorker, "resumeAndPoll">;
  orchestrations: OrchestrationsRepo;
  orchestrationAgents: OrchestrationAgentsRepo;
  orchestrationMessages: OrchestrationMessagesRepo;
  planner: Pick<OrchestrationPlannerService, "startPlanner" | "continuePlanner" | "generateFleetPlan">;
  workflows: WorkflowService;
  workflowEvents: WorkflowEventBus;
}

type JsonRecord = Record<string, unknown>;

interface ExcalidrawProjectView {
  projectId: number;
  projectName: string;
  projectSlug: string;
  channelId: string;
  repoPath: string;
  worktreesPath: string;
  remoteStatus: Project["remoteStatus"];
  remoteUrl: string | null;
  githubPrEnabled: boolean;
  githubPrFeedbackEnabled: boolean;
  githubPrFeedbackPollMs: number;
  githubPrFeedbackIdleMs: number;
  githubBaseBranch: string;
  githubRemote: string;
  prReady: boolean;
  blockers: string[];
  taskCount: number;
}

const STATIC_ROOT = path.resolve(process.cwd(), "dist/web");
const ORCHESTRATION_COLUMNS = 3;
const ORCHESTRATION_GRID_GAP = 48;
const ORCHESTRATION_HEADER_HEIGHT = 180;
const ORCHESTRATION_AGENT_SLOT_WIDTH = 760;
const ORCHESTRATION_AGENT_SLOT_HEIGHT = 720;

export class ExcalidrawApiServer {
  private readonly server = http.createServer((req, res) => {
    void this.route(req, res).catch((error) => {
      const status = isClientError(error) ? 400 : 500;
      if (status >= 500) {
        console.error("Excalidraw API error:", error);
      } else {
        console.warn("Excalidraw API rejected request:", error instanceof Error ? error.message : String(error));
      }
      this.sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  constructor(private readonly deps: ApiDeps) {}

  listen(): void {
    this.server.listen(this.deps.config.excalidrawPort, this.deps.config.excalidrawHost, () => {
      console.log(
        `Excalidraw API listening on http://${this.deps.config.excalidrawHost}:${this.deps.config.excalidrawPort}`,
      );
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/api/health" && req.method === "GET") {
      this.sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/implement" && req.method === "POST") {
      await this.handleImplement(req, res);
      return;
    }
    if (url.pathname === "/api/orchestrate" && req.method === "POST") {
      await this.handleCreateOrchestration(req, res);
      return;
    }
    const orchestrationMatch = /^\/api\/orchestrations\/(\d+)$/.exec(url.pathname);
    if (orchestrationMatch && req.method === "GET") {
      await this.handleGetOrchestration(Number(orchestrationMatch[1]), res);
      return;
    }
    const orchestrationMessageMatch = /^\/api\/orchestrations\/(\d+)\/messages$/.exec(url.pathname);
    if (orchestrationMessageMatch && req.method === "POST") {
      await this.handleOrchestrationMessage(Number(orchestrationMessageMatch[1]), req, res);
      return;
    }
    const orchestrationAnswerMatch = /^\/api\/orchestrations\/(\d+)\/questions\/([^/]+)\/answer$/.exec(url.pathname);
    if (orchestrationAnswerMatch && req.method === "POST") {
      await this.handleOrchestrationAnswer(Number(orchestrationAnswerMatch[1]), decodeURIComponent(orchestrationAnswerMatch[2]), req, res);
      return;
    }
    const orchestrationQuestionMessageMatch = /^\/api\/orchestrations\/(\d+)\/questions\/([^/]+)\/messages$/.exec(url.pathname);
    if (orchestrationQuestionMessageMatch && req.method === "POST") {
      await this.handleOrchestrationQuestionMessage(Number(orchestrationQuestionMessageMatch[1]), decodeURIComponent(orchestrationQuestionMessageMatch[2]), req, res);
      return;
    }
    const orchestrationPlanUpdateMatch = /^\/api\/orchestrations\/(\d+)\/plan\/update$/.exec(url.pathname);
    if (orchestrationPlanUpdateMatch && req.method === "POST") {
      await this.handleUpdateOrchestrationPlan(Number(orchestrationPlanUpdateMatch[1]), res);
      return;
    }
    const orchestrationPlanRemakeMatch = /^\/api\/orchestrations\/(\d+)\/plan\/remake$/.exec(url.pathname);
    if (orchestrationPlanRemakeMatch && req.method === "POST") {
      await this.handleRemakeOrchestrationPlan(Number(orchestrationPlanRemakeMatch[1]), res);
      return;
    }
    const orchestrationLaunchMatch = /^\/api\/orchestrations\/(\d+)\/launch$/.exec(url.pathname);
    if (orchestrationLaunchMatch && req.method === "POST") {
      await this.handleLaunchOrchestration(Number(orchestrationLaunchMatch[1]), req, res);
      return;
    }
    const workflowProjectMatch = /^\/api\/workflows\/project\/(\d+)\/current$/.exec(url.pathname);
    if (workflowProjectMatch && req.method === "GET") {
      await this.handleGetProjectWorkflow(Number(workflowProjectMatch[1]), res);
      return;
    }
    const workflowOrchestrationMatch = /^\/api\/workflows\/orchestration\/(\d+)$/.exec(url.pathname);
    if (workflowOrchestrationMatch && req.method === "GET") {
      await this.handleGetOrCreateOrchestrationWorkflow(Number(workflowOrchestrationMatch[1]), res);
      return;
    }
    const workflowPatchMatch = /^\/api\/workflows\/orchestration\/(\d+)\/patch$/.exec(url.pathname);
    if (workflowPatchMatch && req.method === "POST") {
      await this.handleApplyWorkflowPatch(Number(workflowPatchMatch[1]), req, res);
      return;
    }
    const workflowHistoryMatch = /^\/api\/workflows\/(\d+)\/history$/.exec(url.pathname);
    if (workflowHistoryMatch && req.method === "GET") {
      await this.handleWorkflowHistory(Number(workflowHistoryMatch[1]), res);
      return;
    }
    if (url.pathname === "/api/workflows/events" && req.method === "GET") {
      await this.handleWorkflowEvents(url, req, res);
      return;
    }
    if (url.pathname === "/api/excalidraw/projects" && req.method === "GET") {
      await this.handleListProjects(res);
      return;
    }
    if (url.pathname === "/api/excalidraw/projects" && req.method === "POST") {
      await this.handleCreateProject(req, res);
      return;
    }
    if (url.pathname === "/api/excalidraw/project" && req.method === "GET") {
      await this.handleGetProject(url, res);
      return;
    }
    if (url.pathname === "/api/excalidraw/project/remote" && req.method === "POST") {
      await this.handleSetProjectRemote(req, res);
      return;
    }
    if (url.pathname === "/api/pr-feedback/check" && req.method === "POST") {
      await this.handleCheckPullRequests(req, res);
      return;
    }
    if (url.pathname === "/api/tasks" && req.method === "GET") {
      await this.handleListTasks(url, res);
      return;
    }
    const taskMatch = /^\/api\/tasks\/(\d+)$/.exec(url.pathname);
    if (taskMatch && req.method === "GET") {
      await this.handleGetTask(Number(taskMatch[1]), res);
      return;
    }
    const taskHistoryMatch = /^\/api\/tasks\/(\d+)\/history$/.exec(url.pathname);
    if (taskHistoryMatch && req.method === "GET") {
      await this.handleGetTaskHistory(Number(taskHistoryMatch[1]), res);
      return;
    }
    const taskMessageMatch = /^\/api\/tasks\/(\d+)\/messages$/.exec(url.pathname);
    if (taskMessageMatch && req.method === "POST") {
      await this.handleTaskMessage(Number(taskMessageMatch[1]), req, res);
      return;
    }
    if (url.pathname === "/api/excalidraw/cards" && req.method === "GET") {
      const project = await this.projectFromQuery(url);
      this.sendJson(res, 200, { cards: this.hydrateCards(this.deps.cards.listByProject(project.id, limitParam(url))) });
      return;
    }
    if (url.pathname === "/api/excalidraw/cards" && req.method === "POST") {
      await this.handleCreatePlanCard(req, res);
      return;
    }
    const cardMatch = /^\/api\/excalidraw\/cards\/([^/]+)$/.exec(url.pathname);
    if (cardMatch && req.method === "PATCH") {
      await this.handleUpdateCard(decodeURIComponent(cardMatch[1]), req, res);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await this.serveStatic(url.pathname, res);
      return;
    }

    this.sendJson(res, 404, { error: "Not found." });
  }

  private async handleCreateOrchestration(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const command = parseOrchestrateCommand(stringField(body, "message").trim());
    const project = await this.projectFromBody(body);
    const orchestration = this.deps.orchestrations.create({
      projectId: project.id,
      authorUserId: "excalidraw",
      goal: command.prompt,
      plannerEffort: "high",
      minAgents: 2,
      maxAgents: 10,
      autoStartChildren: true,
    });
    this.deps.orchestrationMessages.create(orchestration.id, "user", command.prompt, {
      authorUserId: "excalidraw",
      metadata: { source: "excalidraw", kind: "initial_prompt" },
    });

    const workflowState = this.getOrCreateWorkflowForOrchestration(orchestration);
    if (workflowState.created) {
      this.deps.workflowEvents.graphCreated(workflowState.workflow);
    } else {
      this.deps.workflowEvents.snapshot(workflowState.workflow);
    }
    const message = await this.deps.planner.startPlanner(orchestration.id, {
      extraInstructions: workflowPlannerPromptContract(workflowState.workflow),
      metadata: { kind: "planner_turn", workflow: workflowMessageMetadata(workflowState.workflow), plannerPrompt: workflowPlannerPromptContract(workflowState.workflow) },
    });
    await this.recordPlannerWorkflowPatch(orchestration, message, workflowState.workflow);
    const currentWorkflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestration.id) ?? workflowState.workflow;
    const updated = this.requireOrchestration(orchestration.id);
    const label = orchestrationParentLabel(updated, project, message);
    const size = orchestrationParentSize(label, undefined, orchestration.maxAgents);
    const card = this.deps.cards.createPlanCard({
      projectId: project.id,
      command: command.original,
      title: `Orchestration #${orchestration.id}`,
      label,
      mode: "orchestration_parent",
      status: "planning",
      x: numberField(body, "x") ?? nextCardX(orchestration.id),
      y: numberField(body, "y") ?? nextCardY(orchestration.id),
      width: size.width,
      height: size.height,
      metadata: {
        type: "orchestration_parent",
        orchestrationId: orchestration.id,
        projectId: project.id,
        goal: command.prompt,
        planSummary: "Planning started",
      },
    });
    const saved = this.deps.orchestrations.updateCardIds(orchestration.id, card.id, null);
    this.sendJson(res, 201, { orchestration: this.orchestrationView(saved), card: this.hydrateCard(card), workflow: workflowView(currentWorkflow) });
  }

  private async handleGetOrchestration(orchestrationId: number, res: ServerResponse): Promise<void> {
    const orchestration = this.deps.orchestrations.findById(orchestrationId);
    if (!orchestration) {
      this.sendJson(res, 404, { error: `Orchestration ${orchestrationId} not found.` });
      return;
    }
    this.sendJson(res, 200, this.orchestrationView(orchestration));
  }

  private async handleOrchestrationMessage(orchestrationId: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const orchestration = this.requireOrchestration(orchestrationId);
    const body = await readJson(req);
    const content = stringField(body, "content").trim();
    if (!content) {
      throw new Error("Orchestration message is required.");
    }
    this.deps.orchestrationMessages.create(orchestrationId, "user", content, {
      authorUserId: "excalidraw",
      metadata: { source: "excalidraw", kind: "freeform" },
    });
    const updated = await this.runPlannerTurn(orchestrationId, content);
    this.sendJson(res, 202, this.orchestrationView(updated));
  }

  private async handleOrchestrationAnswer(
    orchestrationId: number,
    questionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJson(req);
    const updated = this.saveQuestionAnswer(orchestrationId, questionId, body);
    this.sendJson(res, 202, this.orchestrationView(updated));
  }

  private async handleOrchestrationQuestionMessage(
    orchestrationId: number,
    questionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJson(req);
    const updated = await this.submitQuestionPlannerTurn(orchestrationId, questionId, body);
    this.sendJson(res, 202, this.orchestrationView(updated));
  }

  private async submitQuestionPlannerTurn(orchestrationId: number, questionId: string, body: JsonRecord): Promise<Orchestration> {
    const orchestration = this.requireOrchestration(orchestrationId);
    const selectedOptionIds = arrayOfStrings(body.selectedOptionIds).filter(Boolean);
    const customText = stringField(body, "customText", "").trim();
    const freeformContent = stringField(body, "content", "").trim();
    if (selectedOptionIds.length === 0 && !customText && !freeformContent) {
      throw new Error("Select at least one option or enter a message.");
    }
    const messages = this.deps.orchestrationMessages.listByOrchestrationId(orchestrationId);
    const workflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestrationId);
    const question = orchestrationQuestions(messages, workflow).find(
      (candidate) => candidate.id === questionId || candidate.workflowNodeId === questionId,
    );
    if (!question) {
      throw new Error(`Question ${questionId} was not found on orchestration #${orchestrationId}.`);
    }
    const selectedLabels = question
      ? question.options.filter((option) => selectedOptionIds.includes(option.id)).map((option) => option.label)
      : selectedOptionIds;
    const content = questionTurnContent(question, selectedLabels.length ? selectedLabels : selectedOptionIds, customText || freeformContent);
    this.deps.orchestrationMessages.create(orchestrationId, "user", content, {
      authorUserId: "excalidraw",
      metadata: {
        source: "excalidraw",
        kind: "question_message",
        questionId: question.id,
        selectedOptionIds,
        selectedLabels,
        customText: customText || undefined,
        content: freeformContent || undefined,
        questionSource: question.source,
        workflowNodeId: question.workflowNodeId,
      },
    });
    return this.runQuestionPlannerTurn(orchestration, question, content);
  }

  private saveQuestionAnswer(orchestrationId: number, questionId: string, body: JsonRecord): Orchestration {
    const orchestration = this.requireOrchestration(orchestrationId);
    const selectedOptionIds = arrayOfStrings(body.selectedOptionIds).filter(Boolean);
    const customText = stringField(body, "customText", "").trim() || stringField(body, "content", "").trim();
    if (selectedOptionIds.length === 0 && !customText) {
      throw new Error("Select at least one option or enter an answer.");
    }
    const messages = this.deps.orchestrationMessages.listByOrchestrationId(orchestrationId);
    const workflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestrationId);
    const question = orchestrationQuestions(messages, workflow).find(
      (candidate) => candidate.id === questionId || candidate.workflowNodeId === questionId,
    );
    if (!question) {
      throw new Error(`Question ${questionId} was not found on orchestration #${orchestrationId}.`);
    }
    const selectedLabels = question.options.filter((option) => selectedOptionIds.includes(option.id)).map((option) => option.label);
    const content = questionTurnContent(question, selectedLabels.length ? selectedLabels : selectedOptionIds, customText);
    this.deps.orchestrationMessages.create(orchestrationId, "user", content, {
      authorUserId: "excalidraw",
      metadata: {
        source: "excalidraw",
        kind: "question_answer",
        questionId: question.id,
        selectedOptionIds,
        selectedLabels,
        customText: customText || undefined,
        questionSource: question.source,
        workflowNodeId: question.workflowNodeId,
        batched: true,
      },
    });
    const updatedWorkflow = this.resolveQuestionLocally(orchestration, question, content);
    const updated = this.requireOrchestration(orchestrationId);
    this.refreshParentOrchestrationCard(
      updated,
      batchedQuestionStatusMessage(orchestrationQuestions(this.deps.orchestrationMessages.listByOrchestrationId(orchestrationId), updatedWorkflow ?? workflow)),
      "planning",
    );
    return updated;
  }

  private resolveQuestionLocally(
    orchestration: Orchestration,
    question: PlannerQuestionView,
    answer: string,
  ): PersistedWorkflowGraph | null {
    const workflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestration.id);
    if (!workflow?.graph.openQuestions.some((candidate) => candidate.id === question.id)) {
      return workflow;
    }
    const now = new Date().toISOString();
    const nodeId = question.workflowNodeId && workflow.graph.nodes.some((node) => node.id === question.workflowNodeId)
      ? question.workflowNodeId
      : null;
    const patch: WorkflowPatch = {
      id: `patch-batched-answer-${slugify(question.id)}-rev-${workflow.revision}-${Date.now()}`,
      graphId: workflow.graph.id,
      baseRevision: workflow.revision,
      reason: `Save batched answer for ${question.text}`,
      author: "system",
      createdAt: now,
      operations: [
        { op: "resolve_open_question", questionId: question.id, answer },
        ...(nodeId
          ? [{
              op: "update_node" as const,
              nodeId,
              changes: { status: "complete" as const, summary: answer },
            }]
          : []),
      ],
    };
    const updated = this.deps.workflows.applyPlannerPatch(orchestration.projectId, orchestration.id, patch);
    const history = this.deps.workflows.listGraphHistory(updated.id);
    const persistedPatch = history[history.length - 1] ?? null;
    if (persistedPatch) {
      this.deps.workflowEvents.patchApplied(updated, persistedPatch);
    }
    this.deps.orchestrationMessages.create(orchestration.id, "system", "Saved batched question answer in the WorkflowGraph.", {
      metadata: {
        kind: "workflow_patch",
        workflowPatch: {
          status: "applied",
          patchId: patch.id,
          reason: patch.reason,
          baseRevision: patch.baseRevision,
          resultingRevision: updated.revision,
        },
        workflow: workflowMessageMetadata(updated),
      },
    });
    return updated;
  }

  private async handleUpdateOrchestrationPlan(orchestrationId: number, res: ServerResponse): Promise<void> {
    const orchestration = this.requireOrchestration(orchestrationId);
    this.deps.orchestrations.clearFinalPlan(orchestrationId, "refining_plan");
    const messages = this.deps.orchestrationMessages.listByOrchestrationId(orchestrationId);
    const workflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestrationId);
    const content = savedAnswersPlannerPrompt(orchestration, orchestrationQuestions(messages, workflow));
    this.deps.orchestrationMessages.create(orchestrationId, "user", content, {
      authorUserId: "excalidraw",
      metadata: { source: "excalidraw", kind: "plan_update_request" },
    });
    const updated = await this.runPlannerTurn(orchestrationId, content);
    this.sendJson(res, 202, this.orchestrationView(updated));
  }

  private async handleRemakeOrchestrationPlan(orchestrationId: number, res: ServerResponse): Promise<void> {
    const orchestration = this.requireOrchestration(orchestrationId);
    const project = requireValue(this.deps.projects.getById(orchestration.projectId), `Project #${orchestration.projectId} not found.`);
    this.deps.orchestrations.clearFinalPlan(orchestrationId, "refining_plan");
    const messages = this.deps.orchestrationMessages.listByOrchestrationId(orchestrationId);
    const workflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestrationId);
    const content = `${savedAnswersPlannerPrompt(orchestration, orchestrationQuestions(messages, workflow))}\n\nRemake the AgentFleetPlan from scratch using these answers.`;
    this.deps.orchestrationMessages.create(orchestrationId, "user", content, {
      authorUserId: "excalidraw",
      metadata: { source: "excalidraw", kind: "plan_remake_request" },
    });
    const plan = await this.ensureFleetPlan(orchestrationId, project);
    const ready = this.deps.orchestrations.updateStatus(orchestrationId, "ready_for_approval");
    this.deps.orchestrationMessages.create(orchestrationId, "system", "AgentFleetPlan was remade from saved answers and is ready for review.", {
      metadata: { kind: "ready_for_approval", readySummary: plan.architectureSummary, plan },
    });
    this.refreshParentOrchestrationCard(ready, readyMessage(plan), "ready");
    this.sendJson(res, 202, this.orchestrationView(ready));
  }

  private async handleLaunchOrchestration(orchestrationId: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const orchestration = this.requireOrchestration(orchestrationId);
    const project = await this.getSyncedExcalidrawProject(requireValue(this.deps.projects.getById(orchestration.projectId), "Project not found."));
    const body = await readJson(req);
    if (!isOrchestrationReadyForSpawn(orchestration)) {
      const workflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestrationId);
      const unanswered = workflow?.graph.openQuestions.filter((question) => question.status === "open") ?? [];
      if (unanswered.length) {
        this.sendJson(res, 409, {
          code: "OPEN_QUESTIONS",
          error: `Answer the current question batch before preparing the plan. ${unanswered.length} question${unanswered.length === 1 ? "" : "s"} still open.`,
        });
        return;
      }
      const plan = await this.ensureFleetPlan(orchestrationId, project);
      const ready = this.deps.orchestrations.updateStatus(orchestrationId, "ready_for_approval");
      this.deps.orchestrationMessages.create(orchestrationId, "system", "AgentFleetPlan is ready for review. Press Start Plan in the canvas container to launch child agents.", {
        metadata: { kind: "ready_for_approval", readySummary: plan.architectureSummary, plan },
      });
      this.refreshParentOrchestrationCard(ready, readyMessage(plan), "ready");
      this.sendJson(res, 202, { orchestration: this.orchestrationView(ready), cards: [], requiresApproval: true });
      return;
    }

    const projectView = this.projectView(project);
    if (!projectView.prReady) {
      this.sendJson(res, 409, {
        code: projectView.githubPrEnabled ? "REMOTE_REQUIRED" : "PR_DISABLED",
        error: projectView.blockers.join(" "),
        project: projectView,
      });
      return;
    }
    const plan = await this.ensureFleetPlan(orchestrationId, project);
    const current = this.requireOrchestration(orchestrationId);
    this.deps.orchestrations.updateStatus(orchestrationId, "spawning_agents");
    const parentCard = current.parentCardId ? this.deps.cards.findById(current.parentCardId) : null;
    const group = groupLayout(
      parentCard?.x ?? numberField(body, "x") ?? nextCardX(orchestrationId),
      parentCard?.y ?? numberField(body, "y") ?? nextCardY(orchestrationId),
      plan.agentCount,
    );
    const container = parentCard
      ? requireValue(
          this.deps.cards.updateText(parentCard.id, {
            title: group.title,
            label: orchestrationBorderLabel(current, project, plan),
            status: "running",
            width: group.width,
            height: group.height,
            metadata: {
              ...(parentCard.metadata ?? {}),
              type: "orchestration_parent",
              cardType: "orchestration_parent",
              orchestrationId,
              projectId: project.id,
              goal: current.goal,
              status: "running",
              planSummary: plan.architectureSummary,
            },
          }),
          `Parent orchestration card ${parentCard.id} not found.`,
        )
      : this.deps.cards.createPlanCard({
          projectId: project.id,
          command: `/orchestrate ${current.goal}`,
          title: group.title,
          label: orchestrationBorderLabel(current, project, plan),
          mode: "orchestration_parent",
          status: "running",
          x: group.x,
          y: group.y,
          width: group.width,
          height: group.height,
          metadata: {
            type: "orchestration_parent",
            orchestrationId,
            projectId: project.id,
            goal: current.goal,
            status: "running",
            planSummary: plan.architectureSummary,
          },
        });
    this.deps.orchestrations.updateCardIds(orchestrationId, container.id, container.id);
    const plannedAgents = this.deps.orchestrationAgents.createMany(orchestrationId, plan.agents);
    const cards: ExcalidrawCard[] = [container];
    for (const agent of plannedAgents) {
      const planAgent = plan.agents[agent.agentIndex - 1];
      if (!planAgent) continue;
      const branchName = `codex/orch-${orchestrationId}-agent-${String(agent.agentIndex).padStart(2, "0")}-${slugify(agent.agentName)}`;
      const worktreeName = `orch-${orchestrationId}-agent-${agent.agentIndex}-${slugify(agent.agentName)}`;
      const childPrompt = childAgentPrompt(current, plan, planAgent, agent.agentIndex, branchName);
      const position = childCardPosition(group, agent.agentIndex);
      const result = await this.deps.implementService.run({
        project,
        prompt: childPrompt,
        requestedBy: "excalidraw",
        sourceUi: "excalidraw",
        startImmediately: true,
        allowLocalOnlyWithoutRemote: false,
        branchName,
        worktreeName,
        model: planAgent.model ?? DEFAULT_MODEL,
        effort: planAgent.effort ?? ("medium" as Effort),
        parentOrchestrationId: orchestrationId,
        orchestrationAgentId: agent.id,
        agentRole: planAgent.role,
      });
      this.deps.orchestrationAgents.updateChildTask(agent.id, result.task.id);
      this.deps.orchestrationAgents.updateBranch(agent.id, branchName, result.task.worktreePath ?? "");
      this.deps.orchestrationAgents.updateStatus(agent.id, result.started ? "queued" : "created");
      const card = this.deps.cards.createForTaskWithMode(result.task, {
        command: `/orchestrate ${current.goal}`,
        mode: "orchestration_agent",
        x: position.x,
        y: position.y,
        parentCardId: container.id,
        metadata: {
          type: "orchestration_agent",
          orchestrationId,
          parentOrchestrationId: orchestrationId,
          projectId: project.id,
          agentIndex: agent.agentIndex,
          agentName: agent.agentName,
          agentRole: planAgent.role,
          goal: planAgent.objective,
          planSummary: planAgent.prompt,
        },
      });
      cards.push(this.hydrateCard(card));
    }
    const launched = this.deps.orchestrations.updateStatus(orchestrationId, "agents_spawned");
    this.deps.orchestrationMessages.create(orchestrationId, "system", `Spawned ${plannedAgents.length} child agents.`, {
      metadata: { kind: "agents_spawned", childCount: plannedAgents.length },
    });
    this.sendJson(res, 201, { orchestration: this.orchestrationView(launched), cards: this.hydrateCards(cards) });
  }

  private async handleGetProjectWorkflow(projectId: number, res: ServerResponse): Promise<void> {
    const project = this.getExcalidrawProjectOrDefault(projectId);
    const workflow = this.deps.workflows.getCurrentGraphForProject(project.id);
    this.sendJson(res, 200, { workflow: workflow ? workflowView(workflow) : null });
  }

  private async handleGetOrCreateOrchestrationWorkflow(orchestrationId: number, res: ServerResponse): Promise<void> {
    const orchestration = this.requireOrchestration(orchestrationId);
    this.requireExcalidrawProject(orchestration.projectId);
    const before = this.deps.workflows.getCurrentGraphForOrchestration(orchestrationId);
    const workflow = this.deps.workflows.getOrCreateForOrchestration(orchestration.projectId, orchestrationId, orchestration.goal);
    if (!before) {
      this.deps.workflowEvents.graphCreated(workflow);
    }
    this.sendJson(res, before ? 200 : 201, { workflow: workflowView(workflow) });
  }

  private async handleWorkflowHistory(graphId: number, res: ServerResponse): Promise<void> {
    const history = this.deps.workflows.listGraphHistory(graphId);
    this.sendJson(res, 200, { patches: history.map(workflowPatchView) });
  }

  private async handleApplyWorkflowPatch(orchestrationId: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const orchestration = this.requireOrchestration(orchestrationId);
    this.requireExcalidrawProject(orchestration.projectId);
    const body = await readJson(req);
    const patch = workflowPatchFromBody(body);
    let workflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestrationId);
    if (!workflow) {
      workflow = this.deps.workflows.getOrCreateForOrchestration(orchestration.projectId, orchestrationId, orchestration.goal);
      this.deps.workflowEvents.graphCreated(workflow);
    }

    try {
      const updated = this.deps.workflows.applyPlannerPatch(orchestration.projectId, orchestrationId, patch);
      const history = this.deps.workflows.listGraphHistory(updated.id);
      const persistedPatch = history[history.length - 1] ?? null;
      if (persistedPatch) {
        this.deps.workflowEvents.patchApplied(updated, persistedPatch);
        console.log("Workflow patch applied.", {
          graphId: updated.id,
          workflowGraphId: updated.graph.id,
          orchestrationId,
          patchId: persistedPatch.patch.id,
          resultingRevision: updated.revision,
          reason: persistedPatch.reason,
        });
      }
      this.sendJson(res, 202, { workflow: workflowView(updated), patch: persistedPatch ? workflowPatchView(persistedPatch) : null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.workflowEvents.patchRejected({
        projectId: orchestration.projectId,
        orchestrationId,
        graphId: workflow.id,
        patch,
        error: message,
      });
      console.warn("Workflow patch rejected.", {
        graphId: workflow.id,
        workflowGraphId: workflow.graph.id,
        orchestrationId,
        patchId: patch.id,
        baseRevision: patch.baseRevision,
        error: message,
      });
      this.sendJson(res, isStaleWorkflowError(message) ? 409 : 400, { error: message });
    }
  }

  private async handleWorkflowEvents(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const projectId = numericQueryParam(url, "projectId");
    if (projectId === null) {
      throw new Error("projectId is required.");
    }
    const project = this.getExcalidrawProjectOrDefault(projectId);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    const unsubscribe = this.deps.workflowEvents.subscribe(project.id, (event) => {
      writeWorkflowSse(res, event);
    });
    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });

    const current = this.deps.workflows.getCurrentGraphForProject(project.id);
    if (current) {
      this.deps.workflowEvents.snapshot(current);
    }
  }

  private async handleImplement(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const message = stringField(body, "message").trim();
    const command = parseImplementCommand(message);
    const mode = stringField(body, "mode", "agent");
    const source = stringField(body, "source", "excalidraw");
    if (source !== "excalidraw") {
      this.sendJson(res, 400, { error: "Only source=excalidraw is supported by this API." });
      return;
    }

    if (mode === "plan_card_only" || mode === "plan") {
      await this.createPlanCardResponse(command, body, res);
      return;
    }

    if (mode !== "agent" && mode !== "direct_agent") {
      this.sendJson(res, 400, { error: "mode must be agent or plan_card_only." });
      return;
    }

    const project = await this.getSyncedExcalidrawProject(await this.projectFromBody(body));
    const projectView = this.projectView(project);
    if (!projectView.prReady) {
      this.sendJson(res, 409, {
        code: projectView.githubPrEnabled ? "REMOTE_REQUIRED" : "PR_DISABLED",
        error: projectView.blockers.join(" "),
        project: projectView,
      });
      return;
    }

    const result = await this.deps.implementService.run({
      project,
      prompt: command.prompt,
      requestedBy: "excalidraw",
      sourceUi: "excalidraw",
      startImmediately: true,
      allowLocalOnlyWithoutRemote: false,
    });
    const card = this.hydrateCard(this.deps.cards.createForTask(result.task, {
      command: command.original,
      x: numberField(body, "x") ?? nextCardX(result.task.id),
      y: numberField(body, "y") ?? nextCardY(result.task.id),
    }));
    this.sendJson(res, 201, {
      taskId: String(result.task.id),
      status: mapTaskStatus(result.task.status),
      rawStatus: result.task.status,
      title: taskTitle(result.task),
      branch: result.task.taskBranch,
      card,
    });
  }

  private async handleListProjects(res: ServerResponse): Promise<void> {
    const defaultProject = this.getDefaultExcalidrawProject();
    const listed = this.deps.projects.listByGuildId(this.deps.config.excalidrawProjectGuildId);
    const projects = listed.some((project) => project.id === defaultProject.id) ? listed : [defaultProject, ...listed];
    this.sendJson(res, 200, { projects: projects.map((project) => this.projectView(project)) });
  }

  private async handleCreateProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const name = stringField(body, "name").trim();
    const channelId = stringField(body, "channelId", "").trim() || undefined;
    const project = this.deps.projects.getOrCreateNamed({
      guildId: this.deps.config.excalidrawProjectGuildId,
      projectName: name,
      channelId,
    });
    this.sendJson(res, 201, { project: this.projectView(project) });
  }

  private async handleGetProject(url: URL, res: ServerResponse): Promise<void> {
    const project = await this.getSyncedExcalidrawProject(await this.projectFromQuery(url));
    this.sendJson(res, 200, { project: this.projectView(project) });
  }

  private async handleSetProjectRemote(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const remoteUrl = stringField(body, "remoteUrl").trim();
    if (!looksLikeGitRemote(remoteUrl)) {
      this.sendJson(res, 400, { error: "remoteUrl must be a Git remote URL, like https://github.com/owner/repo.git." });
      return;
    }

    const project = await this.projectFromBody(body);
    const result = await this.deps.implementService.configureProjectRemote(project, remoteUrl);
    this.sendJson(res, 200, {
      project: this.projectView(result.project),
      baseBranch: result.baseBranch,
      summary: result.summary,
    });
  }

  private async handleCheckPullRequests(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.deps.prFeedbackWorker) {
      this.sendJson(res, 503, { error: "PR feedback worker is not available." });
      return;
    }
    const body = await readJson(req);
    const project = await this.projectFromBody(body);
    const result = await this.deps.prFeedbackWorker.resumeAndPoll({ projectId: project.id });
    this.sendJson(res, 202, { project: this.projectView(project), result });
  }

  private async handleCreatePlanCard(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const message = stringField(body, "message").trim();
    const command = parseImplementCommand(message);
    await this.createPlanCardResponse(command, body, res);
  }

  private async createPlanCardResponse(
    command: { original: string; prompt: string },
    body: JsonRecord,
    res: ServerResponse,
  ): Promise<void> {
    const project = await this.projectFromBody(body);
    const title = `Plan Card - ${oneLine(command.prompt, 54)}`;
    const label = [`Plan Card`, `Status: planned`, `Command: ${oneLine(command.prompt, 110)}`].join("\n");
    const size = taskCardSize(label);
    const card = this.deps.cards.createPlanCard({
      projectId: project.id,
      command: command.original,
      title,
      label,
      x: numberField(body, "x") ?? nextCardX(Date.now()),
      y: numberField(body, "y") ?? nextCardY(Date.now()),
      width: numberField(body, "width") ?? size.width,
      height: numberField(body, "height") ?? size.height,
    });
    this.sendJson(res, 201, {
      taskId: null,
      status: "planned",
      rawStatus: "PLAN_CARD_ONLY",
      title,
      branch: null,
      card,
    });
  }

  private async handleListTasks(url: URL, res: ServerResponse): Promise<void> {
    const project = await this.projectFromQuery(url);
    const tasks = this.deps.tasks.listByProject(project.id, limitParam(url)).map((task) => this.taskView(task));
    const cards = this.hydrateCards(this.deps.cards.listByProject(project.id, limitParam(url)));
    this.sendJson(res, 200, { tasks, cards });
  }

  private async handleGetTask(taskId: number, res: ServerResponse): Promise<void> {
    const task = this.deps.tasks.getById(taskId);
    if (!task) {
      this.sendJson(res, 404, { error: `Task ${taskId} not found.` });
      return;
    }
    this.sendJson(res, 200, this.taskView(task));
  }

  private async handleGetTaskHistory(taskId: number, res: ServerResponse): Promise<void> {
    const task = this.deps.tasks.getById(taskId);
    if (!task) {
      this.sendJson(res, 404, { error: `Task ${taskId} not found.` });
      return;
    }
    this.sendJson(res, 200, this.taskHistoryView(task));
  }

  private async handleTaskMessage(taskId: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const task = this.deps.tasks.getById(taskId);
    if (!task) {
      this.sendJson(res, 404, { error: `Task ${taskId} not found.` });
      return;
    }
    const body = await readJson(req);
    const source = stringField(body, "source", "excalidraw");
    if (source !== "excalidraw") {
      this.sendJson(res, 400, { error: "Only source=excalidraw is supported by this API." });
      return;
    }
    const content = stringField(body, "content").trim();
    await this.deps.implementService.enqueueFollowUp({
      task,
      content,
      requestedBy: "excalidraw",
      sourceUi: "excalidraw",
    });
    const refreshed = this.deps.tasks.getById(taskId) ?? task;
    this.sendJson(res, 202, this.taskHistoryView(refreshed));
  }

  private async handleUpdateCard(cardId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const card = this.deps.cards.updatePosition(cardId, {
      x: numberField(body, "x"),
      y: numberField(body, "y"),
      width: numberField(body, "width"),
      height: numberField(body, "height"),
    });
    if (!card) {
      this.sendJson(res, 404, { error: `Card ${cardId} not found.` });
      return;
    }
    this.sendJson(res, 200, { card: this.hydrateCard(card) });
  }

  private getDefaultExcalidrawProject(): Project {
    return this.deps.projects.getOrCreate({
      guildId: this.deps.config.excalidrawProjectGuildId,
      channelId: this.deps.config.excalidrawProjectChannelId,
      channelName: this.deps.config.excalidrawProjectName,
    });
  }

  private async getSyncedExcalidrawProject(project: Project): Promise<Project> {
    return this.deps.implementService.syncProjectOrigin(project);
  }

  private async projectFromQuery(url: URL): Promise<Project> {
    const projectId = numericQueryParam(url, "projectId");
    if (projectId !== null) {
      return this.getExcalidrawProjectOrDefault(projectId);
    }
    return this.getDefaultExcalidrawProject();
  }

  private getExcalidrawProjectOrDefault(projectId: number): Project {
    const project = this.deps.projects.getById(projectId);
    if (project && project.guildId === this.deps.config.excalidrawProjectGuildId) {
      return project;
    }
    return this.getDefaultExcalidrawProject();
  }

  private requireExcalidrawProject(projectId: number): Project {
    const project = this.deps.projects.getById(projectId);
    if (!project || project.guildId !== this.deps.config.excalidrawProjectGuildId) {
      throw new Error(`Excalidraw project ${projectId} was not found.`);
    }
    return project;
  }

  private async projectFromBody(body: JsonRecord): Promise<Project> {
    const rawProjectId = body.projectId;
    if (rawProjectId !== undefined && rawProjectId !== null && rawProjectId !== "") {
      const projectId = typeof rawProjectId === "number" ? rawProjectId : Number(rawProjectId);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        throw new Error("projectId must be a positive integer.");
      }
      const project = this.deps.projects.getById(projectId);
      if (project && project.guildId === this.deps.config.excalidrawProjectGuildId) {
        return project;
      }
      return this.getDefaultExcalidrawProject();
    }
    return this.getDefaultExcalidrawProject();
  }

  private projectView(project: Project): ExcalidrawProjectView {
    const blockers = projectBlockers(project, this.deps.config);
    const taskCount = this.deps.tasks.countByProject(project.id);
    return {
      projectId: project.id,
      projectName: project.projectName,
      projectSlug: project.projectSlug,
      channelId: project.channelId,
      repoPath: project.repoPath,
      worktreesPath: project.worktreesPath,
      remoteStatus: project.remoteStatus,
      remoteUrl: project.remoteUrl,
      githubPrEnabled: this.deps.config.githubPrEnabled,
      githubPrFeedbackEnabled: this.deps.config.githubPrFeedbackEnabled,
      githubPrFeedbackPollMs: this.deps.config.githubPrFeedbackPollMs,
      githubPrFeedbackIdleMs: this.deps.config.githubPrFeedbackIdleMs,
      githubBaseBranch: this.deps.config.githubBaseBranch,
      githubRemote: this.deps.config.githubRemote,
      prReady: blockers.length === 0,
      blockers,
      taskCount,
    };
  }

  private taskView(task: Task): ExcalidrawTaskView {
    const storedCard = this.deps.cards.findByTaskId(task.id);
    const progress = this.taskProgress(task);
    const card = storedCard ? cardViewForTask(storedCard, task, progress) : null;
    return {
      taskId: String(task.id),
      numericTaskId: task.id,
      status: mapTaskStatus(task.status),
      rawStatus: task.status,
      title: taskTitle(task),
      branch: task.taskBranch,
      prompt: task.prompt,
      progress,
      card,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private taskHistoryView(task: Task): JsonRecord {
    const project = this.deps.projects.getById(task.projectId);
    const progress = this.taskProgress(task);
    const view = this.taskView(task);
    return {
      ...view,
      project: project ? this.projectView(project) : null,
      projectId: task.projectId,
      projectName: project?.projectName ?? null,
      projectTaskNumber: task.projectTaskNumber,
      guildId: task.guildId,
      channelId: task.channelId,
      mode: task.mode,
      sandbox: task.sandbox,
      model: task.model,
      effort: task.effort,
      mergeStatus: task.mergeStatus,
      baseBranch: task.baseBranch,
      taskBranch: task.taskBranch,
      worktreePath: task.worktreePath,
      codexThreadId: task.codexThreadId,
      discordThreadId: task.discordThreadId,
      discordThreadUrl: task.discordThreadUrl,
      pullRequestUrl: task.pullRequestUrl ?? task.prUrl,
      finalSummary: task.finalSummary,
      completionSummary: task.completionSummary,
      error: task.error,
      latestPhase: progress.phase,
      latestActivity: progress.activity,
      currentCommand: progress.currentCommand,
      changedFiles: progress.changedFiles,
      messageCounts: progress.messageCounts,
      messages: this.deps.tasks.listMessagesByTask(task.id),
      codexEvents: this.deps.tasks.listCodexActivity(task.id, 200),
      pullRequestFeedback: {
        summary: this.deps.feedback?.getTaskFeedbackSummary(task.id) ?? null,
        events: this.deps.feedback?.listEventsByTask(task.id, 100) ?? [],
      },
    };
  }

  private orchestrationView(orchestration: Orchestration): JsonRecord {
    const project = this.deps.projects.getById(orchestration.projectId);
    const messages = this.deps.orchestrationMessages.listByOrchestrationId(orchestration.id);
    const agents = this.deps.orchestrationAgents.listByOrchestrationId(orchestration.id);
    const parentCard = orchestration.parentCardId ? this.deps.cards.findById(orchestration.parentCardId) : null;
    const borderCard = orchestration.borderCardId ? this.deps.cards.findById(orchestration.borderCardId) : null;
    const workflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestration.id);
    const questions = orchestrationQuestions(messages, workflow);
    return {
      orchestration: {
        ...orchestration,
        projectName: project?.projectName ?? null,
        projectSlug: project?.projectSlug ?? null,
        repoPath: project?.repoPath ?? null,
        worktreesPath: project?.worktreesPath ?? null,
        remoteStatus: project?.remoteStatus ?? null,
        remoteUrl: project?.remoteUrl ?? null,
        latestQuestion: null,
        questions,
        finalPlan: parseJson(orchestration.finalPlanJson),
        workflow: workflow ? workflowView(workflow) : null,
        latestWorkflowPatch: latestWorkflowPatchMetadata(messages),
      },
      messages: messages.map((message) => ({ ...message, metadata: parseJson(message.metadataJson) })),
      agents,
      parentCard,
      borderCard,
      childCards: agents
        .map((agent) => (agent.childTaskId ? this.deps.cards.findByTaskId(agent.childTaskId) : null))
        .filter((card): card is ExcalidrawCard => Boolean(card))
        .map((card) => this.hydrateCard(card)),
      questionCards: [],
      aggregate: aggregateAgents(agents),
    };
  }

  private async ensureFleetPlan(orchestrationId: number, project: Project): Promise<AgentFleetPlan> {
    const orchestration = this.requireOrchestration(orchestrationId);
    const workflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestrationId);
    if (orchestration.finalPlanJson) {
      const parsed = parseJson(orchestration.finalPlanJson) as AgentFleetPlan | null;
      if (parsed?.agents?.length) {
        const withWorkflow = workflow ? withWorkflowSharedContext(parsed, workflow.graph) : parsed;
        if (withWorkflow !== parsed) {
          this.deps.orchestrations.updateFinalPlan(orchestrationId, stableJson(withWorkflow));
        }
        return withWorkflow;
      }
    }
    const generated = await this.deps.planner.generateFleetPlan(orchestrationId, {
      extraInstructions: workflow ? workflowFleetPlanPromptContract(workflow) : undefined,
      metadata: workflow ? { workflow: workflowMessageMetadata(workflow) } : undefined,
    });
    if (generated.errors.length) {
      throw new Error(`Planner could not generate a valid AgentFleetPlan: ${generated.errors.join("; ")}`);
    }
    const refreshed = this.requireOrchestration(orchestrationId);
    const parsed = parseJson(refreshed.finalPlanJson) as AgentFleetPlan | null;
    if (!parsed?.agents?.length) {
      throw new Error("Planner generated a fleet plan, but no valid plan was stored.");
    }
    const plan = workflow ? withWorkflowSharedContext(parsed, workflow.graph) : parsed;
    this.deps.orchestrations.updateFinalPlan(orchestrationId, stableJson(plan));
    return plan;
  }

  private async runPlannerTurn(orchestrationId: number, userMessage: string): Promise<Orchestration> {
    const orchestration = this.requireOrchestration(orchestrationId);
    const workflowState = this.getOrCreateWorkflowForOrchestration(orchestration);
    if (workflowState.created) {
      this.deps.workflowEvents.graphCreated(workflowState.workflow);
    }
    const message = await this.deps.planner.continuePlanner(orchestrationId, userMessage, {
      extraInstructions: workflowPlannerPromptContract(workflowState.workflow),
      metadata: { kind: "planner_turn", workflow: workflowMessageMetadata(workflowState.workflow), plannerPrompt: workflowPlannerPromptContract(workflowState.workflow) },
    });
    await this.recordPlannerWorkflowPatch(orchestration, message, workflowState.workflow);
    const autoReady = await this.preparePlanIfQuestionsResolved(orchestrationId);
    const updated = autoReady ?? this.requireOrchestration(orchestrationId);
    if (!autoReady) {
      this.refreshParentOrchestrationCard(updated, message, "planning");
    }
    return updated;
  }

  private async runQuestionPlannerTurn(
    orchestration: Orchestration,
    question: PlannerQuestionView,
    userMessage: string,
  ): Promise<Orchestration> {
    const workflowState = this.getOrCreateWorkflowForOrchestration(orchestration);
    if (workflowState.created) {
      this.deps.workflowEvents.graphCreated(workflowState.workflow);
    }
    const extraInstructions = [
      workflowPlannerPromptContract(workflowState.workflow),
      questionScopedPlannerPrompt(question, userMessage),
    ].join("\n\n");
    const message = await this.deps.planner.continuePlanner(orchestration.id, userMessage, {
      extraInstructions,
      metadata: {
        kind: "planner_turn",
        source: "excalidraw",
        questionId: question.id,
        workflowNodeId: question.workflowNodeId,
        workflow: workflowMessageMetadata(workflowState.workflow),
        plannerPrompt: extraInstructions,
      },
    });
    await this.recordPlannerWorkflowPatch(orchestration, message, workflowState.workflow);
    const autoReady = await this.preparePlanIfQuestionsResolved(orchestration.id);
    const updated = autoReady ?? this.requireOrchestration(orchestration.id);
    if (!autoReady) {
      this.refreshParentOrchestrationCard(updated, message, "planning");
    }
    return updated;
  }

  private async preparePlanIfQuestionsResolved(orchestrationId: number): Promise<Orchestration | null> {
    const orchestration = this.requireOrchestration(orchestrationId);
    if (orchestration.finalPlanJson || isOrchestrationReadyForSpawn(orchestration) || orchestration.status === "agents_spawned") {
      return null;
    }
    const workflow = this.deps.workflows.getCurrentGraphForOrchestration(orchestrationId);
    const openQuestions = workflow?.graph.openQuestions ?? [];
    if (!openQuestions.length || openQuestions.some((question) => question.status === "open")) {
      return null;
    }
    const project = requireValue(this.deps.projects.getById(orchestration.projectId), `Project #${orchestration.projectId} not found.`);
    const plan = await this.ensureFleetPlan(orchestrationId, project);
    const ready = this.deps.orchestrations.updateStatus(orchestrationId, "ready_for_approval");
    this.deps.orchestrationMessages.create(orchestrationId, "system", "All workflow questions are resolved. AgentFleetPlan is ready to start from the canvas.", {
      metadata: { kind: "ready_for_approval", readySummary: plan.architectureSummary, plan, autoPrepared: true },
    });
    this.refreshParentOrchestrationCard(ready, readyMessage(plan), "ready");
    return ready;
  }

  private getOrCreateWorkflowForOrchestration(orchestration: Orchestration): { workflow: PersistedWorkflowGraph; created: boolean } {
    const before = this.deps.workflows.getCurrentGraphForOrchestration(orchestration.id);
    const workflow = this.deps.workflows.getOrCreateForOrchestration(orchestration.projectId, orchestration.id, orchestration.goal);
    return { workflow, created: !before };
  }

  private async recordPlannerWorkflowPatch(orchestration: Orchestration, plannerContent: string, workflow: PersistedWorkflowGraph): Promise<void> {
    const result = this.processPlannerWorkflowPatch(orchestration, plannerContent, workflow, { emitRejectedEvents: false });
    const repaired = result.metadata.status === "none" || result.metadata.status === "rejected"
      ? await this.repairPlannerWorkflowPatchIfNeeded(orchestration, plannerContent, result.metadata, result.workflow ?? workflow)
      : { metadata: { status: "none" }, workflow: null };
    if (result.metadata.status === "none" && repaired.metadata.status === "none") {
      return;
    }
    const metadata = repaired.metadata.status === "none" ? result.metadata : repaired.metadata;
    if (metadata.status === "rejected") {
      this.emitWorkflowPatchRejected(orchestration, repaired.workflow ?? result.workflow ?? workflow, metadata);
    }
    this.deps.orchestrationMessages.create(orchestration.id, "system", workflowPatchStatusMessage(metadata), {
      metadata: {
        kind: "workflow_patch",
        workflowPatch: metadata,
        workflow: workflowMessageMetadata(repaired.workflow ?? result.workflow ?? workflow),
      },
    });
  }

  private processPlannerWorkflowPatch(
    orchestration: Orchestration,
    plannerContent: string,
    fallbackWorkflow: PersistedWorkflowGraph,
    options: { emitRejectedEvents?: boolean } = {},
  ): { metadata: JsonRecord; workflow: PersistedWorkflowGraph | null } {
    const parsed = parsePlannerWorkflowPatch(plannerContent, { graph: fallbackWorkflow.graph, author: "planner" });
    if (parsed.status === "none") {
      return { metadata: { status: "none" }, workflow: null };
    }
    if (parsed.status === "rejected") {
      if (options.emitRejectedEvents) {
        this.emitWorkflowPatchRejected(orchestration, fallbackWorkflow, { status: "rejected", error: parsed.error });
      }
      return { metadata: { status: "rejected", error: parsed.error }, workflow: null };
    }

    try {
      const updated = this.deps.workflows.applyPlannerPatch(orchestration.projectId, orchestration.id, parsed.patch);
      const history = this.deps.workflows.listGraphHistory(updated.id);
      const persistedPatch = history[history.length - 1] ?? null;
      if (persistedPatch) {
        this.deps.workflowEvents.patchApplied(updated, persistedPatch);
        console.log("Planner workflow patch applied.", {
          graphId: updated.id,
          workflowGraphId: updated.graph.id,
          orchestrationId: orchestration.id,
          patchId: persistedPatch.patch.id,
          resultingRevision: updated.revision,
          reason: persistedPatch.reason,
        });
      }
      return {
        metadata: {
          status: "applied",
          patchId: parsed.patch.id,
          reason: parsed.patch.reason,
          baseRevision: parsed.patch.baseRevision,
          resultingRevision: updated.revision,
        },
        workflow: updated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.emitRejectedEvents) {
        this.emitWorkflowPatchRejected(orchestration, fallbackWorkflow, {
          status: "rejected",
          patchId: parsed.patch.id,
          reason: parsed.patch.reason,
          baseRevision: parsed.patch.baseRevision,
          error: message,
        }, parsed.patch);
      }
      return {
        metadata: {
          status: "rejected",
          patchId: parsed.patch.id,
          reason: parsed.patch.reason,
          baseRevision: parsed.patch.baseRevision,
          error: message,
        },
        workflow: null,
      };
    }
  }

  private async repairPlannerWorkflowPatchIfNeeded(
    orchestration: Orchestration,
    plannerContent: string,
    failedMetadata: JsonRecord,
    fallbackWorkflow: PersistedWorkflowGraph,
  ): Promise<{ metadata: JsonRecord; workflow: PersistedWorkflowGraph | null }> {
    if (!plannerTurnNeedsWorkflowRepair(plannerContent, failedMetadata)) {
      return { metadata: { status: "none" }, workflow: null };
    }
    const maxRepairAttempts = 2;
    let contentToRepair = plannerContent;
    let currentMetadata = failedMetadata;
    for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
      const repairPrompt = workflowPatchRepairPrompt(contentToRepair, currentMetadata, fallbackWorkflow, attempt, maxRepairAttempts);
      this.deps.orchestrationMessages.create(orchestration.id, "system", repairPrompt, {
        metadata: {
          kind: "workflow_patch_repair_request",
          workflow: workflowMessageMetadata(fallbackWorkflow),
          failedWorkflowPatch: currentMetadata,
          repairAttempt: attempt,
          maxRepairAttempts,
        },
      });
      const repairedContent = await this.deps.planner.continuePlanner(orchestration.id, undefined, {
        extraInstructions: repairPrompt,
        metadata: {
          kind: "workflow_patch_repair",
          workflow: workflowMessageMetadata(fallbackWorkflow),
          failedWorkflowPatch: currentMetadata,
          repairAttempt: attempt,
          maxRepairAttempts,
        },
      });
      const repaired = this.processPlannerWorkflowPatch(orchestration, repairedContent, fallbackWorkflow, { emitRejectedEvents: false });
      if (repaired.metadata.status === "applied") {
        return {
          metadata: {
            ...repaired.metadata,
            repaired: true,
            repairAttempts: attempt,
          },
          workflow: repaired.workflow,
        };
      }
      contentToRepair = repairedContent;
      currentMetadata = repaired.metadata;
    }
    return {
      metadata: {
        ...currentMetadata,
        status: "rejected",
        reason: "Planner workflow patch repair failed.",
        originalStatus: failedMetadata.status,
        repairAttempts: maxRepairAttempts,
      },
      workflow: null,
    };
  }

  private emitWorkflowPatchRejected(
    orchestration: Orchestration,
    workflow: PersistedWorkflowGraph,
    metadata: JsonRecord,
    patch?: WorkflowPatch,
  ): void {
    const error = String(metadata.error ?? metadata.reason ?? "invalid planner patch");
    this.deps.workflowEvents.patchRejected({
      projectId: orchestration.projectId,
      orchestrationId: orchestration.id,
      graphId: workflow.id,
      patch,
      error,
    });
    console.warn(patch ? "Planner workflow patch rejected." : "Planner workflow patch rejected before apply.", {
      graphId: workflow.id,
      workflowGraphId: workflow.graph.id,
      orchestrationId: orchestration.id,
      patchId: patch?.id ?? metadata.patchId,
      baseRevision: patch?.baseRevision ?? metadata.baseRevision,
      error,
    });
  }

  private refreshParentOrchestrationCard(orchestration: Orchestration, latestMessage: string, status: string): void {
    if (!orchestration.parentCardId) return;
    const card = this.deps.cards.findById(orchestration.parentCardId);
    if (!card) return;
    const project = this.deps.projects.getById(orchestration.projectId);
    const label = orchestrationParentLabel(orchestration, project ?? undefined, latestMessage);
    const plan = parseJson(orchestration.finalPlanJson) as AgentFleetPlan | null;
    const size = orchestrationParentSize(label, card, plan?.agentCount ?? orchestration.maxAgents);
    this.deps.cards.updateText(card.id, {
      title: `Orchestration #${orchestration.id}`,
      label,
      status,
      width: size.width,
      height: size.height,
      metadata: {
        ...(card.metadata ?? {}),
        status,
        planSummary: latestMessage,
      },
    });
  }

  private requireOrchestration(orchestrationId: number): Orchestration {
    const orchestration = this.deps.orchestrations.findById(orchestrationId);
    if (!orchestration) {
      throw new Error(`Orchestration #${orchestrationId} not found.`);
    }
    return orchestration;
  }

  private hydrateCards(cards: ExcalidrawCard[]): ExcalidrawCard[] {
    return cards.map((card) => this.hydrateCard(card));
  }

  private hydrateCard(card: ExcalidrawCard): ExcalidrawCard {
    if (!card.taskId) return card;
    const task = this.deps.tasks.getById(card.taskId);
    if (!task) return card;
    return cardViewForTask(card, task, this.taskProgress(task));
  }

  private taskProgress(task: Task): ExcalidrawTaskProgress {
    return buildTaskProgress(
      task,
      this.deps.tasks.listRecentCodexActivity(task.id, 12),
      this.deps.tasks.getTaskMessageStatusCounts(task.id),
      this.deps.feedback?.getTaskFeedbackSummary(task.id) ?? null,
    );
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const fullPath = path.resolve(STATIC_ROOT, relative);
    if (!fullPath.startsWith(STATIC_ROOT)) {
      this.sendJson(res, 403, { error: "Forbidden." });
      return;
    }

    try {
      const content = await fs.readFile(fullPath);
      res.writeHead(200, { "content-type": contentType(fullPath) }).end(content);
    } catch {
      if (pathname !== "/") {
        await this.serveStatic("/", res);
        return;
      }
      this.sendJson(res, 404, { error: "Web UI build not found. Run npm run build or use npm run excalidraw." });
    }
  }

  private applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = allowedCorsOrigin(req.headers.origin, this.deps.config.excalidrawCorsOrigin);
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  }
}

function parseOrchestrateCommand(message: string): { original: string; prompt: string } {
  if (!message) {
    throw new Error("/orchestrate requires a non-empty message.");
  }
  const match = /^\/orchestrate(?:\s+([\s\S]+))?$/i.exec(message);
  if (!match) {
    throw new Error("Use /orchestrate <message>.");
  }
  const prompt = (match[1] ?? "").trim();
  if (!prompt) {
    throw new Error("/orchestrate requires a non-empty message.");
  }
  return { original: `/orchestrate ${prompt}`, prompt };
}

function readyMessage(plan: AgentFleetPlan): string {
  return [
    "I think this plan is ready to spawn.",
    "",
    `Architecture: ${plan.architectureSummary}`,
    `Agents: ${plan.agentCount}`,
    ...plan.agents.map((agent, index) => `${index + 1}. ${agent.name} - ${agent.objective}`),
    "",
    "Use Spawn Agents when you approve this plan.",
  ].join("\n");
}

function orchestrationQuestions(messages: OrchestrationMessage[], workflow: PersistedWorkflowGraph | null): PlannerQuestionView[] {
  const answers = latestQuestionAnswers(messages);
  const questions: PlannerQuestionView[] = [];
  const seen = new Set<string>();
  for (const openQuestion of workflow?.graph.openQuestions ?? []) {
    if (!isWorkflowOpenQuestion(openQuestion) || seen.has(openQuestion.id)) continue;
    const answer = answers.get(openQuestion.id) ?? workflowQuestionAnswer(openQuestion);
    const status = openQuestion.status === "resolved" ? "resolved" : openQuestion.status === "deprecated" ? "deprecated" : answer ? "answered" : "open";
    questions.push({
      id: openQuestion.id,
      text: openQuestion.question,
      detail: openQuestion.detail,
      allowMultiSelect: openQuestion.allowMultiSelect ?? false,
      options: openQuestion.options ?? [],
      recommendedOptionIds: openQuestion.recommendedOptionIds,
      recommendationRationale: openQuestion.recommendationRationale,
      source: "workflow",
      status,
      answer,
      workflowNodeId: openQuestion.nodeIds?.[0] ?? openQuestion.id,
      messages: questionMessages(messages, openQuestion.id),
    });
    seen.add(openQuestion.id);
  }
  return questions;
}

function latestQuestionAnswers(messages: OrchestrationMessage[]): Map<string, NonNullable<PlannerQuestionView["answer"]>> {
  const answers = new Map<string, NonNullable<PlannerQuestionView["answer"]>>();
  for (const message of messages) {
    const metadata = parseJson(message.metadataJson) as {
      kind?: string;
      questionId?: string;
      selectedOptionIds?: string[];
      selectedLabels?: string[];
      customText?: string;
      source?: string;
    } | null;
    if ((metadata?.kind !== "question_answer" && metadata?.kind !== "option_answer" && metadata?.kind !== "question_message") || !metadata.questionId) continue;
    answers.set(metadata.questionId, {
      selectedOptionIds: metadata.selectedOptionIds ?? [],
      selectedLabels: metadata.selectedLabels ?? [],
      customText: metadata.customText,
      content: message.content,
      createdAt: message.createdAt,
      source: metadata.source,
    });
  }
  return answers;
}

function questionMessages(messages: OrchestrationMessage[], questionId: string): PlannerQuestionView["messages"] {
  return messages
    .filter((message) => {
      const metadata = parseJson(message.metadataJson) as { questionId?: string; kind?: string } | null;
      return metadata?.questionId === questionId && metadata.kind !== "workflow_patch";
    })
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }));
}

function workflowQuestionAnswer(question: WorkflowOpenQuestion): NonNullable<PlannerQuestionView["answer"]> | null {
  if (!question.answer) return null;
  return {
    selectedOptionIds: [],
    selectedLabels: [],
    customText: question.answer,
    content: question.answer,
    createdAt: question.resolvedAt ?? question.updatedAt,
    source: "workflow",
  };
}

function batchedQuestionStatusMessage(questions: PlannerQuestionView[]): string {
  const active = questions.filter((question) => question.status !== "deprecated");
  const unanswered = active.filter((question) => !question.answer && question.status !== "resolved");
  if (!active.length) {
    return "No planner questions are open. Continue planning or prepare the agent plan.";
  }
  if (!unanswered.length) {
    return "Question batch complete. Continue Planning can let the model ask another wave, or Prepare Plan can build the agent plan.";
  }
  return `Saved answer. ${unanswered.length} question${unanswered.length === 1 ? "" : "s"} still need answers before continuing the planning wave.`;
}

function questionTurnContent(question: PlannerQuestionView, selectedLabels: string[], freeform: string): string {
  const parts = [`Question: ${question.text}`];
  if (selectedLabels.length) {
    parts.push(`Selected: ${selectedLabels.join(", ")}`);
  }
  if (freeform) {
    parts.push(`User reply: ${freeform}`);
  }
  return parts.join("\n");
}

function questionScopedPlannerPrompt(question: PlannerQuestionView, userMessage: string): string {
  return [
    "This is a question-scoped planning turn.",
    `Question id: ${question.id}`,
    question.workflowNodeId ? `Workflow node id: ${question.workflowNodeId}` : null,
    `Question: ${question.text}`,
    question.detail ? `Detailed question: ${question.detail}` : null,
    question.options.length ? `Current options:\n${question.options.map((option) => `- ${option.id}: ${option.label}${option.description ? ` - ${option.description}` : ""}`).join("\n")}` : "Current options: none",
    question.recommendedOptionIds?.length ? `Current recommended option ids: ${question.recommendedOptionIds.join(", ")}` : null,
    question.recommendationRationale ? `Current recommendation rationale: ${question.recommendationRationale}` : null,
    `User message:\n${userMessage}`,
    "Update the WorkflowGraph with a semantic WorkflowPatch. If the answer settles the question, resolve the open_question and update the matching node. If more nuance is needed, update this open_question with revised detail/options/recommendations or add follow-up open_question nodes.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function isWorkflowOpenQuestion(value: unknown): value is WorkflowOpenQuestion {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as WorkflowOpenQuestion).id === "string");
}

function savedAnswersPlannerPrompt(orchestration: Orchestration, questions: PlannerQuestionView[]): string {
  const answered = questions.filter((question) => question.answer || question.messages.length > 0);
  const lines = answered.length
    ? answered.map((question) => {
        const latestMessage = question.messages.at(-1)?.content;
        return `- ${question.text}\n  Answer: ${question.answer?.content ?? latestMessage ?? "none"}`;
      })
    : ["- No saved answers yet."];
  return [
    "Update the current orchestration plan using the saved question answers.",
    `Orchestration #${orchestration.id}`,
    `Goal: ${orchestration.goal}`,
    "",
    "Saved answers:",
    ...lines,
  ].join("\n");
}

function latestWorkflowPatchMetadata(messages: OrchestrationMessage[]): unknown | null {
  for (const message of [...messages].reverse()) {
    const metadata = parseJson(message.metadataJson) as { workflowPatch?: unknown } | null;
    if (metadata?.workflowPatch) return metadata.workflowPatch;
  }
  return null;
}

function workflowMessageMetadata(workflow: PersistedWorkflowGraph): JsonRecord {
  return {
    graphId: workflow.id,
    workflowGraphId: workflow.graph.id,
    revision: workflow.revision,
    projectId: workflow.projectId,
    orchestrationId: workflow.orchestrationId,
  };
}

function workflowPlannerPromptContract(workflow: PersistedWorkflowGraph): string {
  const example = {
    id: `patch-example-rev-${workflow.revision}`,
    graphId: workflow.graph.id,
    baseRevision: workflow.revision,
    reason: "Add a concise semantic planning node.",
    author: "planner",
    createdAt: "2026-05-09T12:00:00.000Z",
    operations: [
      {
        op: "add_node",
        node: {
          id: "component-example-node",
          kind: "frontend_component",
          status: "active",
          title: "Example node",
          summary: "One semantic workflow concept.",
          createdAt: "2026-05-09T12:00:00.000Z",
          updatedAt: "2026-05-09T12:00:00.000Z",
        },
      },
    ],
  };
  const openQuestionExample = {
    op: "add_open_question",
    question: {
      id: "question-visual-style",
      question: "Visual style?",
      detail: "Choose the first visual target so implementation agents can split work correctly.",
      status: "open",
      allowMultiSelect: false,
      options: [
        { id: "option-visual-2d", label: "2D top-down", description: "Fastest to implement and test." },
        { id: "option-visual-25d", label: "2.5D pseudo-3D", description: "Richer look with more scope." },
      ],
      recommendedOptionIds: ["option-visual-2d"],
      recommendationRationale: "2D top-down is the safest first playable target.",
      nodeIds: ["node-question-visual-style"],
      createdAt: "2026-05-09T12:00:00.000Z",
      updatedAt: "2026-05-09T12:00:00.000Z",
    },
  };
  return [
    "Use the arc-workflow-architect skill concepts when maintaining the live workflow.",
    "Maintain an evolving semantic WorkflowGraph for this orchestration. The model owns all semantic workflow nodes and questions.",
    "Respond with concise user-facing planner text.",
    "When requirements, architecture, risks, questions, tests, deployment, or agent plan semantics change, include exactly one fenced ARC_WORKFLOW_PATCH_JSON block. Do this on the first planner turn too.",
    "If the graph has no nodes yet, create the goal and any useful initial workflow/question nodes from the user's actual orchestration prompt. Do not copy the example node.",
    "Every clarification question you ask in prose must also appear in that WorkflowPatch as one open_question node plus a matching add_open_question operation with detail/options/recommendedOptionIds when useful.",
    "If you ask multiple decisions/questions, create one open_question node and one add_open_question record per decision.",
    `Patch graphId must be ${workflow.graph.id}; baseRevision must be ${workflow.revision}; reason is required.`,
    "Allowed node.kind values: goal, requirement, decision, system_component, frontend_component, backend_component, data_store, external_service, agent_task, milestone, risk, open_question, note. Do not invent kinds such as game_module or architecture; use system_component, requirement, decision, or note instead.",
    "Allowed edge.kind values: depends_on, implements, contains, blocks, relates_to, replaces, answers, mitigates, produces, consumes. Do not invent edge kinds such as decomposes_into or enabled_by; use contains, implements, depends_on, or relates_to instead.",
    "Use WorkflowPatch field names exactly: node.kind, node.title, edge.kind, edge.fromNodeId, edge.toNodeId. Do not use type, label, from, or to.",
    `Valid add_open_question operation shape: ${JSON.stringify(openQuestionExample)}`,
    "For add_open_question, put id/question/detail/status/options/recommendedOptionIds/recommendationRationale/nodeIds inside the question object. Do not put nodeId, detail, or options directly on the operation.",
    "Question options must use id, label, and optional description. Do not use option title/summary.",
    `Compact valid WorkflowPatch example: ${JSON.stringify(example)}`,
    "The example is syntax-only. Never create component-example-node or generic example content in the real workflow.",
    "WorkflowPatch operations must be semantic only. Do not include Excalidraw elements, appState, files, coordinates, or canvas shape JSON.",
    "If user input is ambiguous, ask the clarifying question and emit the matching open_question workflow patch.",
    `Current graph summary:\n${workflowSummary(workflow.graph)}`,
  ].join("\n");
}

function plannerTurnNeedsWorkflowRepair(content: string, metadata: JsonRecord): boolean {
  if (metadata.status === "rejected") return true;
  if (metadata.status !== "none") return false;
  return /(\?|question|choose|option|recommend|workflow|plan|architecture|requirement|risk|decision)/i.test(content);
}

function workflowPatchRepairPrompt(
  content: string,
  metadata: JsonRecord,
  workflow: PersistedWorkflowGraph,
  attempt: number,
  maxAttempts: number,
): string {
  return [
    `Your previous planner response did not produce a valid semantic WorkflowPatch. Repair attempt ${attempt} of ${maxAttempts}.`,
    `Failure: ${String(metadata.error ?? metadata.status ?? "missing workflow patch")}`,
    "Re-emit the workflow update now. Output concise planner text plus exactly one ARC_WORKFLOW_PATCH_JSON fenced block.",
    "If you asked any clarification question, represent it as an open_question node and add_open_question record with multiple-choice options and recommendedOptionIds when applicable.",
    "For add_open_question, the operation must be {\"op\":\"add_open_question\",\"question\":{...}}. Put question text in question.question, link the visual node through question.nodeIds, and make options use id/label/description.",
    "For update_node, update_edge, and update_open_question, changes must contain only mutable semantic fields. Do not put createdAt, updatedAt, selectedOptionIds, selectedLabels, or sourcePatchId inside changes.",
    "If a user answered a question, use resolve_open_question with an answer string. Do not store selectedOptionIds in WorkflowPatch changes.",
    "Use only allowed node.kind values: goal, requirement, decision, system_component, frontend_component, backend_component, data_store, external_service, agent_task, milestone, risk, open_question, note.",
    "Use only allowed edge.kind values: depends_on, implements, contains, blocks, relates_to, replaces, answers, mitigates, produces, consumes.",
    "If the graph is empty, create model-authored goal/workflow nodes from the user's actual orchestration prompt. Do not use example content.",
    `Patch graphId must be ${workflow.graph.id}; baseRevision must be ${workflow.revision}.`,
    `Current graph:\n${workflowSummary(workflow.graph)}`,
    "Previous response:",
    content,
  ].join("\n\n");
}

function workflowFleetPlanPromptContract(workflow: PersistedWorkflowGraph): string {
  return [
    "Use the current WorkflowGraph as source-of-truth planning context.",
    "Include a concise WorkflowGraph summary in AgentFleetPlan.sharedContext.",
    `Current graph id: ${workflow.graph.id}; current revision: ${workflow.revision}.`,
    workflowSummary(workflow.graph),
    "Child implementation agents may read this workflow context but must not directly mutate WorkflowGraph in v1.",
  ].join("\n");
}

function workflowPatchStatusMessage(metadata: JsonRecord): string {
  if (metadata.status === "applied") {
    return `Workflow patch applied: ${String(metadata.reason ?? metadata.patchId ?? "planner update")}`;
  }
  if (metadata.status === "rejected") {
    return `Workflow patch rejected: ${String(metadata.error ?? metadata.reason ?? "invalid planner patch")}`;
  }
  return "Workflow patch not applied.";
}

function withWorkflowSharedContext(plan: AgentFleetPlan, graph: WorkflowGraph): AgentFleetPlan {
  const summary = workflowSummary(graph);
  const baseSharedContext = plan.sharedContext.includes("Current WorkflowGraph:")
    ? plan.sharedContext.split("\n\nCurrent WorkflowGraph:")[0]
    : plan.sharedContext;
  return {
    ...plan,
    sharedContext: `${baseSharedContext}\n\nCurrent WorkflowGraph:\n${summary}\n\nChild agents receive this workflow as context only. They must not directly mutate WorkflowGraph in v1 unless routed back through the planner.`,
  };
}

function workflowSummary(graph: WorkflowGraph): string {
  const activeNodes = graph.nodes.filter((node) => node.status !== "deprecated");
  const deprecatedNodes = graph.nodes.filter((node) => node.status === "deprecated");
  const lines = [
    `Graph: ${graph.id} rev ${graph.revision}`,
    `Goal: ${graph.title}`,
    "Active nodes:",
    ...activeNodes.slice(0, 24).map((node) => `- ${node.id} [${node.kind}/${node.status}]: ${node.title}${node.summary ? ` - ${node.summary}` : ""}`),
  ];
  if (deprecatedNodes.length) {
    lines.push("Deprecated nodes:", ...deprecatedNodes.slice(0, 12).map((node) => `- ${node.id}: ${node.title}${node.deprecatedReason ? ` - ${node.deprecatedReason}` : ""}`));
  }
  const questions = graph.openQuestions.filter((question) => question.status === "open");
  if (questions.length) {
    lines.push("Open questions:", ...questions.slice(0, 8).map((question) => `- ${question.id}: ${question.question}`));
  }
  return lines.join("\n");
}

function buildFleetPlan(
  orchestration: Orchestration,
  project: Project,
  messages: OrchestrationMessage[],
  workflow?: PersistedWorkflowGraph,
): AgentFleetPlan {
  const decisions = selectedDecisionLines(messages);
  const maxAgents = Math.max(2, Math.min(10, orchestration.maxAgents));
  const desired = decisions.some((decision) => /dependency|package|upgrade/i.test(decision))
    ? ["Repository Audit", "Dependency Upgrade", "Compatibility Tests"]
    : decisions.some((decision) => /stability|test|build|broken/i.test(decision))
      ? ["Failure Audit", "Stability Fixes", "Regression Tests"]
      : ["Repository Audit", "Modernization Plan", "Safe Update Implementation"];
  const names = desired.slice(0, maxAgents);
  const agents: AgentFleetPlanAgent[] = names.map((name, index) => {
    const role = index === names.length - 1 ? "tester" : "implementer";
    const objective = objectiveForAgent(name, orchestration.goal, project);
    return {
      name,
      role,
      objective,
      prompt: [
        `Implement the "${name}" slice for orchestration #${orchestration.id}.`,
        `Project: ${project.projectName}`,
        `Repo path: ${project.repoPath}`,
        `Remote: ${project.remoteUrl ?? project.remoteStatus}`,
        `Parent goal: ${orchestration.goal}`,
        decisions.length ? `Selected planning decisions:\n${decisions.map((decision) => `- ${decision}`).join("\n")}` : "No extra decisions were selected.",
        `Scope: ${objective}`,
        "Inspect the actual repository before editing. Keep changes focused on this slice and avoid touching sibling-owned areas unless required for build correctness.",
      ].join("\n\n"),
      effort: role === "tester" ? "medium" : "medium",
      prTitle: `${name}: ${oneLine(orchestration.goal, 48)}`,
      dependsOn: index === 0 ? [] : [names[0]],
      expectedFiles: expectedFilesForAgent(name),
      acceptanceCriteria: [
        `Changes apply to ${project.projectName}, not the Arc-Tech runner repository.`,
        "The assigned slice is implemented with minimal unrelated refactors.",
        "Relevant build/test/validation commands are run when available and reported in the summary.",
      ],
    };
  });
  const plan: AgentFleetPlan = {
    orchestrationGoal: orchestration.goal,
    architectureSummary: `Modernize ${project.projectName} for "${oneLine(orchestration.goal, 100)}" using project-scoped agents working in ${project.repoPath}.`,
    agentCount: agents.length,
    sharedContext: [
      `Project: ${project.projectName}`,
      `Repo path: ${project.repoPath}`,
      `Remote: ${project.remoteUrl ?? project.remoteStatus}`,
      `Worktrees: ${project.worktreesPath}`,
      "The Arc-Tech runner is only the execution harness. Agents must inspect and modify the selected project repository.",
      decisions.length ? `Planning decisions: ${decisions.join("; ")}` : "No custom planning decisions were selected.",
    ].join("\n"),
    integrationStrategy: `Use isolated branches/worktrees for ${project.projectName}; start with repository discovery, then apply narrow modernization changes and run available validation commands.`,
    agents,
  };
  return workflow ? withWorkflowSharedContext(plan, workflow.graph) : plan;
}

function selectedDecisionLines(messages: OrchestrationMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => {
      const metadata = parseJson(message.metadataJson) as { kind?: string; selectedLabels?: string[]; customText?: string } | null;
      if (metadata?.selectedLabels?.length) return metadata.selectedLabels.join(", ");
      if (metadata?.customText && !isContinueText(metadata.customText)) return metadata.customText;
      if ((metadata?.kind === "question_answer" || metadata?.kind === "question_message") && message.content && !isContinueText(message.content)) return message.content;
      if (metadata?.kind === "freeform") return message.content;
      return null;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0 && !isContinueText(value));
}

function isContinueText(value: string): boolean {
  return /continue planning|revise|replan|not ready|wrong repo|did u read|did you read|wdym|what\?\?|discord/i.test(value);
}

function objectiveForAgent(name: string, goal: string, project: Project): string {
  if (/audit|plan/i.test(name)) return `Inspect ${project.projectName}, identify outdated dependencies/runtime assumptions, and produce focused update targets for ${goal}.`;
  if (/dependency|upgrade|implementation|fix/i.test(name)) return `Apply safe modernization changes in ${project.projectName} for ${goal}.`;
  return `Verify ${project.projectName} still builds/runs where possible after modernization work for ${goal}.`;
}

function expectedFilesForAgent(name: string): string[] {
  if (/dependency|upgrade/i.test(name)) return ["package.json", "package-lock.json", "requirements.txt", "pyproject.toml", "Cargo.toml"];
  if (/test|stability|compatibility/i.test(name)) return ["tests/", "README.md", "package.json"];
  return ["README.md", "package.json", "src/", "app/"];
}

function childAgentPrompt(
  orchestration: Orchestration,
  plan: AgentFleetPlan,
  agent: AgentFleetPlanAgent,
  index: number,
  branchName: string,
): string {
  return `You are child implementation agent ${index} for Excalidraw orchestration #${orchestration.id}.

Agent name:
${agent.name}

Role:
${agent.role}

Objective:
${agent.objective}

Master plan:
${plan.architectureSummary}

Shared context:
${plan.sharedContext}

Integration strategy:
${plan.integrationStrategy}

Depends on:
${agent.dependsOn?.length ? agent.dependsOn.join("\n") : "None"}

Expected files:
${agent.expectedFiles?.length ? agent.expectedFiles.join("\n") : "Not specified"}

Acceptance criteria:
${agent.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}

Branch:
${branchName}

Detailed prompt:
${agent.prompt}

Rules:
- Work only on your assigned objective.
- Avoid unrelated refactors.
- Keep changes mergeable with sibling agents.
- Do not merge your branch.
- Do not run git add, git commit, git push, or gh pr create.
- The runner owns committing, pushing, and pull request creation.
- Run relevant tests if available.
- End with a concise completion summary.`;
}

function orchestrationParentLabel(orchestration: Orchestration, project: Project | undefined, latestMessage: string): string {
  const plan = parseJson(orchestration.finalPlanJson) as AgentFleetPlan | null;
  if (plan) {
    return [
      `Orchestration #${orchestration.id}`,
      `Status: ${orchestration.status}`,
      `Project: ${project?.projectName ?? orchestration.projectId}`,
      `Goal: ${oneLine(orchestration.goal, 120)}`,
      "",
      `Plan: ${plan.agentCount} worker agents ready`,
      `Architecture: ${oneLine(plan.architectureSummary, 180)}`,
      `Integration: ${oneLine(plan.integrationStrategy, 180)}`,
      "",
      "Workers:",
      ...plan.agents.slice(0, 10).map((agent, index) => `${index + 1}. ${agent.name} (${agent.role}) - ${oneLine(agent.objective, 120)}`),
      "",
      "Press Start Plan in this container to spawn the worker agents.",
    ].join("\n");
  }
  return [
    `Orchestration #${orchestration.id}`,
    `Status: ${orchestration.status}`,
    `Project: ${project?.projectName ?? orchestration.projectId}`,
    `Repo: ${project?.repoPath ?? "unknown"}`,
    `Remote: ${project?.remoteUrl ?? project?.remoteStatus ?? "unknown"}`,
    `Goal: ${oneLine(orchestration.goal, 110)}`,
    "Plan: in progress",
    "",
    oneLine(latestMessage, 180),
  ].join("\n");
}

function orchestrationBorderLabel(orchestration: Orchestration, project: Project, plan: AgentFleetPlan): string {
  return [
    `Orchestration #${orchestration.id}: ${oneLine(plan.orchestrationGoal, 80)}`,
    `Status: spawning agents`,
    `Project: ${project.projectName}`,
    `Repo: ${project.repoPath}`,
    `Agents: ${plan.agentCount}`,
    `Strategy: ${oneLine(plan.integrationStrategy, 140)}`,
  ].join("\n");
}

function orchestrationParentSize(
  label: string,
  existing?: Pick<ExcalidrawCard, "width" | "height">,
  agentCapacity = 3,
): { width: number; height: number } {
  const size = taskCardSize(label, existing);
  const layout = groupLayout(0, 0, agentCapacity);
  return {
    width: Math.max(existing?.width ?? 0, size.width, layout.width),
    height: Math.max(existing?.height ?? 0, size.height, layout.height),
  };
}

function groupLayout(x: number, y: number, agentCount: number): { x: number; y: number; width: number; height: number; title: string } {
  const cols = ORCHESTRATION_COLUMNS;
  const rows = Math.max(1, Math.ceil(agentCount / cols));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: cols * ORCHESTRATION_AGENT_SLOT_WIDTH + (cols + 1) * ORCHESTRATION_GRID_GAP,
    height: ORCHESTRATION_HEADER_HEIGHT
      + rows * ORCHESTRATION_AGENT_SLOT_HEIGHT
      + Math.max(0, rows - 1) * ORCHESTRATION_GRID_GAP
      + ORCHESTRATION_GRID_GAP,
    title: "Orchestration Agent Group",
  };
}

function childCardPosition(group: { x: number; y: number }, index: number): { x: number; y: number } {
  const zero = index - 1;
  const col = zero % ORCHESTRATION_COLUMNS;
  const row = Math.floor(zero / ORCHESTRATION_COLUMNS);
  return {
    x: group.x + ORCHESTRATION_GRID_GAP + col * (ORCHESTRATION_AGENT_SLOT_WIDTH + ORCHESTRATION_GRID_GAP),
    y: group.y + ORCHESTRATION_HEADER_HEIGHT + row * (ORCHESTRATION_AGENT_SLOT_HEIGHT + ORCHESTRATION_GRID_GAP),
  };
}

function aggregateAgents(agents: Array<{ status: string; branchName: string | null; prUrl: string | null }>): JsonRecord {
  return {
    total: agents.length,
    done: agents.filter((agent) => agent.status === "done").length,
    running: agents.filter((agent) => agent.status === "running" || agent.status === "queued").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
    branches: agents.map((agent) => agent.branchName).filter(Boolean),
    prs: agents.map((agent) => agent.prUrl).filter(Boolean),
  };
}

function workflowView(workflow: PersistedWorkflowGraph): JsonRecord {
  return {
    id: workflow.id,
    projectId: workflow.projectId,
    orchestrationId: workflow.orchestrationId,
    title: workflow.title,
    revision: workflow.revision,
    graph: workflow.graph,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

function workflowPatchView(patch: PersistedWorkflowPatch): JsonRecord {
  return {
    id: patch.id,
    graphId: patch.graphId,
    projectId: patch.projectId,
    orchestrationId: patch.orchestrationId,
    baseRevision: patch.baseRevision,
    resultingRevision: patch.resultingRevision,
    patch: patch.patch,
    source: patch.source,
    reason: patch.reason,
    createdAt: patch.createdAt,
  };
}

function workflowPatchFromBody(body: JsonRecord): WorkflowPatch {
  const candidate = body.patch && typeof body.patch === "object" && !Array.isArray(body.patch) ? body.patch : body;
  return candidate as WorkflowPatch;
}

function writeWorkflowSse(res: ServerResponse, event: WorkflowEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isStaleWorkflowError(message: string): boolean {
  return /stale|baseRevision|revision .*does not match/i.test(message);
}

function isOrchestrationReadyForSpawn(orchestration: Pick<Orchestration, "status">): boolean {
  return ["ready_for_approval", "READY_TO_ORCHESTRATE", "approved_for_spawn"].includes(orchestration.status);
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
}

function parseJson(value: string | null): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "agent";
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

async function readJson(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as JsonRecord;
}

function parseImplementCommand(message: string): { original: string; prompt: string } {
  if (!message) {
    throw new Error("/implement requires a non-empty message.");
  }
  const match = /^\/implement(?:\s+([\s\S]+))?$/i.exec(message);
  if (!match) {
    throw new Error("Use /implement <message>.");
  }
  const prompt = (match[1] ?? "").trim();
  if (!prompt) {
    throw new Error("/implement requires a non-empty message.");
  }
  return { original: `/implement ${prompt}`, prompt };
}

function stringField(body: JsonRecord, key: string, defaultValue = ""): string {
  const value = body[key];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function numberField(body: JsonRecord, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function limitParam(url: URL): number {
  const raw = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isFinite(raw)) return 50;
  return Math.max(1, Math.min(100, Math.floor(raw)));
}

function numericQueryParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return parsed;
}

function nextCardX(seed: number): number {
  return 80 + (seed % 4) * 390;
}

function nextCardY(seed: number): number {
  return 80 + (Math.floor(seed / 4) % 5) * 220;
}

function contentType(fullPath: string): string {
  if (fullPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (fullPath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (fullPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (fullPath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function cardViewForTask(card: ExcalidrawCard, task: Task, progress: ExcalidrawTaskProgress): ExcalidrawCard {
  const label = taskCardLabelWithProgress(task, progress);
  const size = taskCardSize(label, card);
  const links = taskLinks(task);
  return {
    ...card,
    title: taskTitle(task),
    label,
    status: mapTaskStatus(task.status),
    branch: task.taskBranch,
    width: size.width,
    height: links.length ? size.height + 34 : size.height,
    links,
    progress,
  };
}

function taskLinks(task: Task): ExcalidrawCardLink[] {
  const links: ExcalidrawCardLink[] = [];
  addSafeLink(links, "PR", task.pullRequestUrl ?? task.prUrl);
  addSafeLink(links, "Discord", task.discordThreadUrl);
  links.push({ label: "Task", url: `/?projectId=${encodeURIComponent(String(task.projectId))}&taskId=${encodeURIComponent(String(task.id))}` });
  return dedupeLinks(links).slice(0, 4);
}

function addSafeLink(links: ExcalidrawCardLink[], label: string, value: string | null | undefined): void {
  const url = browserSafeUrl(value);
  if (!url) return;
  links.push({ label, url });
}

function browserSafeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function dedupeLinks(links: ExcalidrawCardLink[]): ExcalidrawCardLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function allowedCorsOrigin(requestOrigin: string | undefined, configured: string): string | null {
  const allowed = configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowed.includes("*")) {
    return "*";
  }
  if (requestOrigin && allowed.includes(requestOrigin)) {
    return requestOrigin;
  }
  return requestOrigin ? null : (allowed[0] ?? null);
}

function projectBlockers(project: Project, config: AppConfig): string[] {
  const blockers: string[] = [];
  if (!config.githubPrEnabled) {
    blockers.push("Set GITHUB_PR_ENABLED=true and restart Arc-Tech before starting Direct Agent tasks.");
  }
  if (project.remoteStatus !== "configured" || !project.remoteUrl) {
    blockers.push("Connect a GitHub repo remote before starting Direct Agent tasks.");
  }
  return blockers;
}

function looksLikeGitRemote(value: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/).+/.test(value);
}

function isClientError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /must be|required|too large|non-empty|mode must|source=|Use \/(implement|orchestrate)|Git remote URL|project|closed|remote before|Orchestration message/.test(message);
}
