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
      "worktreePath" | "sandbox" | "model" | "effort" | "signal" | "onEvent" | "onStderrLine"
    >,
    prompt: string,
  ): Promise<CodexRunResult> {
    const codexTempDir = await prepareCodexTempDir(options.worktreePath);
    const args = [
      "exec",
      "--cd",
      options.worktreePath,
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
          ...codexEnv(),
          NO_COLOR: "1",
          TMPDIR: codexTempDir,
          TMP: codexTempDir,
          TEMP: codexTempDir,
          XDG_RUNTIME_DIR: codexTempDir,
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

      const parser = new CodexJsonlEventParser((event) => {
        if (event.message) finalSummary = event.message;
        if (event.codexThreadId) codexThreadId = event.codexThreadId;
        if (event.type === "turn.completed") usageSummary = extractUsageSummary(event.payload);
        return options.onEvent(event);
      });

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
        reject(error);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        if (stderrBuffer.trim()) {
          const redacted = redactSecrets(stderrBuffer.trim());
          stderrTail.push(redacted);
          void Promise.resolve(options.onStderrLine?.(redacted)).catch(() => undefined);
        }
        parser.flush();

        if (code !== 0) {
          reject(new CodexProcessError(`Codex exited with code ${code}.`, code, [...stderrTail]));
          return;
        }
        resolve({ finalSummary: finalSummary || "Codex completed.", codexThreadId, usageSummary, stderrTail });
      });
    });
  }
}

function codexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DISCORD_TOKEN;
  delete env.DISCORD_CLIENT_SECRET;
  delete env.DISCORD_PUBLIC_KEY;
  return env;
}

async function prepareCodexTempDir(worktreePath: string): Promise<string> {
  const dir = path.join(worktreePath, ".codex-tmp");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  return dir;
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

Continue modifying the same isolated task worktree. Stay on the current task branch.

Primary completion goal:
- Finish the requested work in this isolated task worktree.
- End with a concise summary of what changed, files changed, tests run, and known risks.

Git rules:
- Do not run git add, git commit, git push, or gh pr create.
- The TypeScript runner owns committing, pushing, and pull request creation after your run exits.
- Do not merge to main.
- Do not checkout another branch unless you return to the current task branch before editing.
- Do not edit files in the base repo or in other task worktrees.
- Leave your file changes in the current worktree for the runner to collect.`;
}
