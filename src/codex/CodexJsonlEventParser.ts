import { redactPayload } from "../redact.js";

export interface CodexJsonlEvent {
  type: string;
  itemType: string | null;
  payload: Record<string, unknown>;
  message?: string;
  codexThreadId?: string;
  malformed?: boolean;
}

export type CodexJsonlEventHandler = (event: CodexJsonlEvent) => void | Promise<void>;

export class CodexJsonlEventParser {
  private buffer = "";

  constructor(private readonly onEvent: CodexJsonlEventHandler) {}

  write(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.parseLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer);
    }
    this.buffer = "";
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const payload = redactPayload(JSON.parse(trimmed) as Record<string, unknown>);
      const event: CodexJsonlEvent = {
        type: typeof payload.type === "string" ? payload.type : "unknown",
        itemType: extractItemType(payload),
        payload,
        message: extractMessage(payload),
        codexThreadId: extractThreadId(payload),
      };
      void Promise.resolve(this.onEvent(event)).catch(() => undefined);
    } catch (error) {
      void Promise.resolve(
        this.onEvent({
          type: "malformed_jsonl",
          itemType: null,
          payload: { line: trimmed.slice(0, 1000), error: error instanceof Error ? error.message : String(error) },
          malformed: true,
        }),
      ).catch(() => undefined);
    }
  }
}

function extractItemType(payload: Record<string, unknown>): string | null {
  if (typeof payload.item_type === "string") return payload.item_type;
  const item = payload.item;
  if (isRecord(item) && typeof item.type === "string") return item.type;
  if (isRecord(item) && typeof item.item_type === "string") return item.item_type;
  return null;
}

function extractMessage(payload: Record<string, unknown>): string | undefined {
  for (const key of ["message", "summary", "text", "content"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const item = payload.item;
  if (isRecord(item)) {
    for (const key of ["message", "summary", "text", "content"]) {
      const value = item[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function extractThreadId(payload: Record<string, unknown>): string | undefined {
  for (const key of ["thread_id", "threadId", "session_id", "sessionId", "id"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const thread = payload.thread;
  if (isRecord(thread) && typeof thread.id === "string") return thread.id;
  const session = payload.session;
  if (isRecord(session) && typeof session.id === "string") return session.id;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
