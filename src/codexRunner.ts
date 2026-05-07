import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { CodexJsonlEventParser, type CodexJsonlEvent } from "./codex/CodexJsonlEventParser.js";
import { redactSecrets } from "./redact.js";
import type { Effort, SandboxMode, TaskMessage } from "./types.js";

export type CodexEvent = CodexJsonlEvent;

export interface CodexRunOptions {
  taskId: number;
  projectPath: string;
  worktreePath: string;
  taskBranch: string;
  prompt: string;
  sandbox: SandboxMode;
  model: string;
  effort: Effort;
  signal?: AbortSignal;
  onEvent: (event: CodexEvent) => void | Promise<void>;
  onRunnerEvent?: (event: CodexRunnerToolEvent) => void | Promise<void>;
  onStderrLine?: (line: string) => void | Promise<void>;
}

export interface CodexContinueOptions {
  taskId: number;
  projectPath: string;
  worktreePath: string;
  taskBranch: string;
  previousCodexThreadId?: string | null;
  previousSummary?: string | null;
  currentStatus: string;
  messages: TaskMessage[];
  sandbox: SandboxMode;
  model: string;
  effort: Effort;
  signal?: AbortSignal;
  onEvent: (event: CodexEvent) => void | Promise<void>;
  onRunnerEvent?: (event: CodexRunnerToolEvent) => void | Promise<void>;
  onStderrLine?: (line: string) => void | Promise<void>;
}

export interface CodexRunResult {
  finalSummary: string;
  codexThreadId?: string;
  usageSummary?: string;
  stderrTail: string[];
}

export interface CodexRunner {
  runTask(options: CodexRunOptions): Promise<CodexRunResult>;
  continueTask(options: CodexContinueOptions): Promise<CodexRunResult>;
}

export interface CodexRunnerToolEvent {
  version: 1;
  type: string;
  message?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export class CodexProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string[],
  ) {
    super(message);
    this.name = "CodexProcessError";
  }
}

export class CodexCliRunner implements CodexRunner {
  constructor(private readonly codexBin: string) {}

  async runTask(options: CodexRunOptions): Promise<CodexRunResult> {
    return this.run(options, options.prompt);
  }

  async continueTask(options: CodexContinueOptions): Promise<CodexRunResult> {
    const prompt = buildContinuePrompt(options);
    return this.run(options, prompt);
  }

