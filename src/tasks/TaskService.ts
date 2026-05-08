import type { GitManager } from "../git.js";
import type { ProjectStore, TaskStore } from "../stores.js";
import type { Effort, Project, SandboxMode, Task, TaskMode } from "../types.js";

export interface CreateImplementationTaskInput {
  project: Project;
  prompt: string;
  requestedBy: string | null;
  mode?: TaskMode;
  sandbox?: SandboxMode;
  model?: string;
  effort?: Effort;
  parentOrchestrationId?: number | null;
  orchestrationAgentId?: number | null;
  agentRole?: string | null;
  branchName?: string;
  worktreeName?: string;
  resetWorktree?: boolean;
  ensureWorktree?: boolean;
}

export class TaskService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskStore,
    private readonly git: GitManager,
  ) {}

  createImplementationTask(input: CreateImplementationTaskInput): Task {
    let task = this.tasks.create(input.project, input.prompt, input.requestedBy);
    task = this.tasks.update(task.id, {
      mode: input.mode ?? "implement",
      sandbox: input.sandbox ?? "workspace-write",
      model: input.model,
      effort: input.effort,
      parentOrchestrationId: input.parentOrchestrationId ?? null,
      orchestrationAgentId: input.orchestrationAgentId ?? null,
      agentRole: input.agentRole ?? null,
    });
    return task;
  }

  async createOrRefreshWorktree(
    project: Project,
    task: Task,
    options: { reset?: boolean; branchName?: string; worktreeName?: string } = {},
  ): Promise<Task> {
    const worktree = await this.git.createTaskWorktree(project, task, {
      reset: options.reset,
      branchName: options.branchName,
      worktreeName: options.worktreeName,
    });
    return this.tasks.update(task.id, {
      baseBranch: worktree.baseBranch,
      taskBranch: worktree.taskBranch,
      worktreePath: worktree.worktreePath,
    });
  }

  getProject(projectId: number): Project | null {
    return this.projects.getById(projectId);
  }
}
