import { Client } from "discord.js";
import { CodexCliRunner } from "./codexRunner.js";
import { CodexEventRouter } from "./codex/CodexEventRouter.js";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { ExcalidrawApiServer } from "./excalidraw/ExcalidrawApiServer.js";
import { ExcalidrawCardsRepo } from "./excalidraw/ExcalidrawCardsRepo.js";
import { GitManager } from "./git.js";
import { GitHubPRService } from "./github/GitHubPRService.js";
import { TaskProgressService } from "./progress/TaskProgressService.js";
import { dropSudoPrivilegesForLocalServer } from "./runtimeUser.js";
import { ProjectStore, TaskStore } from "./stores.js";
import { TaskMessagePump } from "./taskMessagePump.js";
import { ImplementService } from "./tasks/ImplementService.js";
import { TaskService } from "./tasks/TaskService.js";

dropSudoPrivilegesForLocalServer();

const config = loadConfig({ requireDiscord: false });
const database = new AppDatabase(config.databasePath);
const projects = new ProjectStore(database.db, config.excalidrawWorkspacesDir);
const tasks = new TaskStore(database.db);
const cards = new ExcalidrawCardsRepo(database.db);
const git = new GitManager();
const runner = new CodexCliRunner(config.codexBin);
const client = new Client({ intents: [] });
const progress = new TaskProgressService(client, tasks);
const router = new CodexEventRouter(tasks, progress);
const githubPr = new GitHubPRService(git, config);
const pump = new TaskMessagePump(client, projects, tasks, git, runner, router, progress, githubPr);
const taskService = new TaskService(projects, tasks, git);
const implementService = new ImplementService(projects, tasks, git, taskService, pump);
const server = new ExcalidrawApiServer({ config, projects, tasks, implementService, cards });

pump.onTaskUpdated((task) => {
  cards.updateFromTask(task);
});
pump.restoreQueuedWork();
server.listen();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown(): Promise<void> {
  await server.close().catch(() => undefined);
  database.close();
  process.exit(0);
}
