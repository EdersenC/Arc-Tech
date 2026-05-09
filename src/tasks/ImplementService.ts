import type { GitManager } from "../git.js";
import type { ProjectStore, TaskStore } from "../stores.js";
import type { TaskMessagePump } from "../taskMessagePump.js";
import type { Effort, Project, SandboxMode, Task, TaskMessage, TaskMode } from "../types.js";
import { isClosedTaskStatus } from "../threadRouting.js";
import type { TaskService } from "./TaskService.js";

export type ImplementSourceUi = "discord" | "excalidraw";

export interface RunImplementInput {
  project: Project;
  prompt: string;
  requestedBy: string | null;
  sourceUi: ImplementSourceUi;
  mode?: TaskMode;
  sandbox?: SandboxMode;
  model?: string;
  effort?: Effort;
  startImmediately?: boolean;
  allowLocalOnlyWithoutRemote?: boolean;
  branchName?: string;
  worktreeName?: string;
  parentOrchestrationId?: number | null;
  orchestrationAgentId?: number | null;
  agentRole?: string | null;
}

export interface RunImplementResult {
  project: Project;
  task: Task;
  initialMessage: TaskMessage;
  remoteRequired: boolean;
  started: boolean;
}

export interface ConfigureProjectRemoteResult {
  project: Project;
  baseBranch: string;
  summary: string;
}

export interface EnqueueFollowUpResult {
  task: Task;
  message: TaskMessage;
  started: boolean;
}

export class ImplementService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskStore,
    private readonly git: GitManager,
    private readonly taskService: TaskService,
    private readonly pump: TaskMessagePump,
  ) {}

  async run(input: RunImplementInput): Promise<RunImplementResult> {
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("/implement requires a non-empty message.");
    }

    let project = await this.syncProjectOrigin(input.project);
    if (project.remoteStatus === "missing" && input.allowLocalOnlyWithoutRemote) {
      project = this.projects.updateRemote(project.id, { remoteUrl: null, remoteStatus: "skipped" });
    }

    let task = this.taskService.createImplementationTask({
      project,
      prompt,
      requestedBy: input.requestedBy,
      mode: input.mode,
      sandbox: input.sandbox,
      model: input.model,
      effort: input.effort,
      parentOrchestrationId: input.parentOrchestrationId ?? null,
      orchestrationAgentId: input.orchestrationAgentId ?? null,
      agentRole: input.agentRole ?? null,
      branchName: input.branchName,
      worktreeName: input.worktreeName,
    });

    if (project.remoteStatus === "configured") {
      await this.git.pullProjectOrigin(project);
    }

    if (project.remoteStatus !== "missing") {
      task = await this.taskService.createOrRefreshWorktree(project, task, {
        branchName: input.branchName,
        worktreeName: input.worktreeName,
      });
    }

    const initialMessage = this.tasks.enqueueUserMessage({
      taskId: task.id,
      discordMessageId: null,
      discordAuthorId: input.requestedBy,
      content: prompt,
    });

    if (project.remoteStatus === "missing") {
      task = this.tasks.update(task.id, { status: "WAITING_REMOTE" });
      return { project, task, initialMessage, remoteRequired: true, started: false };
    }

    if (input.startImmediately) {
      task = await this.startTask(project, task);
      return { project, task, initialMessage, remoteRequired: false, started: true };
    }

    return { project, task, initialMessage, remoteRequired: false, started: false };
  }

  async startTask(project: Project, task: Task): Promise<Task> {
    if (!task.worktreePath || !task.taskBranch) {
      task = await this.taskService.createOrRefreshWorktree(project, task);
    }
    const updated = this.tasks.update(task.id, { status: "QUEUED", error: null });
    this.pump.enqueue(updated.id);
    return updated;
  }

  async enqueueFollowUp(input: {
    task: Task;
    content: string;
    requestedBy: string | null;
    sourceUi: ImplementSourceUi;
  }): Promise<EnqueueFollowUpResult> {
    const content = input.content.trim();
    if (!content) {
      throw new Error("Follow-up message is required.");
    }

    let task = input.task;
    if (isClosedTaskStatus(task.status)) {
      throw new Error(`Task is closed with status ${task.status}. Create a new /implement task.`);
    }
    if (task.status === "WAITING_REMOTE") {
      throw new Error("Connect the project remote before sending follow-up messages to this task.");
    }
    if (task.status === "WAITING_REVIEW" || task.status === "DONE") {
      task = this.tasks.update(task.id, { status: "QUEUED", error: null });
    }

    const message = this.tasks.enqueueUserMessage({
      taskId: task.id,
      discordMessageId: null,
      discordAuthorId: input.requestedBy ?? input.sourceUi,
      content,
    });

    if (task.status !== "PENDING_START") {
      this.pump.enqueue(task.id);
      return { task: this.tasks.getById(task.id) ?? task, message, started: true };
    }

    return { task, message, started: false };
  }

  async configureProjectRemote(project: Project, remoteUrl: string): Promise<ConfigureProjectRemoteResult> {
    const trimmed = remoteUrl.trim();
    if (!trimmed) {
      throw new Error("Git remote URL is required.");
    }
    const pulled = await this.git.setProjectOriginAndPull(project, trimmed);
    const updated = this.projects.updateRemote(project.id, { remoteUrl: trimmed, remoteStatus: "configured" });
    return {
      project: updated,
      baseBranch: pulled.baseBranch,
      summary: pulled.summary,
    };
  }

  async syncProjectOrigin(project: Project): Promise<Project> {
    const origin = await this.git.getProjectOrigin(project).catch((error) => {
      console.error("Failed to inspect project origin.", { projectId: project.id, error });
      return null;
    });

    if (origin) {
      return this.projects.updateRemote(project.id, { remoteUrl: origin, remoteStatus: "configured" });
    }
    if (project.remoteStatus === "configured") {
      return this.projects.updateRemote(project.id, { remoteUrl: null, remoteStatus: "missing" });
    }
    return project;
  }
}