  private async run(
    options: Pick<
      CodexRunOptions,
      | "projectPath"
      | "worktreePath"
      | "sandbox"
      | "model"
      | "effort"
      | "signal"
      | "onEvent"
      | "onRunnerEvent"
      | "onStderrLine"
    >,
    prompt: string,
  ): Promise<CodexRunResult> {
    const codexTempDir = await prepareCodexTempDir(options.worktreePath);
    const runnerTool = await prepareRunnerTool(codexTempDir);
    const args = [
      "exec",
      "--cd",
      options.worktreePath,
      ...workspaceWriteGitArgs(options),
      "--json",
      "--sandbox",
      options.sandbox,
      "-c",
      "approval_policy=never",
      "-c",
      `model_reasoning_effort="${options.effort}"`,
      "--model",
      options.model,
      prompt,
    ];

    return new Promise<CodexRunResult>((resolve, reject) => {
      const child = spawn(this.codexBin, args, {
        cwd: options.worktreePath,
        env: {
          ...process.env,
          NO_COLOR: "1",
          TMPDIR: codexTempDir,
          TMP: codexTempDir,
          TEMP: codexTempDir,
          XDG_RUNTIME_DIR: codexTempDir,
          CODEX_RUNNER_EVENT_FILE: runnerTool.eventFile,
          CODEX_RUNNER_TOOL_VERSION: "1",
          PATH: `${runnerTool.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          GIT_OPTIONAL_LOCKS: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderrTail: string[] = [];
      let stderrBuffer = "";
      let finalSummary = "";
      let codexThreadId: string | undefined;
      let usageSummary: string | undefined;
      let settled = false;
      const runnerOutbox = new RunnerToolOutbox(runnerTool.eventFile, (event) => options.onRunnerEvent?.(event));

      const parser = new CodexJsonlEventParser((event) => {
        if (event.message) finalSummary = event.message;
        if (event.codexThreadId) codexThreadId = event.codexThreadId;
        if (event.type === "turn.completed") usageSummary = extractUsageSummary(event.payload);
        return options.onEvent(event);
      });
      runnerOutbox.start();

      const abort = (): void => {
        if (!child.killed) child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000).unref();
      };
      options.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        parser.write(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const redacted = redactSecrets(line.trim());
          if (!redacted) continue;
          stderrTail.push(redacted);
          while (stderrTail.length > 20) stderrTail.shift();
          void Promise.resolve(options.onStderrLine?.(redacted)).catch(() => undefined);
        }
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        runnerOutbox.stop();
        reject(error);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        runnerOutbox.stop();
        void (async () => {
          if (stderrBuffer.trim()) {
            const redacted = redactSecrets(stderrBuffer.trim());
            stderrTail.push(redacted);
            await Promise.resolve(options.onStderrLine?.(redacted)).catch(() => undefined);
          }
          parser.flush();
          await runnerOutbox.drain();

          if (code !== 0) {
            reject(new CodexProcessError(`Codex exited with code ${code}.`, code, [...stderrTail]));
            return;
          }
          resolve({ finalSummary: finalSummary || "Codex completed.", codexThreadId, usageSummary, stderrTail });
        })().catch(reject);
      });
    });
  }
}

async function prepareCodexTempDir(worktreePath: string): Promise<string> {
  const dir = path.join(worktreePath, ".codex-tmp");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  return dir;
}

async function prepareRunnerTool(codexTempDir: string): Promise<{ binDir: string; eventFile: string }> {
  const binDir = path.join(codexTempDir, "bin");
  const toolPath = path.join(binDir, "codex-runner");
  const eventFile = path.join(codexTempDir, "runner-events.jsonl");
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(toolPath, RUNNER_TOOL_SCRIPT, { mode: 0o700 });
  await fs.chmod(toolPath, 0o700).catch(() => undefined);
  await fs.writeFile(eventFile, "", { mode: 0o600 });
  await fs.chmod(eventFile, 0o600).catch(() => undefined);
  return { binDir, eventFile };
}

class RunnerToolOutbox {
  private offset = 0;
  private buffer = "";
  private interval: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly eventFile: string,
    private readonly onEvent: (event: CodexRunnerToolEvent) => void | Promise<void> | undefined,
  ) {}

  start(): void {
    this.interval = setInterval(() => {
      void this.drain().catch(() => undefined);
    }, 1000);
    this.interval.unref();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainOnce();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
    }
  }

  private async drainOnce(): Promise<void> {
    const handle = await fs.open(this.eventFile, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!handle) return;

    try {
      const stat = await handle.stat();
      if (stat.size < this.offset) {
        this.offset = 0;
        this.buffer = "";
      }

      const length = Math.min(stat.size - this.offset, MAX_RUNNER_OUTBOX_READ_BYTES);
      if (length <= 0) return;

      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, this.offset);
      this.offset += bytesRead;
      this.buffer += chunk.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }

    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > MAX_RUNNER_OUTBOX_LINE_CHARS) {
      this.buffer = "";
    }
    for (const line of lines) {
      if (line.length > MAX_RUNNER_OUTBOX_LINE_CHARS) continue;
      const event = parseRunnerToolEvent(line);
      if (event) await Promise.resolve(this.onEvent(event));
    }
  }
}

const MAX_RUNNER_OUTBOX_READ_BYTES = 64 * 1024;
const MAX_RUNNER_OUTBOX_LINE_CHARS = 16 * 1024;

function parseRunnerToolEvent(line: string): CodexRunnerToolEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1 || typeof parsed.type !== "string" || !parsed.type.trim()) {
      return null;
    }

    return {
      version: 1,
      type: parsed.type.trim().slice(0, 64),
      message: typeof parsed.message === "string" ? parsed.message.trim().slice(0, 4000) : undefined,
      data: isRecord(parsed.data) ? parsed.data : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function workspaceWriteGitArgs(options: Pick<CodexRunOptions, "projectPath" | "sandbox">): string[] {
  if (options.sandbox !== "workspace-write") {
    return [];
  }
  return [
    "--add-dir",
    path.join(options.projectPath, ".git"),
    "-c",
    "sandbox_workspace_write.network_access=true",
  ];
}

function extractUsageSummary(payload: Record<string, unknown>): string | undefined {
  const usage = payload.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const parts = Object.entries(record)
    .filter(([, value]) => typeof value === "number" || typeof value === "string")
    .map(([key, value]) => `${key}: ${value}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

export function runnerBridgeInstructions(): string {
  return `Structured runner bridge:
- The command \`codex-runner\` is available on PATH during this run.
- Use \`codex-runner progress "short status"\` for live status, \`codex-runner message "text for the user"\` for a structured user-facing update, \`codex-runner plan "plan text"\` for plan updates, and \`codex-runner pr "https://github.com/owner/repo/pull/123"\` after opening or finding a PR.
- For custom app-readable events, use \`codex-runner emit <type> --message "text" --data '{"key":"value"}'\`.
- These events are supplemental; still include the final summary and PR URL in your final answer.`;
}

function buildContinuePrompt(options: CodexContinueOptions): string {
  const messages = options.messages.map((message) => `- ${message.content}`).join("\n");
  return `Continue Discord task #${options.taskId}.

Branch: ${options.taskBranch}
Current task status: ${options.currentStatus}
Previous Codex thread/session id: ${options.previousCodexThreadId ?? "none"}
Previous task summary:
${options.previousSummary ?? "No prior summary was captured."}

Queued user follow-up messages, in order:
${messages}

${runnerBridgeInstructions()}

Continue modifying the same isolated task worktree. Stay on the current task branch.

Primary completion goal:
- Finish with a committed task branch pushed to origin and a GitHub pull request opened against the task base branch.
- Include the PR URL in your final summary.
- If a PR already exists for this task branch, update/reuse it and include its URL.

Git rules:
- You should run git add, git commit, git push, and gh pr create for the current task branch when the task produced code changes.
- Do not merge to main.
- Do not checkout another branch unless you return to the current task branch before editing.
- Do not edit files in the base repo or in other task worktrees.
- If git push, gh, or network access fails, keep the local file changes and summarize the failure. The Discord orchestrator will try to commit, push, and create the PR after your run.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RUNNER_TOOL_SCRIPT = `#!/usr/bin/env node
import fs from "node:fs";

const eventFile = process.env.CODEX_RUNNER_EVENT_FILE;
const args = process.argv.slice(2);

function usage(exitCode = 0) {
  const text = [
    "Usage:",
    "  codex-runner progress <message>",
    "  codex-runner message <message>",
    "  codex-runner plan <message>",
    "  codex-runner error <message>",
    "  codex-runner pr <url> [message]",
    "  codex-runner emit <type> [--message <message>] [--data <json>]",
  ].join("\\n");
  (exitCode === 0 ? console.log : console.error)(text);
  process.exit(exitCode);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseEmit(rest) {
  const type = rest.shift();
  if (!type) usage(1);
  let message;
  let data;
  const loose = [];
  for (let i = 0; i < rest.length; i += 1) {
    const value = rest[i];
    if (value === "--message" || value === "-m") {
      message = rest[++i];
      if (message === undefined) fail("--message requires a value.");
    } else if (value === "--data" || value === "-d") {
      const raw = rest[++i];
      if (raw === undefined) fail("--data requires a JSON value.");
      try {
        data = JSON.parse(raw);
      } catch (error) {
        fail(\`--data must be valid JSON: \${error instanceof Error ? error.message : String(error)}\`);
      }
    } else {
      loose.push(value);
    }
  }
  return { type, message: (message ?? loose.join(" ")) || undefined, data };
}

function append(event) {
  if (!eventFile) fail("CODEX_RUNNER_EVENT_FILE is not set.");
  const payload = {
    version: 1,
    type: String(event.type || "").trim(),
    message: typeof event.message === "string" && event.message.trim() ? event.message.trim() : undefined,
    data: event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : undefined,
    createdAt: new Date().toISOString(),
  };
  if (!payload.type) fail("Event type is required.");
  fs.appendFileSync(eventFile, \`\${JSON.stringify(payload)}\\n\`, { encoding: "utf8" });
}

const command = args.shift();
if (!command || command === "help" || command === "--help" || command === "-h") usage(0);

if (command === "emit") {
  append(parseEmit(args));
} else if (["progress", "message", "plan", "error"].includes(command)) {
  append({ type: command, message: args.join(" ") });
} else if (command === "pr") {
  const url = args.shift();
  if (!url) usage(1);
  append({ type: "pr", message: args.join(" ") || url, data: { url } });
} else {
  fail(\`Unknown codex-runner command: \${command}\`);
}
`;
