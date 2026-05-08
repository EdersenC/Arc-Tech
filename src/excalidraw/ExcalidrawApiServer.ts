import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { PullRequestFeedbackRepo } from "../github/PullRequestFeedbackRepo.js";
import type { ProjectStore, TaskStore } from "../stores.js";
import type { ImplementService } from "../tasks/ImplementService.js";
import type { Project, Task } from "../types.js";
import { ExcalidrawCardsRepo } from "./ExcalidrawCardsRepo.js";
import { buildTaskProgress } from "./taskProgress.js";
import {
  mapTaskStatus,
  oneLine,
  taskCardLabelWithProgress,
  taskCardSize,
  taskTitle,
  type ExcalidrawCard,
  type ExcalidrawTaskProgress,
  type ExcalidrawTaskView,
} from "./types.js";

interface ApiDeps {
  config: AppConfig;
  projects: ProjectStore;
  tasks: TaskStore;
  implementService: ImplementService;
  cards: ExcalidrawCardsRepo;
  feedback?: PullRequestFeedbackRepo;
}

type JsonRecord = Record<string, unknown>;

interface ExcalidrawProjectView {
  projectId: number;
  projectName: string;
  repoPath: string;
  worktreesPath: string;
  remoteStatus: Project["remoteStatus"];
  remoteUrl: string | null;
  githubPrEnabled: boolean;
  githubPrFeedbackEnabled: boolean;
  githubBaseBranch: string;
  githubRemote: string;
  prReady: boolean;
  blockers: string[];
}

const STATIC_ROOT = path.resolve(process.cwd(), "dist/web");

