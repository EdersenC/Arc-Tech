import { Client } from "discord.js";
import { CodexCliRunner } from "./codexRunner.js";
import { CodexEventRouter } from "./codex/CodexEventRouter.js";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { ExcalidrawApiServer } from "./excalidraw/ExcalidrawApiServer.js";
import { ExcalidrawCardsRepo } from "./excalidraw/ExcalidrawCardsRepo.js";
import { GitManager } from "./git.js";
import { GitHubPRFeedbackService } from "./github/GitHubPRFeedbackService.js";
import { GitHubPRService } from "./github/GitHubPRService.js";
import { PullRequestFeedbackRepo } from "./github/PullRequestFeedbackRepo.js";
import { PullRequestFeedbackWorker } from "./github/PullRequestFeedbackWorker.js";
import { OrchestrationAgentsRepo } from "./orchestrations/repos/OrchestrationAgentsRepo.js";
import { OrchestrationMessagesRepo } from "./orchestrations/repos/OrchestrationMessagesRepo.js";
import { OrchestrationsRepo } from "./orchestrations/repos/OrchestrationsRepo.js";
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
const orchestrations = new OrchestrationsRepo(database.db);
const orchestrationAgents = new OrchestrationAgentsRepo(database.db);
const orchestrationMessages = new OrchestrationMessagesRepo(database.db);
const pullRequestFeedback = new PullRequestFeedbackRepo(database.db);
const git = new GitManager();
const runner = new CodexCliRunner(config.codexBin);
const client = new Client({ intents: [] });
const progress = new TaskProgressService(client, tasks);
const router = new CodexEventRouter(tasks, progress);
const githubPr = new GitHubPRService(git, config);
const githubPrFeedback = new GitHubPRFeedbackService();
const pump = new TaskMessagePump(client, projects, tasks, git, runner, router, progress, githubPr);
const taskService = new TaskService(projects, tasks, git);
const implementService = new ImplementService(projects, tasks, git, taskService, pump);
const pullRequestFeedbackWorker = new PullRequestFeedbackWorker(
  { enabled: config.githubPrFeedbackEnabled, pollMs: config.githubPrFeedbackPollMs },
  client,
  tasks,
  orchestrations,
  orchestrationAgents,
  pullRequestFeedback,
  githubPrFeedback,
  pump,
  async () => undefined,
);
const server = new ExcalidrawApiServer({
  config,
  projects,
  tasks,
  implementService,
  cards,
  feedback: pullRequestFeedback,
  orchestrations,
  orchestrationAgents,
  orchestrationMessages,
});

pump.onTaskUpdated((task) => {
  cards.updateFromTask(task);
  if (task.parentOrchestrationId && task.orchestrationAgentId) {
    const terminal = orchestrationStatusForTask(task.status);
    if (terminal) {
      orchestrationAgents.updateCompletion(task.orchestrationAgentId, {
        status: terminal,
        prUrl: task.pullRequestUrl ?? task.prUrl,
        completionSummary: task.completionSummary ?? task.finalSummary ?? task.error,
      });
    } else if (task.status === "RUNNING" || task.status === "QUEUED") {
      orchestrationAgents.updateStatus(task.orchestrationAgentId, task.status === "RUNNING" ? "running" : "queued");
    }
  }
});
pump.restoreQueuedWork();
pullRequestFeedbackWorker.start();
server.listen();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown(): Promise<void> {
  pullRequestFeedbackWorker.stop();
  await server.close().catch(() => undefined);
  database.close();
  process.exit(0);
}

function orchestrationStatusForTask(status: string): "done" | "failed" | "canceled" | null {
  if (status === "WAITING_REVIEW" || status === "DONE" || status === "MERGED") return "done";
  if (status === "FAILED" || status === "ABANDONED") return "failed";
  if (status === "CANCELED") return "canceled";
  return null;
}
