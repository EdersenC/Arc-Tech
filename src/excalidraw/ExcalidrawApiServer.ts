import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { PullRequestFeedbackRepo } from "../github/PullRequestFeedbackRepo.js";
import { stableJson } from "../orchestrations/AgentFleetPlanValidator.js";
import type { OrchestrationAgentsRepo } from "../orchestrations/repos/OrchestrationAgentsRepo.js";
import type { OrchestrationMessagesRepo } from "../orchestrations/repos/OrchestrationMessagesRepo.js";
import type { OrchestrationsRepo } from "../orchestrations/repos/OrchestrationsRepo.js";
import type { AgentFleetPlan, AgentFleetPlanAgent, Orchestration, OrchestrationMessage, PlannerQuestion } from "../orchestrations/types.js";
import type { ProjectStore, TaskStore } from "../stores.js";
import type { ImplementService } from "../tasks/ImplementService.js";
import { DEFAULT_MODEL, type Effort, type Project, type Task } from "../types.js";
import type {
  PersistedWorkflowGraph,
  PersistedWorkflowPatch,
  WorkflowEvent,
  WorkflowEventBus,
  WorkflowService,
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
  orchestrations: OrchestrationsRepo;
  orchestrationAgents: OrchestrationAgentsRepo;
  orchestrationMessages: OrchestrationMessagesRepo;
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
    const orchestrationOptionMatch = /^\/api\/orchestrations\/(\d+)\/options\/([^/]+)\/select$/.exec(url.pathname);
    if (orchestrationOptionMatch && req.method === "POST") {
      await this.handleOrchestrationOptionSelect(Number(orchestrationOptionMatch[1]), decodeURIComponent(orchestrationOptionMatch[2]), req, res);
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

    const question = plannerQuestion(orchestration, project, 0);
    const message = plannerQuestionMessage(orchestration.goal, project, question);
    this.deps.orchestrationMessages.create(orchestration.id, "planner", message, {
      metadata: { kind: "question", question },
    });
    const updated = this.deps.orchestrations.updateStatus(orchestration.id, "waiting_for_user_choice");
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
    this.sendJson(res, 201, { orchestration: this.orchestrationView(saved), card: this.hydrateCard(card) });
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
    const updated = this.advancePlanner(orchestrationId);
    this.sendJson(res, 202, this.orchestrationView(updated));
  }

  private async handleOrchestrationAnswer(
    orchestrationId: number,
    questionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.requireOrchestration(orchestrationId);
    const body = await readJson(req);
    const selectedOptionIds = arrayOfStrings(body.selectedOptionIds).filter(Boolean);
    const customText = stringField(body, "customText", "").trim();
    if (selectedOptionIds.length === 0 && !customText) {
      throw new Error("Select at least one option or enter a custom answer.");
    }
    const question = latestQuestion(this.deps.orchestrationMessages.listRecent(orchestrationId, 20), questionId);
    const selectedLabels = question
      ? question.options.filter((option) => selectedOptionIds.includes(option.id)).map((option) => option.label)
      : selectedOptionIds;
    const content = customText || `Selected: ${selectedLabels.join(", ")}`;
    this.deps.orchestrationMessages.create(orchestrationId, "user", content, {
      authorUserId: "excalidraw",
      metadata: { source: "excalidraw", kind: "option_answer", questionId, selectedOptionIds, selectedLabels, customText },
    });
    const updated = this.advancePlanner(orchestrationId);
    this.sendJson(res, 202, this.orchestrationView(updated));
  }

  private async handleOrchestrationOptionSelect(
    orchestrationId: number,
    optionId: string,
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.requireOrchestration(orchestrationId);
    const question = latestQuestion(this.deps.orchestrationMessages.listRecent(orchestrationId, 20));
    if (!question) {
      throw new Error("No active planner question is available.");
    }
    const option = question.options.find((candidate) => candidate.id === optionId);
    if (!option) {
      throw new Error(`Option ${optionId} was not found on the active question.`);
    }
    this.deps.orchestrationMessages.create(orchestrationId, "user", `Selected: ${option.label}`, {
      authorUserId: "excalidraw",
      metadata: {
        source: "excalidraw",
        kind: "option_answer",
        questionId: question.id,
        selectedOptionIds: [option.id],
        selectedLabels: [option.label],
      },
    });
    const updated = this.advancePlanner(orchestrationId);
    this.sendJson(res, 202, this.orchestrationView(updated));
  }

  private async handleLaunchOrchestration(orchestrationId: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const orchestration = this.requireOrchestration(orchestrationId);
    const project = await this.getSyncedExcalidrawProject(requireValue(this.deps.projects.getById(orchestration.projectId), "Project not found."));
    const projectView = this.projectView(project);
    if (!projectView.prReady) {
      this.sendJson(res, 409, {
        code: projectView.githubPrEnabled ? "REMOTE_REQUIRED" : "PR_DISABLED",
        error: projectView.blockers.join(" "),
        project: projectView,
      });
      return;
    }
    const body = await readJson(req);
    const plan = this.ensureFleetPlan(orchestrationId, project);
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
    const project = this.requireExcalidrawProject(projectId);
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
      this.sendJson(res, isStaleWorkflowError(message) ? 409 : 400, { error: message });
    }
  }

  private async handleWorkflowEvents(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const projectId = numericQueryParam(url, "projectId");
    if (projectId === null) {
      throw new Error("projectId is required.");
    }
    const project = this.requireExcalidrawProject(projectId);
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
      return this.requireExcalidrawProject(projectId);
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
      if (!project || project.guildId !== this.deps.config.excalidrawProjectGuildId) {
        throw new Error(`Excalidraw project ${projectId} was not found.`);
      }
      return project;
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
    return {
      orchestration: {
        ...orchestration,
        projectName: project?.projectName ?? null,
        projectSlug: project?.projectSlug ?? null,
        repoPath: project?.repoPath ?? null,
        worktreesPath: project?.worktreesPath ?? null,
        remoteStatus: project?.remoteStatus ?? null,
        remoteUrl: project?.remoteUrl ?? null,
        latestQuestion: latestQuestion(messages),
        finalPlan: parseJson(orchestration.finalPlanJson),
      },
      messages: messages.map((message) => ({ ...message, metadata: parseJson(message.metadataJson) })),
      agents,
      parentCard,
      borderCard,
      childCards: agents
        .map((agent) => (agent.childTaskId ? this.deps.cards.findByTaskId(agent.childTaskId) : null))
        .filter((card): card is ExcalidrawCard => Boolean(card))
        .map((card) => this.hydrateCard(card)),
      aggregate: aggregateAgents(agents),
    };
  }

  private advancePlanner(orchestrationId: number): Orchestration {
    const orchestration = this.requireOrchestration(orchestrationId);
    const project = requireValue(this.deps.projects.getById(orchestration.projectId), `Project #${orchestration.projectId} not found.`);
    const messages = this.deps.orchestrationMessages.listByOrchestrationId(orchestrationId);
    const answerCount = messages.filter((message) => {
      const metadata = parseJson(message.metadataJson) as { kind?: string } | null;
      return metadata?.kind === "option_answer" || metadata?.kind === "freeform";
    }).length;

    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    const wantsMorePlanning = latestUser ? isContinuePlanningRequest(latestUser) : false;
    if (wantsMorePlanning || answerCount < 2) {
      const step = wantsMorePlanning ? Math.max(2, answerCount) : answerCount;
      this.deps.orchestrations.clearFinalPlan(orchestrationId, "waiting_for_user_choice");
      const question = plannerQuestion(orchestration, project, step);
      const message = plannerQuestionMessage(orchestration.goal, project, question);
      this.deps.orchestrationMessages.create(orchestrationId, "planner", message, {
        metadata: { kind: "question", question },
      });
      const updated = this.deps.orchestrations.updateStatus(orchestrationId, "waiting_for_user_choice");
      this.refreshParentOrchestrationCard(updated, message, "planning");
      return updated;
    }

    const plan = buildFleetPlan(orchestration, project, messages);
    const finalPlanJson = stableJson(plan);
    this.deps.orchestrations.updateFinalPlan(orchestrationId, finalPlanJson);
    this.deps.orchestrationMessages.create(orchestrationId, "planner", readyMessage(plan), {
      metadata: { kind: "ready", readySummary: plan.architectureSummary, plan },
    });
    const updated = this.deps.orchestrations.updateStatus(orchestrationId, "ready_for_approval");
    this.refreshParentOrchestrationCard(updated, readyMessage(plan), "ready");
    return updated;
  }

  private ensureFleetPlan(orchestrationId: number, project: Project): AgentFleetPlan {
    const orchestration = this.requireOrchestration(orchestrationId);
    if (orchestration.finalPlanJson) {
      const parsed = parseJson(orchestration.finalPlanJson) as AgentFleetPlan | null;
      if (parsed?.agents?.length) return parsed;
    }
    const plan = buildFleetPlan(orchestration, project, this.deps.orchestrationMessages.listByOrchestrationId(orchestrationId));
    this.deps.orchestrations.updateFinalPlan(orchestrationId, stableJson(plan));
    return plan;
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

function plannerQuestion(orchestration: Orchestration, project: Project, step: number): PlannerQuestion {
  if (step <= 0) {
    return {
      id: `orch-${orchestration.id}-scope`,
      text: `What kind of update should agents prioritize in ${project.projectName}?`,
      allowMultiSelect: false,
      options: [
        { id: "repo_audit_first", label: "Audit first", description: "Inspect structure, dependencies, runtime, and current failure points." },
        { id: "dependency_upgrade", label: "Dependency upgrade", description: "Focus on outdated packages, lockfiles, and build/runtime compatibility." },
        { id: "stability_first", label: "Stability first", description: "Prioritize tests, lint/type errors, and known broken flows." },
      ],
    };
  }
  if (step === 1) {
    return {
      id: `orch-${orchestration.id}-boundaries`,
      text: "What boundaries should the first agent batch respect?",
      allowMultiSelect: true,
      options: [
        { id: "preserve_behavior", label: "Preserve behavior", description: "Keep existing app behavior unless the plan calls out a deliberate change." },
        { id: "small_prs", label: "Small PRs", description: "Split work into narrow branches that can be reviewed independently." },
        { id: "build_required", label: "Build required", description: "Each agent should run the relevant build/test command when possible." },
      ],
    };
  }
  return {
    id: `orch-${orchestration.id}-missing-context-${step}`,
    text: `What repo-specific context should I account for before spawning agents for ${project.projectName}?`,
    allowMultiSelect: true,
    options: [
      { id: "known_broken_area", label: "Known broken area", description: "Use the text box to name the feature, command, or page that is broken." },
      { id: "target_runtime", label: "Target runtime", description: "Clarify the runtime, framework, device, or deployment target." },
      { id: "upgrade_constraints", label: "Upgrade constraints", description: "Mention dependencies, versions, files, or behavior that must not change." },
    ],
  };
}

function plannerQuestionMessage(goal: string, project: Project, question: PlannerQuestion): string {
  return [
    `Planning: ${oneLine(goal, 120)}`,
    `Project: ${project.projectName}`,
    `Repo: ${project.repoPath}`,
    `Remote: ${project.remoteUrl ?? project.remoteStatus}`,
    "",
    question.text,
    ...question.options.map((option, index) => `${index + 1}. ${option.label} - ${option.description ?? ""}`.trim()),
    question.allowMultiSelect ? "You can pick multiple options or type a custom answer." : "Pick one option or type a custom answer.",
  ].join("\n");
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

function latestQuestion(messages: OrchestrationMessage[], questionId?: string): PlannerQuestion | null {
  for (const message of [...messages].reverse()) {
    const metadata = parseJson(message.metadataJson) as { kind?: string; question?: PlannerQuestion } | null;
    if (metadata?.kind !== "question" || !metadata.question) continue;
    if (!questionId || metadata.question.id === questionId) return metadata.question;
  }
  return null;
}

function buildFleetPlan(orchestration: Orchestration, project: Project, messages: OrchestrationMessage[]): AgentFleetPlan {
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
  return {
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
}

function selectedDecisionLines(messages: OrchestrationMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => {
      const metadata = parseJson(message.metadataJson) as { kind?: string; selectedLabels?: string[]; customText?: string } | null;
      if (metadata?.selectedLabels?.length) return metadata.selectedLabels.join(", ");
      if (metadata?.customText && !isContinueText(metadata.customText)) return metadata.customText;
      if (metadata?.kind === "freeform") return message.content;
      return null;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0 && !isContinueText(value));
}

function isContinuePlanningRequest(message: OrchestrationMessage): boolean {
  if (message.role !== "user") return false;
  const metadata = parseJson(message.metadataJson) as { customText?: string } | null;
  return isContinueText(metadata?.customText ?? message.content);
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
  return [
    `Orchestration #${orchestration.id}`,
    `Status: ${orchestration.status}`,
    `Project: ${project?.projectName ?? orchestration.projectId}`,
    `Repo: ${project?.repoPath ?? "unknown"}`,
    `Remote: ${project?.remoteUrl ?? project?.remoteStatus ?? "unknown"}`,
    `Goal: ${oneLine(orchestration.goal, 110)}`,
    plan ? `Plan: ${plan.agentCount} agents` : "Plan: in progress",
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
