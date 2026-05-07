import type { Client } from "discord.js";
import { CodexProcessError, type CodexRunner } from "./codexRunner.js";
import type { CodexEventRouter } from "./codex/CodexEventRouter.js";
import type { GitManager } from "./git.js";
import type { TaskProgressService } from "./progress/TaskProgressService.js";
import type { ProjectStore, TaskStore } from "./stores.js";
import { taskDisplayNumber, taskLabel } from "./taskLabels.js";
import type { Task, TaskMessage } from "./types.js";
import { isClosedTaskStatus, shouldStartProcessor } from "./threadRouting.js";

export class TaskMessagePump {
  private readonly activeTaskIds = new Set<number>();
  private readonly abortControllers = new Map<number, AbortController>();
  private taskUpdateListener: ((task: Task) => Promise<void> | void) | null = null;

  constructor(
    private readonly client: Client,
    private readonly projects: ProjectStore,
    private readonly tasks: TaskStore,
    private readonly git: GitManager,
    private readonly runner: CodexRunner,
    private readonly router: CodexEventRouter,
    private readonly progress: TaskProgressService,
  ) {}

  get activeTasks(): ReadonlySet<number> {
    return this.activeTaskIds;
  }

  onTaskUpdated(listener: (task: Task) => Promise<void> | void): void {
    this.taskUpdateListener = listener;
  }

  restoreQueuedWork(): void {
    for (const task of this.tasks.listTasksNeedingPump()) {
      this.enqueue(task.id);
    }
  }

  enqueue(taskId: number): void {
    if (!shouldStartProcessor(this.activeTaskIds, taskId)) {
      return;
    }
    this.activeTaskIds.add(taskId);
    void this.drainTask(taskId).finally(() => {
      this.activeTaskIds.delete(taskId);
      this.abortControllers.delete(taskId);
    });
  }

  async cancelTask(task: Task): Promise<void> {
    this.abortControllers.get(task.id)?.abort();
    this.tasks.failQueuedMessages(task.id);
    task = this.tasks.update(task.id, { status: "CANCELED", error: "Canceled from Discord task thread." });
    await this.notifyTaskUpdated(task);
    await this.progress.postFailure(task, "Task canceled. Queued work was marked failed.");
  }

