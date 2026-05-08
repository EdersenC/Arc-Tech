import type { Client, TextBasedChannel } from "discord.js";
import type { OrchestrationAgentsRepo } from "../orchestrations/repos/OrchestrationAgentsRepo.js";
import type { OrchestrationsRepo } from "../orchestrations/repos/OrchestrationsRepo.js";
import { chunkDiscordMessage } from "../orchestrations/OrchestrationStatusRenderer.js";
import type { TaskStore } from "../stores.js";
import type { TaskMessagePump } from "../taskMessagePump.js";
import { taskLabel } from "../taskLabels.js";
import type { Task, TaskStatus } from "../types.js";
import type { PullRequestFeedbackEvent, TrackedPullRequest } from "./PullRequestFeedbackTypes.js";
import type { PullRequestFeedbackRepo } from "./PullRequestFeedbackRepo.js";
import type { GitHubPRFeedbackService } from "./GitHubPRFeedbackService.js";

export interface PullRequestFeedbackWorkerConfig {
  enabled: boolean;
  pollMs: number;
}

export class PullRequestFeedbackWorker {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly config: PullRequestFeedbackWorkerConfig,
    private readonly client: Client,
    private readonly tasks: TaskStore,
    private readonly orchestrations: OrchestrationsRepo,
    private readonly agents: OrchestrationAgentsRepo,
    private readonly feedbackRepo: PullRequestFeedbackRepo,
    private readonly feedbackService: GitHubPRFeedbackService,
    private readonly pump: TaskMessagePump,
    private readonly updateParentControlPanel: (orchestrationId: number) => Promise<void>,
  ) {}

  start(): void {
    if (!this.config.enabled || this.timer) {
      return;
    }
    console.log("PR feedback worker started.", { pollMs: this.config.pollMs });
    void this.pollOnce().catch((error) => console.error("Initial PR feedback poll failed.", error));
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => console.error("PR feedback poll failed.", error));
    }, this.config.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    if (!this.config.enabled || this.polling) {
      return;
    }
    this.polling = true;
    try {
      this.backfillTrackedPullRequests();
      for (const tracked of this.feedbackRepo.listOpen()) {
        await this.pollTrackedPullRequest(tracked);
      }
    } finally {
      this.polling = false;
    }
  }

  private backfillTrackedPullRequests(): void {
    for (const task of this.tasks.listTasksWithPullRequests()) {
      const prUrl = task.pullRequestUrl ?? task.prUrl;
      if (!prUrl) {
        continue;
      }
      const identity = this.feedbackService.parsePrUrl(prUrl);
      if (!identity) {
        continue;
      }
      this.feedbackRepo.upsertTrackedForTask(task, identity, prUrl);
    }
  }

  private async pollTrackedPullRequest(tracked: TrackedPullRequest): Promise<void> {
    const task = this.tasks.getById(tracked.taskId);
    if (!task || isTaskClosedForFeedback(task.status)) {
      return;
    }

    try {
      const snapshot = await this.feedbackService.fetchFeedback(tracked);
      this.feedbackRepo.markPolled(tracked.id);
      if (snapshot.state !== "open") {
        this.feedbackRepo.markState(tracked.id, snapshot.state);
        return;
      }

      const newEvents = snapshot.feedback
        .map((feedback) => this.feedbackRepo.createFeedbackEvent(tracked, feedback, null))
        .filter((event): event is PullRequestFeedbackEvent => event !== null);
      if (newEvents.length === 0) {
        return;
      }

      const taskMessage = this.tasks.enqueueUserMessage({
        taskId: task.id,
        discordMessageId: null,
        discordAuthorId: null,
        content: buildFeedbackPrompt(task, tracked, newEvents),
      });
      this.feedbackRepo.markEventsDelivered(newEvents.map((event) => event.id), taskMessage.id);
      this.tasks.addCodexEvent(task.id, "pr_feedback.queued", "pull_request_feedback", {
        prUrl: tracked.prUrl,
        feedbackItems: newEvents.length,
        eventIds: newEvents.map((event) => event.id),
      });

      let updatedTask = task;
      if (task.status !== "QUEUED" && task.status !== "RUNNING") {
        updatedTask = this.tasks.update(task.id, { status: "QUEUED", error: null });
      }
      await this.markOrchestrationActive(updatedTask);
      this.pump.enqueue(updatedTask.id);
      await this.reactToFeedback(tracked, newEvents);
      await this.postVisibilityUpdates(updatedTask, tracked, newEvents);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.feedbackRepo.markError(tracked.id, message);
      console.error("Failed to poll PR feedback.", {
        taskId: tracked.taskId,
        prUrl: tracked.prUrl,
        error: message,
      });
    }
  }

  private async reactToFeedback(tracked: TrackedPullRequest, events: PullRequestFeedbackEvent[]): Promise<void> {
    for (const event of events) {
      try {
        const status = await this.feedbackService.reactToFeedback(tracked, event, "eyes");
        this.feedbackRepo.markReaction(event.id, status);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.feedbackRepo.markReaction(event.id, "failed", message);
        console.warn("Failed to react to PR feedback comment.", {
          taskId: tracked.taskId,
          prUrl: tracked.prUrl,
          externalId: event.externalId,
          error: message,
        });
      }
    }
  }

  private async markOrchestrationActive(task: Task): Promise<void> {
    if (!task.parentOrchestrationId || !task.orchestrationAgentId) {
      return;
    }
    const agent = this.agents.findByChildTaskId(task.id);
    if (agent && agent.status !== "queued" && agent.status !== "running") {
      this.agents.updateStatus(agent.id, "queued");
    }
    const orchestration = this.orchestrations.findById(task.parentOrchestrationId);
    if (
      orchestration &&
      orchestration.status !== "CANCELED" &&
      orchestration.status !== "FAILED" &&
      orchestration.status !== "LAUNCHING_AGENTS"
    ) {
      this.orchestrations.updateStatus(orchestration.id, "RUNNING_AGENTS");
      await this.updateParentControlPanel(orchestration.id);
    }
  }

  private async postVisibilityUpdates(task: Task, tracked: TrackedPullRequest, events: PullRequestFeedbackEvent[]): Promise<void> {
    const summary = `New PR feedback queued for ${taskLabel(task)}
PR: ${tracked.prUrl}
Feedback items: ${events.length}
Agent will run automatically.`;
    await this.postToThread(task.discordThreadId, summary);

    if (task.parentOrchestrationId) {
      const orchestration = this.orchestrations.findById(task.parentOrchestrationId);
      await this.postToThread(orchestration?.discordThreadId ?? null, summary);
    }
  }

  private async postToThread(threadId: string | null, content: string): Promise<void> {
    if (!threadId) return;
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    if (!channel?.isTextBased() || !("send" in channel)) return;
    const thread = channel as TextBasedChannel & { send: (content: string) => Promise<unknown> };
    for (const chunk of chunkDiscordMessage(content)) {
      await thread.send(chunk);
    }
  }
}