export class ExcalidrawApiServer {
  private readonly server = http.createServer((req, res) => {
    void this.route(req, res).catch((error) => {
      const status = isClientError(error) ? 400 : 500;
      if (status >= 500) {
        console.error("Excalidraw API error:", error);
      } else {
        console.warn("Excalidraw API rejected request:", error instanceof Error ? error.message : String(error));
      }
      this.sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  constructor(private readonly deps: ApiDeps) {}

  listen(): void {
    this.server.listen(this.deps.config.excalidrawPort, this.deps.config.excalidrawHost, () => {
      console.log(
        `Excalidraw API listening on http://${this.deps.config.excalidrawHost}:${this.deps.config.excalidrawPort}`,
      );
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/api/health" && req.method === "GET") {
      this.sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/implement" && req.method === "POST") {
      await this.handleImplement(req, res);
      return;
    }
    if (url.pathname === "/api/excalidraw/project" && req.method === "GET") {
      await this.handleGetProject(res);
      return;
    }
    if (url.pathname === "/api/excalidraw/project/remote" && req.method === "POST") {
      await this.handleSetProjectRemote(req, res);
      return;
    }
    if (url.pathname === "/api/tasks" && req.method === "GET") {
      await this.handleListTasks(url, res);
      return;
    }
    const taskMatch = /^\/api\/tasks\/(\d+)$/.exec(url.pathname);
    if (taskMatch && req.method === "GET") {
      await this.handleGetTask(Number(taskMatch[1]), res);
      return;
    }
    if (url.pathname === "/api/excalidraw/cards" && req.method === "GET") {
      this.sendJson(res, 200, { cards: this.hydrateCards(this.deps.cards.listRecent(limitParam(url))) });
      return;
    }
    if (url.pathname === "/api/excalidraw/cards" && req.method === "POST") {
      await this.handleCreatePlanCard(req, res);
      return;
    }
    const cardMatch = /^\/api\/excalidraw\/cards\/([^/]+)$/.exec(url.pathname);
    if (cardMatch && req.method === "PATCH") {
      await this.handleUpdateCard(decodeURIComponent(cardMatch[1]), req, res);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await this.serveStatic(url.pathname, res);
      return;
    }

    this.sendJson(res, 404, { error: "Not found." });
  }

  private async handleImplement(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const message = stringField(body, "message").trim();
    const command = parseImplementCommand(message);
    const mode = stringField(body, "mode", "agent");
    const source = stringField(body, "source", "excalidraw");
    if (source !== "excalidraw") {
      this.sendJson(res, 400, { error: "Only source=excalidraw is supported by this API." });
      return;
    }

    if (mode === "plan_card_only" || mode === "plan") {
      await this.createPlanCardResponse(command, body, res);
      return;
    }

    if (mode !== "agent" && mode !== "direct_agent") {
      this.sendJson(res, 400, { error: "mode must be agent or plan_card_only." });
      return;
    }

    const project = await this.getSyncedExcalidrawProject();
    const projectView = this.projectView(project);
    if (!projectView.prReady) {
      this.sendJson(res, 409, {
        code: projectView.githubPrEnabled ? "REMOTE_REQUIRED" : "PR_DISABLED",
        error: projectView.blockers.join(" "),
        project: projectView,
      });
      return;
    }

    const result = await this.deps.implementService.run({
      project,
      prompt: command.prompt,
      requestedBy: "excalidraw",
      sourceUi: "excalidraw",
      startImmediately: true,
      allowLocalOnlyWithoutRemote: false,
    });
    const card = this.deps.cards.createForTask(result.task, {
      command: command.original,
      x: numberField(body, "x") ?? nextCardX(result.task.id),
      y: numberField(body, "y") ?? nextCardY(result.task.id),
    });
    this.sendJson(res, 201, {
      taskId: String(result.task.id),
      status: mapTaskStatus(result.task.status),
      rawStatus: result.task.status,
      title: taskTitle(result.task),
      branch: result.task.taskBranch,
      card,
    });
  }

  private async handleGetProject(res: ServerResponse): Promise<void> {
    const project = await this.getSyncedExcalidrawProject();
    this.sendJson(res, 200, { project: this.projectView(project) });
  }

  private async handleSetProjectRemote(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const remoteUrl = stringField(body, "remoteUrl").trim();
    if (!looksLikeGitRemote(remoteUrl)) {
      this.sendJson(res, 400, { error: "remoteUrl must be a Git remote URL, like https://github.com/owner/repo.git." });
      return;
    }

    const project = this.getExcalidrawProject();
    const result = await this.deps.implementService.configureProjectRemote(project, remoteUrl);
    this.sendJson(res, 200, {
      project: this.projectView(result.project),
      baseBranch: result.baseBranch,
      summary: result.summary,
    });
  }

  private async handleCreatePlanCard(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const message = stringField(body, "message").trim();
    const command = parseImplementCommand(message);
    await this.createPlanCardResponse(command, body, res);
  }

  private async createPlanCardResponse(
    command: { original: string; prompt: string },
    body: JsonRecord,
    res: ServerResponse,
  ): Promise<void> {
    const project = this.getExcalidrawProject();
    const title = `Plan Card - ${oneLine(command.prompt, 54)}`;
    const label = [`Plan Card`, `Status: planned`, `Command: ${oneLine(command.prompt, 110)}`].join("\n");
    const size = taskCardSize(label);
    const card = this.deps.cards.createPlanCard({
      projectId: project.id,
      command: command.original,
      title,
      label,
      x: numberField(body, "x") ?? nextCardX(Date.now()),
      y: numberField(body, "y") ?? nextCardY(Date.now()),
      width: numberField(body, "width") ?? size.width,
      height: numberField(body, "height") ?? size.height,
    });
    this.sendJson(res, 201, {
      taskId: null,
      status: "planned",
      rawStatus: "PLAN_CARD_ONLY",
      title,
      branch: null,
      card,
    });
  }

  private async handleListTasks(url: URL, res: ServerResponse): Promise<void> {
    const project = this.getExcalidrawProject();
    const tasks = this.deps.tasks.listByProject(project.id, limitParam(url)).map((task) => this.taskView(task));
    const cards = this.hydrateCards(this.deps.cards.listRecent(limitParam(url)));
    this.sendJson(res, 200, { tasks, cards });
  }

  private async handleGetTask(taskId: number, res: ServerResponse): Promise<void> {
    const task = this.deps.tasks.getById(taskId);
    if (!task) {
      this.sendJson(res, 404, { error: `Task ${taskId} not found.` });
      return;
    }
    this.sendJson(res, 200, this.taskView(task));
  }

  private async handleUpdateCard(cardId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const card = this.deps.cards.updatePosition(cardId, {
      x: numberField(body, "x"),
      y: numberField(body, "y"),
      width: numberField(body, "width"),
      height: numberField(body, "height"),
    });
    if (!card) {
      this.sendJson(res, 404, { error: `Card ${cardId} not found.` });
      return;
    }
    this.sendJson(res, 200, { card: this.hydrateCard(card) });
  }

  private getExcalidrawProject(): Project {
    return this.deps.projects.getOrCreate({
      guildId: this.deps.config.excalidrawProjectGuildId,
      channelId: this.deps.config.excalidrawProjectChannelId,
      channelName: this.deps.config.excalidrawProjectName,
    });
  }

  private async getSyncedExcalidrawProject(): Promise<Project> {
    return this.deps.implementService.syncProjectOrigin(this.getExcalidrawProject());
  }

  private projectView(project: Project): ExcalidrawProjectView {
    const blockers = projectBlockers(project, this.deps.config);
    return {
      projectId: project.id,
      projectName: project.projectName,
      repoPath: project.repoPath,
      worktreesPath: project.worktreesPath,
      remoteStatus: project.remoteStatus,
      remoteUrl: project.remoteUrl,
      githubPrEnabled: this.deps.config.githubPrEnabled,
      githubPrFeedbackEnabled: this.deps.config.githubPrFeedbackEnabled,
      githubBaseBranch: this.deps.config.githubBaseBranch,
      githubRemote: this.deps.config.githubRemote,
      prReady: blockers.length === 0,
      blockers,
    };
  }

  private taskView(task: Task): ExcalidrawTaskView {
    const storedCard = this.deps.cards.findByTaskId(task.id);
    const progress = this.taskProgress(task);
    const card = storedCard ? cardViewForTask(storedCard, task, progress) : null;
    return {
      taskId: String(task.id),
      numericTaskId: task.id,
      status: mapTaskStatus(task.status),
      rawStatus: task.status,
      title: taskTitle(task),
      branch: task.taskBranch,
      prompt: task.prompt,
      progress,
      card,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private hydrateCards(cards: ExcalidrawCard[]): ExcalidrawCard[] {
    return cards.map((card) => this.hydrateCard(card));
  }

  private hydrateCard(card: ExcalidrawCard): ExcalidrawCard {
    if (!card.taskId) return card;
    const task = this.deps.tasks.getById(card.taskId);
    if (!task) return card;
    return cardViewForTask(card, task, this.taskProgress(task));
  }

  private taskProgress(task: Task): ExcalidrawTaskProgress {
    return buildTaskProgress(
      task,
      this.deps.tasks.listRecentCodexActivity(task.id, 12),
      this.deps.tasks.getTaskMessageStatusCounts(task.id),
      this.deps.feedback?.getTaskFeedbackSummary(task.id) ?? null,
    );
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const fullPath = path.resolve(STATIC_ROOT, relative);
    if (!fullPath.startsWith(STATIC_ROOT)) {
      this.sendJson(res, 403, { error: "Forbidden." });
      return;
    }

    try {
      const content = await fs.readFile(fullPath);
      res.writeHead(200, { "content-type": contentType(fullPath) }).end(content);
    } catch {
      if (pathname !== "/") {
        await this.serveStatic("/", res);
        return;
      }
      this.sendJson(res, 404, { error: "Web UI build not found. Run npm run build or use npm run excalidraw." });
    }
  }

  private applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = allowedCorsOrigin(req.headers.origin, this.deps.config.excalidrawCorsOrigin);
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  }
}

async function readJson(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as JsonRecord;
}

function parseImplementCommand(message: string): { original: string; prompt: string } {
  if (!message) {
    throw new Error("/implement requires a non-empty message.");
  }
  const match = /^\/implement(?:\s+([\s\S]+))?$/i.exec(message);
  if (!match) {
    throw new Error("Use /implement <message>.");
  }
  const prompt = (match[1] ?? "").trim();
  if (!prompt) {
    throw new Error("/implement requires a non-empty message.");
  }
  return { original: `/implement ${prompt}`, prompt };
}

function stringField(body: JsonRecord, key: string, defaultValue = ""): string {
  const value = body[key];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function numberField(body: JsonRecord, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function limitParam(url: URL): number {
  const raw = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isFinite(raw)) return 50;
  return Math.max(1, Math.min(100, Math.floor(raw)));
}

function nextCardX(seed: number): number {
  return 80 + (seed % 4) * 390;
}

function nextCardY(seed: number): number {
  return 80 + (Math.floor(seed / 4) % 5) * 220;
}

function contentType(fullPath: string): string {
  if (fullPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (fullPath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (fullPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (fullPath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function cardViewForTask(card: ExcalidrawCard, task: Task, progress: ExcalidrawTaskProgress): ExcalidrawCard {
  const label = taskCardLabelWithProgress(task, progress);
  const size = taskCardSize(label, card);
  return {
    ...card,
    title: taskTitle(task),
    label,
    status: mapTaskStatus(task.status),
    branch: task.taskBranch,
    width: size.width,
    height: size.height,
    progress,
  };
}

function allowedCorsOrigin(requestOrigin: string | undefined, configured: string): string | null {
  const allowed = configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowed.includes("*")) {
    return "*";
  }
  if (requestOrigin && allowed.includes(requestOrigin)) {
    return requestOrigin;
  }
  return requestOrigin ? null : (allowed[0] ?? null);
}

function projectBlockers(project: Project, config: AppConfig): string[] {
  const blockers: string[] = [];
  if (!config.githubPrEnabled) {
    blockers.push("Set GITHUB_PR_ENABLED=true and restart Arc-Tech before starting Direct Agent tasks.");
  }
  if (project.remoteStatus !== "configured" || !project.remoteUrl) {
    blockers.push("Connect a GitHub repo remote before starting Direct Agent tasks.");
  }
  return blockers;
}

function looksLikeGitRemote(value: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/).+/.test(value);
}

function isClientError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /must be|required|too large|non-empty|mode must|source=|Use \/implement|Git remote URL/.test(message);
}
