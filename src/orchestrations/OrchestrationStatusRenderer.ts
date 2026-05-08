import { taskLabel } from "../taskLabels.js";
import type { TaskStore } from "../stores.js";
import type { Orchestration, OrchestrationAgent, OrchestrationView } from "./types.js";

export class OrchestrationStatusRenderer {
  constructor(private readonly tasks?: TaskStore) {}

  renderDashboard(view: OrchestrationView): string {
    const done = view.agents.filter((agent) => isTerminalAgent(agent.status)).length;
    const total = view.agents.length;
    const lines = [
      `Orchestration #${view.orchestration.id}`,
      `Status: ${view.orchestration.status}`,
      `Goal: ${oneLine(view.orchestration.goal, 180)}`,
      `Agents: ${done} done / ${total} total`,
      `Bounds: ${view.orchestration.minAgents}-${view.orchestration.maxAgents}`,
      `Auto-start: ${view.orchestration.autoStartChildren ? "on" : "off"}`,
    ];

    const summary = currentPlanSummary(view.orchestration);
    if (summary) {
      lines.push("", "Current plan:", summary);
    }

    if (view.agents.length > 0) {
      lines.push("", "Agents:");
      for (const agent of view.agents) {
        const task = agent.childTaskId ? this.tasks?.getById(agent.childTaskId) : null;
        const taskText = task ? taskLabel(task) : "not created";
        const threadText = agent.discordThreadUrl ?? (agent.discordThreadId ? `<#${agent.discordThreadId}>` : "no thread");
        lines.push(`- #${agent.agentIndex} ${agent.agentName}: ${agent.status.toUpperCase()} - ${taskText} - ${threadText}`);
      }
    }

    return truncate(lines.join("\n"), 1900);
  }

  renderSpawnedAgents(agents: OrchestrationAgent[]): string {
    const lines = ["Spawned Agents:"];
    for (const agent of agents) {
      const taskText = agent.childTaskId ? `Task #${agent.childTaskId}` : "Task not created";
      const thread = agent.discordThreadUrl ?? (agent.discordThreadId ? `<#${agent.discordThreadId}>` : "no thread");
      lines.push(
        `${agent.agentIndex}. Agent #${agent.agentIndex} - ${agent.agentName} - ${agent.role} - ${taskText} - ${thread} - ${
          agent.branchName ?? "no branch"
        }`,
      );
    }
    return truncate(lines.join("\n"), 1900);
  }

  renderFinalSummary(orchestration: Orchestration, agents: OrchestrationAgent[]): string {
    const lines = [`Orchestration #${orchestration.id} fleet summary`, `Status: ${orchestration.status}`, `Goal: ${orchestration.goal}`, ""];
    for (const agent of agents) {
      lines.push(
        `Agent #${agent.agentIndex} - ${agent.agentName} - ${agent.status.toUpperCase()}
Task: ${agent.childTaskId ? `#${agent.childTaskId}` : "not created"}
Thread: ${agent.discordThreadUrl ?? (agent.discordThreadId ? `<#${agent.discordThreadId}>` : "none")}
Branch: ${agent.branchName ?? "none"}
PR: ${agent.prUrl ?? "not created"}
Summary: ${oneLine(agent.completionSummary ?? "No summary captured.", 240)}
`,
      );
    }
    return truncate(lines.join("\n"), 1900);
  }
}

export function chunkDiscordMessage(value: string, max = 1900): string[] {
  if (value.length <= max) {
    return [value];
  }
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > max) {
    const split = Math.max(remaining.lastIndexOf("\n", max), Math.floor(max * 0.75));
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function currentPlanSummary(orchestration: Orchestration): string | null {
  if (!orchestration.finalPlanJson) {
    return null;
  }
  try {
    const plan = JSON.parse(orchestration.finalPlanJson) as { architectureSummary?: string; agentCount?: number };
    return truncate(`${plan.agentCount ?? "unknown"} agents - ${plan.architectureSummary ?? "No summary."}`, 500);
  } catch {
    return truncate(orchestration.finalPlanJson, 500);
  }
}

function isTerminalAgent(status: OrchestrationAgent["status"]): boolean {
  return status === "done" || status === "failed" || status === "canceled";
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 14)}...[truncated]`;
}
