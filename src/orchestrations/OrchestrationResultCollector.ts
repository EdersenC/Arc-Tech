import type { Client, TextBasedChannel } from "discord.js";
import type { TaskStore } from "../stores.js";
import { taskLabel } from "../taskLabels.js";
import type { Task } from "../types.js";
import { chunkDiscordMessage, OrchestrationStatusRenderer } from "./OrchestrationStatusRenderer.js";
import type { OrchestrationAgentsRepo } from "./repos/OrchestrationAgentsRepo.js";
import type { OrchestrationsRepo } from "./repos/OrchestrationsRepo.js";
import type { OrchestrationAgentStatus } from "./types.js";

export class OrchestrationResultCollector {
  private readonly renderer: OrchestrationStatusRenderer;

  constructor(
    private readonly client: Client,
    private readonly orchestrations: OrchestrationsRepo,
    private readonly agents: OrchestrationAgentsRepo,
    private readonly tasks: TaskStore,
    private readonly updateParentControlPanel: (orchestrationId: number) => Promise<void>,
  ) {
    this.renderer = new OrchestrationStatusRenderer(this.tasks);
  }

  async handleTaskUpdated(task: Task): Promise<void> {
    if (!task.parentOrchestrationId || !task.orchestrationAgentId) {
      return;
    }
    const agent = this.agents.findByChildTaskId(task.id);
    if (!agent) {
      return;
    }
    const nextStatus = statusForTask(task);
    if (!nextStatus) {
      const activeStatus = activeStatusForTask(task);
      if (activeStatus && agent.status !== activeStatus) {
        this.agents.updateStatus(agent.id, activeStatus);
        await this.updateParentControlPanel(task.parentOrchestrationId);
      }
      return;
    }
    if (agent.status === nextStatus) {
      return;
    }
    const updatedAgent = this.agents.updateCompletion(agent.id, {
      status: nextStatus,
      prUrl: task.pullRequestUrl ?? task.prUrl,
      completionSummary: task.completionSummary ?? task.finalSummary ?? task.error ?? null,
    });
    await this.postCompletionReport(task, updatedAgent);
    await this.updateParentControlPanel(task.parentOrchestrationId);
    await this.maybeFinalizeOrchestration(task.parentOrchestrationId);
  }

  private async postCompletionReport(task: Task, agent: ReturnType<OrchestrationAgentsRepo["findByChildTaskId"]>): Promise<void> {
    if (!agent) return;
    const orchestration = this.orchestrations.findById(agent.orchestrationId);
    if (!orchestration) return;
    const thread = await this.parentThread(orchestration.discordThreadId);
    if (!thread) return;
    const report = `Agent #${agent.agentIndex} - ${agent.agentName} completed

Task: ${taskLabel(task)}
Thread: ${task.discordThreadUrl ?? (task.discordThreadId ? `<#${task.discordThreadId}>` : "unknown")}
Branch: ${task.taskBranch ?? agent.branchName ?? "unknown"}
PR: ${task.pullRequestUrl ?? task.prUrl ?? "not created"}
Summary:
${truncate(task.completionSummary ?? task.finalSummary ?? task.error ?? "No completion summary captured.", 900)}

Changed files:
${changedFilesSummary(task.finalSummary)}

Tests:
unknown`;
    for (const chunk of chunkDiscordMessage(report)) {
      await thread.send(chunk);
    }
  }

  private async maybeFinalizeOrchestration(orchestrationId: number): Promise<void> {
    const orchestration = this.orchestrations.findById(orchestrationId);
    if (!orchestration || orchestration.status === "COMPLETED" || orchestration.status === "CANCELED") {
      return;
    }
    const agents = this.agents.listByOrchestrationId(orchestrationId);
    if (agents.length === 0 || agents.some((agent) => !isTerminal(agent.status))) {
      return;
    }
    this.orchestrations.updateStatus(orchestrationId, "WAITING_REVIEW");
    const refreshed = this.orchestrations.findById(orchestrationId) ?? orchestration;
    const summary = this.renderer.renderFinalSummary(refreshed, agents);
    const thread = await this.parentThread(orchestration.discordThreadId);
    if (thread) {
      for (const chunk of chunkDiscordMessage(summary)) {
        await thread.send(chunk);
      }
    }
    await this.updateParentControlPanel(orchestrationId);
  }

  private async parentThread(threadId: string | null): Promise<(TextBasedChannel & { send: (content: string) => Promise<unknown> }) | null> {
    if (!threadId) return null;
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    return channel?.isTextBased() && "send" in channel ? (channel as TextBasedChannel & { send: (content: string) => Promise<unknown> }) : null;
  }
}

function statusForTask(task: Task): OrchestrationAgentStatus | null {
  if (task.status === "WAITING_REVIEW" || task.status === "DONE" || task.status === "MERGED") {
    return "done";
  }
  if (task.status === "FAILED" || task.status === "ABANDONED") {
    return "failed";
  }
  if (task.status === "CANCELED") {
    return "canceled";
  }
  return null;
}

function activeStatusForTask(task: Task): OrchestrationAgentStatus | null {
  if (task.status === "QUEUED") {
    return "queued";
  }
  if (task.status === "RUNNING") {
    return "running";
  }
  return null;
}

function isTerminal(status: OrchestrationAgentStatus): boolean {
  return status === "done" || status === "failed" || status === "canceled";
}

function changedFilesSummary(summary: string | null): string {
  if (!summary) {
    return "unknown";
  }
  const match = /(\d+)\s+files?\s+changed/i.exec(summary);
  return match ? `${match[1]} files changed` : "unknown";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 14)}...[truncated]`;
}