function buildFeedbackPrompt(task: Task, tracked: TrackedPullRequest, events: PullRequestFeedbackEvent[]): string {
  return `PR feedback was left for ${taskLabel(task)}.

PR:
${tracked.prUrl}

Branch:
${task.taskBranch ?? tracked.branchName ?? "unknown"}

Feedback:
${events.map(formatEvent).join("\n\n")}

Instructions:
- Address only the reported PR feedback.
- Stay in this task worktree and branch.
- Avoid unrelated refactors.
- Do not merge the branch.
- Run relevant tests if available.
- Do not run git add, git commit, git push, or gh pr create.
- The TypeScript runner owns committing, pushing, and pull request updates after your run exits.
- End with a concise summary of what changed, files changed, tests run, known risks, branch, PR URL, and PR title.
- Include a line exactly like: PR title: <short descriptive title>`;
}

function formatEvent(event: PullRequestFeedbackEvent): string {
  const location = event.path ? `\nLocation: ${event.path}${event.line ? `:${event.line}` : ""}` : "";
  const url = event.htmlUrl ? `\nURL: ${event.htmlUrl}` : "";
  const state = event.reviewState ? `\nReview state: ${event.reviewState}` : "";
  return `- ${event.kind} from ${event.author ?? "unknown"}${state}${location}${url}
${event.body}`;
}

function isTaskClosedForFeedback(status: TaskStatus): boolean {
  return status === "ABANDONED" || status === "CANCELED" || status === "FAILED" || status === "MERGED";
}
