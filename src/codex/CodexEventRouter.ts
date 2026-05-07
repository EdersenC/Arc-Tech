import type { TaskProgressService } from "../progress/TaskProgressService.js";
import type { TaskStore } from "../stores.js";
import type { Task } from "../types.js";
import { redactPayload, redactSecrets } from "../redact.js";
import type { CodexJsonlEvent } from "./CodexJsonlEventParser.js";

export class CodexEventRouter {
  constructor(
    private readonly tasks: TaskStore,
    private readonly progress: TaskProgressService,
  ) {}

  async route(task: Task, event: CodexJsonlEvent): Promise<void> {
    const payload = redactPayload(event.payload);
    this.tasks.addCodexEvent(task.id, event.type, event.itemType, payload);
    if (event.codexThreadId && event.type === "thread.started") {
      task = this.tasks.update(task.id, { codexThreadId: event.codexThreadId });
    }

    switch (event.type) {
      case "thread.started":
        await this.progress.updateLiveStatus(task, { phase: "Thread started", lastEventType: "thread.started" }, true);
        break;
      case "turn.started":
        task = this.tasks.update(task.id, { status: "RUNNING" });
        await this.progress.updateLiveStatus(task, { phase: "Running", lastEventType: "turn.started" }, true);
        break;
      case "item.started":
        await this.routeItemStarted(task, event);
        break;
      case "item.completed":
        await this.routeItemCompleted(task, event);
        break;
      case "turn.completed":
        task = this.tasks.update(task.id, { status: "WAITING_REVIEW" });
        await this.progress.updateLiveStatus(task, { phase: "Completing", lastEventType: "turn.completed" }, true);
        break;
      case "turn.failed":
        task = this.tasks.update(task.id, { status: "FAILED", error: event.message ?? "Codex turn failed." });
        await this.progress.postFailure(task, event.message ?? payloadText(payload));
        break;
      case "error":
        task = this.tasks.update(task.id, { status: "FAILED", error: event.message ?? "Codex error." });
        await this.progress.postError(task, event.message ?? payloadText(payload));
        break;
      case "malformed_jsonl":
        await this.progress.updateLiveStatus(task, { lastEventType: "malformed_jsonl" });
        break;
      default:
        await this.progress.updateLiveStatus(task, { lastEventType: event.itemType ? `${event.type} ${event.itemType}` : event.type });
        break;
    }
  }

  async routeStderr(task: Task, line: string): Promise<void> {
    const redacted = redactSecrets(line);
    this.tasks.addCodexEvent(task.id, "stderr", null, { message: redacted });
    if (/\b(fatal|panic|uncaught|permission denied|authentication failed)\b/i.test(redacted)) {
      await this.progress.postError(task, `Codex stderr: ${redacted}`);
    }
  }

  private async routeItemStarted(task: Task, event: CodexJsonlEvent): Promise<void> {
    if (event.itemType === "command_execution") {
      await this.progress.updateLiveStatus(task, {
        phase: "Running command",
        lastEventType: "item.started command_execution",
        currentCommand: commandText(event.payload),
      });
      return;
    }
    await this.progress.updateLiveStatus(task, { lastEventType: `item.started ${event.itemType ?? ""}`.trim() });
  }

  private async routeItemCompleted(task: Task, event: CodexJsonlEvent): Promise<void> {
    if (event.itemType === "command_execution") {
      await this.progress.updateLiveStatus(task, {
        phase: "Command complete",
        lastEventType: "item.completed command_execution",
        currentCommand: `${commandText(event.payload)} -> ${commandStatus(event.payload)}`,
      });
      return;
    }
    if (event.itemType === "file_change") {
      await this.progress.updateLiveStatus(task, {
        phase: "Editing files",
        lastEventType: "item.completed file_change",
        changedFile: fileChangePath(event.payload),
      });
      return;
    }
    if (event.itemType === "agent_message" && event.message) {
      await this.progress.updateLiveStatus(task, { lastEventType: "item.completed agent_message" });
      await this.progress.postAgentMessage(task, event.message);
      return;
    }
    if (event.itemType === "plan_update") {
      const text = event.message ?? payloadText(event.payload);
      await this.progress.postPlanUpdate(task, text);
      return;
    }
    await this.progress.updateLiveStatus(task, { lastEventType: `item.completed ${event.itemType ?? ""}`.trim() });
  }
}

function commandText(payload: Record<string, unknown>): string {
  const item = asRecord(payload.item) ?? payload;
  const command = item.command ?? item.cmd ?? item.argv;
  if (Array.isArray(command)) return command.map(String).join(" ");
  if (typeof command === "string") return command;
  if (asRecord(command)) return JSON.stringify(command);
  return "unknown command";
}

function commandStatus(payload: Record<string, unknown>): string {
  const item = asRecord(payload.item) ?? payload;
  for (const key of ["exit_code", "exitCode", "status", "result"]) {
    const value = item[key];
    if (value !== undefined) return String(value);
  }
  return "done";
}

function fileChangePath(payload: Record<string, unknown>): string {
  const item = asRecord(payload.item) ?? payload;
  for (const key of ["path", "file", "filename"]) {
    const value = item[key];
    if (typeof value === "string") return value;
  }
  return "unknown file";
}

function payloadText(payload: Record<string, unknown>): string {
  return JSON.stringify(payload).slice(0, 1500);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