  private async drainTask(taskId: number): Promise<void> {
    while (true) {
      let task = this.tasks.getById(taskId);
      if (!task || isClosedTaskStatus(task.status)) {
        return;
      }

      const queued = this.tasks.listQueuedMessages(taskId);
      if (queued.length === 0) {
        if (task.status === "QUEUED" || task.status === "RUNNING") {
          task = this.tasks.update(task.id, { status: "WAITING_REVIEW" });
          await this.notifyTaskUpdated(task);
        }
        return;
      }

      console.log("Started follow-up Codex run.", { taskId, messageIds: queued.map((message) => message.id) });
      this.tasks.updateMessagesStatus(queued.map((message) => message.id), "processing");
      task = this.tasks.update(task.id, { status: "RUNNING", error: null });
      await this.notifyTaskUpdated(task);

      const project = this.projects.getById(task.projectId);
      if (!project) {
        this.tasks.updateMessagesStatus(queued.map((message) => message.id), "failed");
        task = this.tasks.update(task.id, { status: "FAILED", error: `Project #${task.projectId} not found.` });
        await this.notifyTaskUpdated(task);
        return;
      }

      const abortController = new AbortController();
      this.abortControllers.set(task.id, abortController);
      const taskIdForRun = task.id;

      try {
        await this.progress.taskStarted(task);
        const result =
          task.finalSummary || task.codexThreadId
            ? await this.runner.continueTask({
                taskId: taskDisplayNumber(task),
                projectPath: project.repoPath,
                worktreePath: requireWorktree(task),
                taskBranch: requireBranch(task),
                previousCodexThreadId: task.codexThreadId,
                previousSummary: task.finalSummary,
                currentStatus: task.status,
                messages: queued,
                sandbox: task.sandbox,
                model: task.model,
                effort: task.effort,
                signal: abortController.signal,
                onEvent: (event) => this.routeCodexEvent(taskIdForRun, event),
                onStderrLine: (line) => this.routeStderr(taskIdForRun, line),
              })
            : await this.runner.runTask({
                taskId: taskDisplayNumber(task),
                projectPath: project.repoPath,
                worktreePath: requireWorktree(task),
                taskBranch: requireBranch(task),
                prompt: buildInitialPrompt(task, queued),
                sandbox: task.sandbox,
                model: task.model,
                effort: task.effort,
                signal: abortController.signal,
                onEvent: (event) => this.routeCodexEvent(taskIdForRun, event),
                onStderrLine: (line) => this.routeStderr(taskIdForRun, line),
              });

        if (looksLikeSandboxBlocked(result.finalSummary)) {
          throw new Error(result.finalSummary);
        }

        const diffStat = await this.git.commitTaskChanges(task, `Codex task ${taskDisplayNumber(task)} follow-up`);
        this.tasks.updateMessagesStatus(queued.map((message) => message.id), "processed");
        task = this.tasks.update(task.id, {
          status: "WAITING_REVIEW",
          codexThreadId: result.codexThreadId ?? task.codexThreadId,
          finalSummary: `${result.finalSummary}\n\nDiff stat:\n${diffStat}`,
          error: null,
        });
        await this.notifyTaskUpdated(task);
        console.log("Completed follow-up Codex run.", { taskId });
        await this.progress.postCompletion(task, result.finalSummary, diffStat, result.usageSummary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.tasks.updateMessagesStatus(queued.map((queuedMessage) => queuedMessage.id), "failed");
        task = this.tasks.update(task.id, { status: abortController.signal.aborted ? "CANCELED" : "FAILED", error: message });
        await this.notifyTaskUpdated(task);
        console.error("Failed follow-up Codex run.", { taskId, error: message });
        const codexErrors = this.tasks
          .getRecentCodexEvents(task.id, ["error", "turn.failed"], 5)
          .map((event) => event.payloadJson)
          .join("\n");
        const stderr = error instanceof CodexProcessError ? error.stderrTail.join("\n") : "";
        if (stderr || codexErrors) {
          await this.progress.postProcessFailure(task, stderr, codexErrors);
        } else {
          await this.progress.postFailure(task, message);
        }
        return;
      }
    }
  }

  private async routeCodexEvent(taskId: number, event: Parameters<CodexEventRouter["route"]>[1]): Promise<void> {
    const task = this.tasks.getById(taskId);
    if (!task) return;
    await this.router.route(task, event);
  }

  private async routeStderr(taskId: number, line: string): Promise<void> {
    const task = this.tasks.getById(taskId);
    if (!task) return;
    await this.router.routeStderr(task, line);
  }

  private async notifyTaskUpdated(task: Task): Promise<void> {
    await Promise.resolve(this.taskUpdateListener?.(task));
  }
}

function buildInitialPrompt(task: Task, messages: TaskMessage[]): string {
  const userMessages = messages.map((message) => `- ${message.content}`).join("\n");
  return `Implement Discord task ${taskLabel(task)}.

Branch: ${task.taskBranch ?? "unknown"}
Mode: ${task.mode}
Sandbox: ${task.sandbox}

Original request:
${task.prompt}

Queued user messages:
${userMessages}

${modeInstruction(task.mode)}

Modify only this isolated task worktree. Stay on the current branch. Do not merge to main.`;
}

function modeInstruction(mode: Task["mode"]): string {
  if (mode === "ask") {
    return "Answer the user's question. Do not edit files.";
  }
  if (mode === "plan_only") {
    return "Produce a clear implementation plan. Do not edit files.";
  }
  return "Implement the requested changes.";
}

function requireWorktree(task: Task): string {
  if (!task.worktreePath) {
    throw new Error(`Task ${taskLabel(task)} does not have a worktree path.`);
  }
  return task.worktreePath;
}

function requireBranch(task: Task): string {
  if (!task.taskBranch) {
    throw new Error(`Task ${taskLabel(task)} does not have a task branch.`);
  }
  return task.taskBranch;
}

function looksLikeSandboxBlocked(summary: string): boolean {
  return /sandbox failure|bubblewrap|bwrap|synthetic bubblewrap mount registry lock|permission denied|couldn'?t modify files|could not modify files/i.test(
    summary,
  );
}
