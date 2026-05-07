import type { Client } from "discord.js";
import { CodexProcessError, runnerBridgeInstructions, type CodexRunner, type CodexRunnerToolEvent } from "./codexRunner.js";
import type { CodexEventRouter } from "./codex/CodexEventRouter.js";
import type { GitManager } from "./git.js";
import type { TaskProgressService } from "./progress/TaskProgressService.js";
import { redactPayload } from "./redact.js";
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
                onRunnerEvent: (event) => this.routeRunnerToolEvent(taskIdForRun, event),
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
                onRunnerEvent: (event) => this.routeRunnerToolEvent(taskIdForRun, event),
                onStderrLine: (line) => this.routeStderr(taskIdForRun, line),
              });

        if (looksLikeSandboxBlocked(result.finalSummary)) {
          throw new Error(result.finalSummary);
        }

        const diffStat = await this.git.commitTaskChanges(task, `Codex task ${taskDisplayNumber(task)} follow-up`);
        const pullRequestUrl =
          (await this.createPullRequestIfPossible(task, result.finalSummary, diffStat)) ??
          this.tasks.getById(task.id)?.pullRequestUrl ??
          task.pullRequestUrl;
        const completionSummary = buildCompletionSummary(result.finalSummary, pullRequestUrl);
        this.tasks.updateMessagesStatus(queued.map((message) => message.id), "processed");
        task = this.tasks.update(task.id, {
          status: "WAITING_REVIEW",
          codexThreadId: result.codexThreadId ?? task.codexThreadId,
          pullRequestUrl,
          finalSummary: `${completionSummary}\n\nDiff stat:\n${diffStat}`,
          error: null,
        });
        await this.notifyTaskUpdated(task);
        console.log("Completed follow-up Codex run.", { taskId });
        await this.progress.postCompletion(task, completionSummary, diffStat, result.usageSummary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const codexErrors = this.tasks
          .getRecentCodexEvents(task.id, ["error", "turn.failed"], 5)
          .map((event) => event.payloadJson)
          .join("\n");
        const stderr = error instanceof CodexProcessError ? error.stderrTail.join("\n") : "";

        if (!abortController.signal.aborted && looksLikeGitMetadataBlocked([message, stderr, codexErrors].join("\n"))) {
          try {
            const diffStat = await this.git.commitTaskChanges(task, `Codex task ${taskDisplayNumber(task)} follow-up`);
            if (diffStat !== "No file changes.") {
              const recoverySummary =
                "Codex hit a sandboxed Git metadata write while trying to commit or push, but the orchestrator committed the file changes outside the sandbox.";
              const pullRequestUrl = await this.createPullRequestIfPossible(task, recoverySummary, diffStat);
              const completionSummary = buildCompletionSummary(recoverySummary, pullRequestUrl);
              this.tasks.updateMessagesStatus(queued.map((queuedMessage) => queuedMessage.id), "processed");
              task = this.tasks.update(task.id, {
                status: "WAITING_REVIEW",
                pullRequestUrl,
                finalSummary: `${completionSummary}\n\nDiff stat:\n${diffStat}`,
                error: null,
              });
              await this.notifyTaskUpdated(task);
              await this.progress.postCompletion(task, completionSummary, diffStat);
              return;
            }
          } catch (commitError) {
            console.error("Failed to recover changes after git metadata sandbox error.", {
              taskId,
              error: commitError instanceof Error ? commitError.message : String(commitError),
            });
          }
        }

        this.tasks.updateMessagesStatus(queued.map((queuedMessage) => queuedMessage.id), "failed");
        task = this.tasks.update(task.id, { status: abortController.signal.aborted ? "CANCELED" : "FAILED", error: message });
        await this.notifyTaskUpdated(task);
        console.error("Failed follow-up Codex run.", { taskId, error: message });
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

  private async routeRunnerToolEvent(taskId: number, event: CodexRunnerToolEvent): Promise<void> {
    let task = this.tasks.getById(taskId);
    if (!task) return;

    this.tasks.addCodexEvent(task.id, `runner_tool.${event.type}`, null, redactPayload(event));
    const message = event.message ?? runnerEventText(event);
    const lastEventType = `runner_tool.${event.type}`;

    if (event.type === "progress") {
      await this.progress.updateLiveStatus(task, { phase: "Agent update", lastEventType, currentCommand: message });
      return;
    }
    if (event.type === "message") {
      await this.progress.postRunnerMessage(task, message);
      return;
    }
    if (event.type === "plan") {
      await this.progress.postPlanUpdate(task, message);
      return;
    }
    if (event.type === "error") {
      await this.progress.postError(task, message);
      return;
    }
    if (event.type === "pr") {
      const url = extractRunnerPrUrl(event);
      if (url) {
        task = this.tasks.update(task.id, { pullRequestUrl: url });
      }
      await this.progress.updateLiveStatus(task, { phase: "Pull request reported", lastEventType, currentCommand: url ?? message }, true);
      return;
    }

    await this.progress.updateLiveStatus(task, { lastEventType, currentCommand: message });
  }

  private async notifyTaskUpdated(task: Task): Promise<void> {
    await Promise.resolve(this.taskUpdateListener?.(task));
  }

  private async createPullRequestIfPossible(task: Task, finalSummary: string, diffStat: string): Promise<string | null> {
    if (diffStat === "No file changes.") {
      return null;
    }
    const project = this.projects.getById(task.projectId);
    if (!project || project.remoteStatus !== "configured") {
      return null;
    }

    try {
      return await this.git.createTaskPullRequest(
        task,
        `Codex task ${taskDisplayNumber(task)}: ${oneLine(task.prompt, 72)}`,
        prBody(task, finalSummary, diffStat),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to create pull request.", { taskId: task.id, error: message });
      await this.progress.postError(task, `Task changes were committed locally, but PR creation failed:\n${message}`);
      return null;
    }
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

${runnerBridgeInstructions()}

Modify only this isolated task worktree. Stay on the current task branch.

Primary completion goal:
- Finish with a committed task branch pushed to origin and a GitHub pull request opened against ${task.baseBranch ?? "main"}.
- Include the PR URL in your final summary.
- If a PR already exists for this task branch, update/reuse it and include its URL.

Git rules:
- You should run git add, git commit, git push, and gh pr create for the current task branch when the task produced code changes.
- Do not merge to main.
- Do not checkout another branch unless you return to the current task branch before editing.
- Do not edit files in the base repo or in other task worktrees.
- If git push, gh, or network access fails, keep the local file changes and summarize the failure. The Discord orchestrator will try to commit, push, and create the PR after your run.`;
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

function looksLikeGitMetadataBlocked(output: string): boolean {
  return /(\.git\/worktrees|index\.lock|Unable to create.*lock|read-only file system|git metadata)/i.test(output);
}

function runnerEventText(event: CodexRunnerToolEvent): string {
  return JSON.stringify({ type: event.type, data: event.data }).slice(0, 1500);
}

function extractRunnerPrUrl(event: CodexRunnerToolEvent): string | null {
  const fromData = event.data?.url;
  if (typeof fromData === "string") {
    const url = normalizePullRequestUrl(fromData);
    if (url && isPullRequestUrl(url)) return url;
  }
  const match = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.exec(event.message ?? "");
  if (!match) return null;
  const url = normalizePullRequestUrl(match[0]);
  return url && isPullRequestUrl(url) ? url : null;
}

function isPullRequestUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/i.test(value.trim());
}

function normalizePullRequestUrl(value: string): string | null {
  const url = value.trim().replace(/[),.;:!?]+$/g, "");
  return url ? url : null;
}

function prBody(task: Task, finalSummary: string, diffStat: string): string {
  const agentNotes = sanitizeAgentSummary(finalSummary);
  return `## Orchestrator Result
- Branch: ${task.taskBranch ?? "unknown"}
- Status: The Discord Codex Runner pushed this task branch and created or updated this pull request after Codex completed.

## Codex Notes
${agentNotes || "Codex completed this task."}

## Task
${task.prompt}

## Diff stat
\`\`\`
${diffStat}
\`\`\`

Generated by Discord Codex Runner for task ${taskLabel(task)}.`;
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function buildCompletionSummary(agentSummary: string, pullRequestUrl: string | null): string {
  if (!pullRequestUrl) {
    return agentSummary;
  }

  const agentNotes = sanitizeAgentSummary(agentSummary);
  return [
    `Orchestrator result:
- Task branch committed/pushed and pull request is ready: ${pullRequestUrl}`,
    agentNotes ? `Codex notes:\n${agentNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function sanitizeAgentSummary(summary: string): string {
  let text = summary.trim();
  text = text.replace(/(?:^|\n)Commit\/push\/PR flow status:\s*[\s\S]*?(?=\n(?:Task|Diff stat|Generated by|##|$))/i, "\n");
  text = text.replace(/(?:^|\n)Result:\s*[\s\S]*?(?=\n(?:Task|Diff stat|Generated by|##|$))/i, "\n");

  const lines = text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^(no commit created\.?|no push performed\.?|no pr url to provide yet\.?|no pr created\.?)$/i.test(trimmed)) return false;
      if (/^if you want,?\s+i can retry.*commit.*push.*pr/i.test(trimmed)) return false;
      if (/could not .*git write|git add\/commit failed|unable to create .*index\.lock|read-only file system/i.test(trimmed)) return false;
      return true;
    })
    .join("\n");

  return lines.replace(/\n{3,}/g, "\n\n").trim();
}
