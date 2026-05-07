import type { Client, Message, TextBasedChannel } from "discord.js";
import type { TaskStore } from "../stores.js";
import type { Task } from "../types.js";
import { redactSecrets } from "../redact.js";
import { taskLabel } from "../taskLabels.js";

interface ProgressState {
  phase: string;
  lastEventType: string;
  currentCommand?: string;
  changedFiles: Set<string>;
  lastEditedAt: number;
  lastAgentPostAt: number;
}

export interface ProgressUpdate {
  phase?: string;
  lastEventType?: string;
  currentCommand?: string;
  changedFile?: string;
}

export interface ProgressExtension {
  onProgressEvent?: (task: Task, update: ProgressUpdate) => Promise<void> | void;
}

const EDIT_THROTTLE_MS = 15_000;

export class TaskProgressService {
  private readonly states = new Map<number, ProgressState>();

  constructor(
    private readonly client: Client,
    private readonly tasks: TaskStore,
    private readonly extension?: ProgressExtension,
  ) {}

  async taskStarted(task: Task): Promise<void> {
    await this.post(task, `Task ${taskLabel(task)} started\nBranch: ${task.taskBranch ?? "unknown"}`);
    await this.updateLiveStatus(task, { phase: "Running", lastEventType: "task.started" }, true);
  }

  async updateLiveStatus(task: Task, update: ProgressUpdate, immediate = false): Promise<void> {
    const state = this.stateFor(task);
    if (update.phase) state.phase = update.phase;
    if (update.lastEventType) state.lastEventType = update.lastEventType;
    if (update.currentCommand !== undefined) state.currentCommand = truncate(redactSecrets(update.currentCommand), 220);
    if (update.changedFile) state.changedFiles.add(redactSecrets(update.changedFile));
    await Promise.resolve(this.extension?.onProgressEvent?.(task, update));

    const now = Date.now();
    if (!immediate && now - state.lastEditedAt < EDIT_THROTTLE_MS) {
      return;
    }
    state.lastEditedAt = now;
    await this.editLiveMessage(task, state);
  }

  async postPlanUpdate(task: Task, text: string): Promise<void> {
    await this.updateLiveStatus(task, { phase: "Planning", lastEventType: "item.completed plan_update" }, true);
    await this.post(task, `Plan update for task ${taskLabel(task)}:\n${truncate(redactSecrets(text), 1500)}`);
  }

  async postAgentMessage(task: Task, text: string): Promise<void> {
    const state = this.stateFor(task);
    const now = Date.now();
    if (now - state.lastAgentPostAt < 30_000 || !looksUseful(text)) {
      return;
    }
    state.lastAgentPostAt = now;
    await this.post(task, truncate(redactSecrets(text), 1500));
  }

  async postError(task: Task, text: string): Promise<void> {
    await this.updateLiveStatus(task, { phase: "Error", lastEventType: "error" }, true);
    await this.post(task, `Task ${taskLabel(task)} error:\n${truncate(redactSecrets(text), 1500)}`);
  }

  async postFailure(task: Task, text: string): Promise<void> {
    await this.updateLiveStatus(task, { phase: "Failed", lastEventType: "turn.failed" }, true);
    await this.post(task, `Task ${taskLabel(task)} failed:\n${truncate(redactSecrets(text), 1500)}`);
  }

  async postCompletion(task: Task, finalSummary: string, diffStat: string, usageSummary?: string): Promise<void> {
    const changedCount = countChangedFiles(diffStat);
    await this.updateLiveStatus(task, { phase: "Complete", lastEventType: "turn.completed", currentCommand: "" }, true);
    await this.post(
      task,
      `Task ${taskLabel(task)} complete
Branch: ${task.taskBranch ?? "unknown"}
Changed files: ${changedCount}
Diff stat:
${truncate(redactSecrets(diffStat || "No diff."), 900)}
${usageSummary ? `\nUsage: ${truncate(redactSecrets(usageSummary), 300)}\n` : ""}

${truncate(redactSecrets(finalSummary), 900)}`,
    );
  }

  async postProcessFailure(task: Task, stderr: string, codexErrors: string): Promise<void> {
    await this.postFailure(
      task,
      [stderr ? `Recent stderr:\n${stderr}` : "", codexErrors ? `Recent Codex errors:\n${codexErrors}` : ""]
        .filter(Boolean)
        .join("\n\n") || "Codex process failed.",
    );
  }

  private async editLiveMessage(task: Task, state: ProgressState): Promise<void> {
    const channel = await this.getThreadChannel(task);
    if (!channel) return;
    const content = liveStatusContent(task, state);

    if (task.liveStatusMessageId && "messages" in channel) {
      try {
        const existing = await channel.messages.fetch(task.liveStatusMessageId);
        await existing.edit(content);
        return;
      } catch {
        // Fall through and create a replacement status message.
      }
    }

    const message = await channel.send(content);
    this.tasks.update(task.id, { liveStatusMessageId: message.id });
  }

  private async post(task: Task, content: string): Promise<Message | null> {
    const channel = await this.getThreadChannel(task);
    if (!channel) return null;
    return channel.send(truncate(redactSecrets(content), 1900));
  }

  private async getThreadChannel(task: Task): Promise<(TextBasedChannel & { send: (content: string) => Promise<Message> }) | null> {
    if (!task.discordThreadId) return null;
    const channel = await this.client.channels.fetch(task.discordThreadId).catch(() => null);
    return channel?.isTextBased() && "send" in channel ? (channel as TextBasedChannel & { send: (content: string) => Promise<Message> }) : null;
  }

  private stateFor(task: Task): ProgressState {
    let state = this.states.get(task.id);
    if (!state) {
      state = {
        phase: task.status,
        lastEventType: "none",
        changedFiles: new Set<string>(),
        lastEditedAt: 0,
        lastAgentPostAt: 0,
      };
      this.states.set(task.id, state);
    }
    return state;
  }
}

function liveStatusContent(task: Task, state: ProgressState): string {
  const command = state.currentCommand?.trim() || "none";
  return `Live Status
Task ID: ${taskLabel(task)}
Branch: ${task.taskBranch ?? "unknown"}
Phase: ${state.phase}
Last event: ${state.lastEventType}
Current command: ${command}
Updated: ${new Date().toLocaleTimeString()}
Changed files: ${state.changedFiles.size}`;
}

function looksUseful(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 40 || trimmed.length > 1800) return false;
  return /\b(done|complete|implemented|fixed|blocked|failed|summary|plan|next|created|updated|changed)\b/i.test(trimmed);
}

function countChangedFiles(diffStat: string): number {
  const match = /(\d+)\s+files?\s+changed/.exec(diffStat);
  if (match) return Number(match[1]);
  return diffStat.trim() ? diffStat.split("\n").filter((line) => /\|/.test(line)).length : 0;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 14)}...[truncated]`;
}
