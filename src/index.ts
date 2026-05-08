import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Message,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type Channel,
  type ChatInputCommandInteraction,
  type TextBasedChannel,
} from "discord.js";
import { CodexCliRunner } from "./codexRunner.js";
import { CodexEventRouter } from "./codex/CodexEventRouter.js";
import { config } from "./config.js";
import { AppDatabase } from "./db.js";
import { GitManager } from "./git.js";
import { GitHubPRFeedbackService } from "./github/GitHubPRFeedbackService.js";
import { GitHubPRService } from "./github/GitHubPRService.js";
import { PullRequestFeedbackRepo } from "./github/PullRequestFeedbackRepo.js";
import { PullRequestFeedbackWorker } from "./github/PullRequestFeedbackWorker.js";
import { OrchestrationAgentSpawner } from "./orchestrations/OrchestrationAgentSpawner.js";
import { OrchestrationControlPanel } from "./orchestrations/OrchestrationControlPanel.js";
import { OrchestrationPlannerService } from "./orchestrations/OrchestrationPlannerService.js";
import { OrchestrationResultCollector } from "./orchestrations/OrchestrationResultCollector.js";
import { OrchestrationService } from "./orchestrations/OrchestrationService.js";
import { chunkDiscordMessage } from "./orchestrations/OrchestrationStatusRenderer.js";
import { OrchestrationAgentsRepo } from "./orchestrations/repos/OrchestrationAgentsRepo.js";
import { OrchestrationMessagesRepo } from "./orchestrations/repos/OrchestrationMessagesRepo.js";
import { OrchestrationsRepo } from "./orchestrations/repos/OrchestrationsRepo.js";
import { TaskProgressService } from "./progress/TaskProgressService.js";
import { ProjectStore, TaskStore } from "./stores.js";
import { TaskControlPanelService } from "./taskControlPanel.js";
import { taskDisplayNumber, taskLabel } from "./taskLabels.js";
import { TaskMessagePump } from "./taskMessagePump.js";
import { ImplementService } from "./tasks/ImplementService.js";
import { TaskService } from "./tasks/TaskService.js";
import { detectThreadShortcut, isClosedTaskStatus, isMessageInThread } from "./threadRouting.js";
import type { Project, Task } from "./types.js";

if (!config.discordToken) {
  throw new Error("DISCORD_TOKEN is required to start the Discord bot.");
}

const database = new AppDatabase(config.databasePath);
const projects = new ProjectStore(database.db, config.workspacesDir);
const tasks = new TaskStore(database.db);
const orchestrations = new OrchestrationsRepo(database.db);
const orchestrationAgents = new OrchestrationAgentsRepo(database.db);
const orchestrationMessages = new OrchestrationMessagesRepo(database.db);
const pullRequestFeedback = new PullRequestFeedbackRepo(database.db);
const git = new GitManager();
const githubPr = new GitHubPRService(git, config);
const githubPrFeedback = new GitHubPRFeedbackService();
const runner = new CodexCliRunner(config.codexBin);
const taskService = new TaskService(projects, tasks, git);
const gatewayIntents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (config.enableMessageContentIntent) {
  gatewayIntents.push(GatewayIntentBits.MessageContent);
} else {
  console.warn(
    "Message content intent is disabled. The bot can start, but task-thread chat content may be empty. Enable Message Content Intent in the Discord Developer Portal and set ENABLE_MESSAGE_CONTENT_INTENT=true.",
  );
}
const client = new Client({
  intents: gatewayIntents,
});
const progress = new TaskProgressService(client, tasks);
const codexEventRouter = new CodexEventRouter(tasks, progress);
const pump = new TaskMessagePump(client, projects, tasks, git, runner, codexEventRouter, progress, githubPr);
const controlPanel = new TaskControlPanelService(client, tasks, projects, git, pump);
const implementService = new ImplementService(projects, tasks, git, taskService, pump);
const orchestrationService = new OrchestrationService(orchestrations, orchestrationAgents, orchestrationMessages);
const planner = new OrchestrationPlannerService(orchestrations, orchestrationMessages, projects, git, runner);
let orchestrationControlPanel: OrchestrationControlPanel;
const spawner = new OrchestrationAgentSpawner(orchestrations, orchestrationAgents, tasks, taskService, {
  createChildTaskRoom: async ({ task, title, message }) => {
    const room = await createTaskRoomInChannel(client, task.channelId, title, message, `Orchestration child task ${task.id}`);
    if (!room.ok) {
      throw new Error(room.error);
    }
    if (room.sendTaskMessage) {
      await room.thread.send(truncate(message, 1900));
    }
    return { threadId: room.thread.id, threadUrl: room.thread.url };
  },
  sendChildControlPanel: (task) => controlPanel.sendControlPanel(task),
  startChildTask: async (task) => {
    const updated = tasks.update(task.id, { status: "QUEUED", error: null });
    pump.enqueue(updated.id);
  },
  postToParent: async (orchestration, content) => {
    await postToOrchestrationParent(orchestration.discordThreadId, content);
  },
  updateParentControlPanel: async (orchestrationId) => {
    await orchestrationControlPanel.updateControlPanel(orchestrationId);
  },
});
orchestrationControlPanel = new OrchestrationControlPanel(
  client,
  orchestrations,
  orchestrationAgents,
  orchestrationService,
  planner,
  spawner,
);
const orchestrationResultCollector = new OrchestrationResultCollector(
  client,
  orchestrations,
  orchestrationAgents,
  tasks,
  (orchestrationId) => orchestrationControlPanel.updateControlPanel(orchestrationId),
);
const pullRequestFeedbackWorker = new PullRequestFeedbackWorker(
  { enabled: config.githubPrFeedbackEnabled, pollMs: config.githubPrFeedbackPollMs },
  client,
  tasks,
  orchestrations,
  orchestrationAgents,
  pullRequestFeedback,
  githubPrFeedback,
  pump,
  (orchestrationId) => orchestrationControlPanel.updateControlPanel(orchestrationId),
);
pump.onTaskUpdated(async (task) => {
  await controlPanel.updateControlPanel(task);
  await orchestrationResultCollector.handleTaskUpdated(task);
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord bot ready as ${readyClient.user.tag}`);
  pump.restoreQueuedWork();
  pullRequestFeedbackWorker.start();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (await controlPanel.handleButton(interaction)) {
        return;
      }
      if (await orchestrationControlPanel.handleButton(interaction)) {
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (await controlPanel.handleSelectMenu(interaction)) {
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (await orchestrationControlPanel.handleModalSubmit(interaction)) {
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Component interaction handling failed:", error);
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      } else {
        await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    if (interaction.commandName === "implement") {
      await handleImplement(interaction);
      return;
    }

    if (interaction.commandName === "orchestrate") {
      await handleOrchestrate(interaction);
      return;
    }

    if (interaction.commandName === "status") {
      await handleStatus(interaction);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Interaction handling failed:", error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`Error: ${message}`).catch(() => undefined);
    } else {
      await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleThreadMessage(message);
  } catch (error) {
    console.error("Message handling failed:", error);
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await client.login(config.discordToken);

async function handleImplement(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guildId) {
    await interaction.editReply("This bot only supports guild channels.");
    return;
  }

  const msg = interaction.options.getString("msg", true);
  const projectChannel = await resolveProjectChannel(interaction);
  let project = projects.getOrCreate({
    guildId: interaction.guildId,
    channelId: projectChannel.id,
    channelName: projectChannel.name,
  });
  const result = await implementService.run({
    project,
    prompt: msg,
    requestedBy: interaction.user.id,
    sourceUi: "discord",
    startImmediately: false,
    allowLocalOnlyWithoutRemote: false,
  });
  project = result.project;
  let task = result.task;
  const taskMessage = `Task ${taskLabel(task)}\n\nRequest:\n${msg}`;
  const taskRoom = await createTaskRoom(interaction, String(taskDisplayNumber(task)), taskMessage);

  if (!taskRoom.ok) {
    if (!result.remoteRequired) {
      task = await implementService.startTask(project, task);
    }
    await interaction.editReply(truncate(`Created task ${taskLabel(task)}, but could not create a task thread.\n\n${taskRoom.error}`, 1900));
    return;
  }

  task = tasks.update(task.id, { discordThreadId: taskRoom.thread.id, discordThreadUrl: taskRoom.thread.url });
  if (taskRoom.sendTaskMessage) {
    try {
      await taskRoom.thread.send(taskMessage);
    } catch (error) {
      console.error("Discord API error while sending task message to thread.", {
        taskId: task.id,
        threadId: taskRoom.thread.id,
        channelType: taskRoom.thread.type,
        channelTypeName: channelTypeName(taskRoom.thread.type),
        error,
      });
      if (project.remoteStatus !== "missing") {
        task = await implementService.startTask(project, task);
      }
      await interaction.editReply(
        truncate(
          `Created task ${taskLabel(task)} in <#${taskRoom.thread.id}>, but could not send the task message.\n\n${formatDiscordError(
            error,
          )}`,
          1900,
        ),
      );
      return;
    }
  }

  console.log("Queued initial task message.", { taskId: task.id, queuedMessageId: result.initialMessage.id });
  await controlPanel.sendControlPanel(task);
  if (task.status === "WAITING_REMOTE") {
    await sendRemotePrompt(taskRoom.thread, project, task);
    await interaction.editReply(
      `Created task ${taskLabel(task)} in <#${taskRoom.thread.id}>. I need the Git remote before Start is available.`,
    );
    return;
  }
  await interaction.editReply(`Created task ${taskLabel(task)} in <#${taskRoom.thread.id}>. Use Start in the task control panel when ready.`);
}

async function handleOrchestrate(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guildId) {
    await interaction.editReply("This bot only supports guild channels.");
    return;
  }

  const msg = interaction.options.getString("msg", true);
  const projectChannel = await resolveProjectChannel(interaction);
  let project = projects.getOrCreate({
    guildId: interaction.guildId,
    channelId: projectChannel.id,
    channelName: projectChannel.name,
  });
  project = await syncProjectOrigin(project);
  const orchestration = orchestrationService.createOrchestration(project, interaction.user, msg);
  orchestrationMessages.create(orchestration.id, "user", msg, {
    discordMessageId: null,
    authorUserId: interaction.user.id,
    metadata: { source: "slash-command" },
  });

  const title = `Orchestration #${orchestration.id} - ${oneLine(msg, 70)}`;
  const initialMessage = `Orchestration #${orchestration.id}

Goal:
${msg}

The planner will ask questions, propose architecture, and keep a current plan here. Use the control panel to show or improve the plan, set bounds, and launch child agents.`;
  const room = await createTaskRoomInChannel(
    client,
    projectChannel.id,
    title,
    initialMessage,
    `Orchestration ${orchestration.id}`,
    String(orchestration.id),
  );
  if (!room.ok) {
    orchestrationService.updateStatus(orchestration.id, "FAILED");
    await interaction.editReply(truncate(`Created orchestration #${orchestration.id}, but could not create the parent thread.\n\n${room.error}`, 1900));
    return;
  }

  orchestrationService.updateThread(orchestration.id, room.thread.id, room.thread.url);
  if (room.sendTaskMessage) {
    await room.thread.send(initialMessage);
  }
  await orchestrationControlPanel.sendControlPanel(orchestrations.findById(orchestration.id) ?? orchestration);
  await interaction.editReply(`Created orchestration #${orchestration.id} in <#${room.thread.id}>. Planner is starting.`);

  void planner
    .startPlanner(orchestration.id)
    .then(async (response) => {
      await postToOrchestrationParent(room.thread.id, response);
      await orchestrationControlPanel.updateControlPanel(orchestration.id);
    })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      orchestrations.updateStatus(orchestration.id, "FAILED");
      await postToOrchestrationParent(room.thread.id, `Planner failed:\n${truncate(message, 1500)}`);
      await orchestrationControlPanel.updateControlPanel(orchestration.id);
    });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guildId) {
    await interaction.editReply("Bot is online. This bot only tracks projects in guild channels.");
    return;
  }

  const projectChannel = await resolveProjectChannel(interaction);
  let project = projects.getByGuildChannel(interaction.guildId, projectChannel.id);
  if (!project) {
    await interaction.editReply(`Bot is online. No project exists yet for #${projectChannel.name}.`);
    return;
  }
  project = await syncProjectOrigin(project);

  const recentTasks = tasks.listByProject(project.id, 10);
  const taskLines = recentTasks.length > 0 ? recentTasks.map(formatTaskStatus).join("\n") : "No tasks yet.";
  await interaction.editReply(
    truncate(
      `Bot is online.
Project: ${project.projectName}
Slug: ${project.projectSlug}
Remote: ${project.remoteStatus}${project.remoteUrl ? ` (${project.remoteUrl})` : ""}
Repo: ${project.repoPath}

Recent tasks:
${taskLines}`,
      1900,
    ),
  );
}

async function handleThreadMessage(message: Message): Promise<void> {
  if (message.author.bot || message.system || !message.inGuild() || !isMessageInThread(message)) {
    return;
  }

  console.log("Received thread message.", {
    messageId: message.id,
    authorId: message.author.id,
    channelId: message.channel.id,
  });

  const task = tasks.getByThreadId(message.channel.id);
  if (!task) {
    await handleOrchestrationThreadMessage(message);
    return;
  }
  console.log("Matched thread message to task.", { messageId: message.id, taskId: task.id });

  const content = message.content.trim();
  if (!content) {
    await message.reply("I received this task-thread message, but its content was empty. Check the Message Content Intent setting.");
    return;
  }

  if (task.status === "FAILED" && isRetryMessage(content)) {
    tasks.update(task.id, { status: "QUEUED", error: null });
  } else if (isClosedTaskStatus(task.status)) {
    await message.reply(`Task ${taskLabel(task)} is closed with status ${task.status}. Create a new /implement task.`);
    return;
  }

  const shortcut = detectThreadShortcut(content);
  if (shortcut === "status") {
    await message.reply(
      `Task ${taskLabel(task)}: ${task.status}\nBranch: ${task.taskBranch ?? "not created"}\nWorktree: ${task.worktreePath ?? "not created"}`,
    );
    return;
  }
  if (shortcut === "diff") {
    await message.reply(truncate(`Task ${taskLabel(task)} diff stat:\n${await git.getDiffStat(task)}`, 1900));
    return;
  }
  if (shortcut === "cancel") {
    await pump.cancelTask(task);
    return;
  }

  if (task.status === "WAITING_REMOTE") {
    await handleRemoteReply(message, task, content);
    return;
  }

  if (task.status === "WAITING_REVIEW" || task.status === "DONE") {
    tasks.update(task.id, { status: "QUEUED" });
  }

  const queued = tasks.enqueueUserMessage({
    taskId: task.id,
    discordMessageId: message.id,
    discordAuthorId: message.author.id,
    content,
  });
  console.log("Queued thread message.", { taskId: task.id, queuedMessageId: queued.id, discordMessageId: message.id });
  await acknowledgeQueuedMessage(message, task.id);
  if (task.status === "PENDING_START") {
    await message.reply(`Queued for task ${taskLabel(task)}. Press Start in the task control panel when ready.`);
    return;
  }
  pump.enqueue(task.id);
}

async function handleOrchestrationThreadMessage(message: Message): Promise<void> {
  const orchestration = orchestrations.findByDiscordThreadId(message.channel.id);
  if (!orchestration) {
    return;
  }

  const content = message.content.trim();
  if (!content) {
    await message.reply("I received this orchestration message, but its content was empty. Check the Message Content Intent setting.");
    return;
  }

  if (orchestration.status === "CANCELED" || orchestration.status === "COMPLETED" || orchestration.status === "FAILED") {
    await message.reply(`Orchestration #${orchestration.id} is closed with status ${orchestration.status}.`);
    return;
  }

  orchestrationService.appendUserMessage(orchestration.id, {
    content,
    discordMessageId: message.id,
    authorUserId: message.author.id,
  });

  if (orchestration.status === "RUNNING_AGENTS" || orchestration.status === "LAUNCHING_AGENTS" || orchestration.status === "WAITING_REVIEW") {
    await message.reply("Stored as a parent-level orchestration instruction. It was not pushed to child agents automatically.");
    await orchestrationControlPanel.updateControlPanel(orchestration.id);
    return;
  }

  await message.react("🧭").catch(() => undefined);
  try {
    const response = await planner.continuePlanner(orchestration.id, content);
    await postToOrchestrationParent(orchestration.discordThreadId, response);
    await orchestrationControlPanel.updateControlPanel(orchestration.id);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    orchestrations.updateStatus(orchestration.id, "FAILED");
    await message.reply(truncate(`Planner failed:\n${text}`, 1900));
    await orchestrationControlPanel.updateControlPanel(orchestration.id);
  }
}

async function resolveProjectChannel(interaction: ChatInputCommandInteraction): Promise<{ id: string; name: string }> {
  const channel = await interaction.client.channels.fetch(interaction.channelId);
  if (!channel) {
    throw new Error(`Discord could not fetch channel ${interaction.channelId}.`);
  }

  if (channel.isThread()) {
    if (!channel.parentId) {
      return { id: channel.id, name: channelName(channel) };
    }
    const parent = await interaction.client.channels.fetch(channel.parentId);
    if (!parent) {
      throw new Error(`Discord could not fetch parent channel ${channel.parentId}.`);
    }
    return { id: parent.id, name: channelName(parent) };
  }

  return { id: channel.id, name: channelName(channel) };
}

async function syncProjectOrigin(project: Project): Promise<Project> {
  const origin = await git.getProjectOrigin(project).catch((error) => {
    console.error("Failed to inspect project origin.", { projectId: project.id, error });
    return null;
  });

  if (origin) {
    return projects.updateRemote(project.id, { remoteUrl: origin, remoteStatus: "configured" });
  }
  if (project.remoteStatus === "configured") {
    return projects.updateRemote(project.id, { remoteUrl: null, remoteStatus: "missing" });
  }
  return project;
}

async function sendRemotePrompt(thread: AnyThreadChannel, project: Project, task: Task): Promise<void> {
  await thread.send(
    `Git remote needed for project "${project.projectName}".

Task ${taskLabel(task)} is paused until the project has an origin remote.

Reply in this thread with a Git remote URL, for example:
https://github.com/owner/repo.git
git@github.com:owner/repo.git

Or reply with \`skip\` to keep this project local-only for now.`,
  );
}

async function handleRemoteReply(message: Message, task: Task, content: string): Promise<void> {
  if (!canConfigureRemote(message, task)) {
    await message.reply(`Only the task requester or a server manager can configure the remote for task ${taskLabel(task)}.`);
    return;
  }

  const project = projects.getById(task.projectId);
  if (!project) {
    const updated = tasks.update(task.id, { status: "FAILED", error: `Project #${task.projectId} not found.` });
    await controlPanel.updateControlPanel(updated);
    await message.reply(`Task ${taskLabel(task)} failed: project #${task.projectId} was not found.`);
    return;
  }

  if (isRemoteSkip(content)) {
    projects.updateRemote(project.id, { remoteUrl: null, remoteStatus: "skipped" });
    const withWorktree = await createOrRefreshTaskWorktree(project, task);
    const updated = tasks.update(withWorktree.id, { status: "PENDING_START", error: null });
    await controlPanel.updateControlPanel(updated);
    await message.reply(`Remote setup skipped for project "${project.projectName}". Press Start when ready.`);
    return;
  }

  const remoteUrl = extractRemoteUrl(content);
  if (!remoteUrl) {
    await message.reply(
      `That does not look like a Git remote URL. Reply with \`https://github.com/owner/repo.git\`, \`git@github.com:owner/repo.git\`, or \`skip\`.`,
    );
    return;
  }

  try {
    const pulled = await git.setProjectOriginAndPull(project, remoteUrl);
    projects.updateRemote(project.id, { remoteUrl, remoteStatus: "configured" });
    const withWorktree = await createOrRefreshTaskWorktree(project, task, true);
    const updated = tasks.update(withWorktree.id, { status: "PENDING_START", error: null });
    await controlPanel.updateControlPanel(updated);
    await message.reply(`Set project origin to ${remoteUrl}.\n${pulled.summary}\nPress Start when ready.`);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await message.reply(truncate(`Could not set project origin:\n${text}`, 1900));
  }
}

async function createOrRefreshTaskWorktree(project: Project, task: Task, reset = false): Promise<Task> {
  return taskService.createOrRefreshWorktree(project, task, { reset });
}

function channelName(channel: Channel): string {
  return "name" in channel && typeof channel.name === "string" && channel.name.trim() ? channel.name : channel.id;
}

function formatTaskStatus(task: ReturnType<TaskStore["listByProject"]>[number]): string {
  return `${taskLabel(task)} ${task.status} ${task.taskBranch ?? "no-branch"} ${task.mode}/${task.sandbox}`;
}

function canConfigureRemote(message: Message, task: Task): boolean {
  if (task.requestedBy && message.author.id === task.requestedBy) {
    return true;
  }
  return Boolean(message.member?.permissions.has("Administrator") || message.member?.permissions.has("ManageGuild"));
}

function isRemoteSkip(content: string): boolean {
  return /^(skip|local|local-only|no remote|no origin)$/i.test(content.trim());
}

function extractRemoteUrl(content: string): string | null {
  const trimmed = stripUrlWrappers(content.trim());
  const remoteCommand = /^git\s+remote\s+(?:add|set-url)\s+origin\s+(\S+)$/i.exec(trimmed);
  if (remoteCommand) {
    return validRemoteUrl(stripUrlWrappers(remoteCommand[1]));
  }
  const originPrefix = /^origin\s+(\S+)$/i.exec(trimmed);
  if (originPrefix) {
    return validRemoteUrl(stripUrlWrappers(originPrefix[1]));
  }
  return validRemoteUrl(trimmed);
}

function validRemoteUrl(value: string): string | null {
  if (/^(https?:\/\/|ssh:\/\/|git:\/\/)\S+$/i.test(value)) {
    return value;
  }
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/i.test(value)) {
    return value;
  }
  return null;
}

function stripUrlWrappers(value: string): string {
  return value.replace(/^<(.+)>$/, "$1").replace(/^['"](.+)['"]$/, "$1");
}

type TaskRoomResult =
  | { ok: true; thread: AnyThreadChannel; sendTaskMessage: boolean }
  | { ok: false; error: string };

async function createTaskRoom(
  interaction: ChatInputCommandInteraction,
  taskId: string,
  taskMessage: string,
  title = `task-${taskId}`,
  reason = `Checkpoint task ${taskId}`,
): Promise<TaskRoomResult> {
  return createTaskRoomInChannel(interaction.client, interaction.channelId, title, taskMessage, reason, taskId);
}

async function createTaskRoomInChannel(
  discordClient: Client,
  channelId: string,
  title: string,
  taskMessage: string,
  reason: string,
  debugId = title,
): Promise<TaskRoomResult> {
  let channel;
  try {
    channel = await discordClient.channels.fetch(channelId);
  } catch (error) {
    console.error("Discord API error while fetching interaction channel.", {
      taskId: debugId,
      channelId,
      error,
    });
    return { ok: false, error: formatDiscordError(error) };
  }

  if (!channel) {
    console.error("Cannot create task room: fetched channel is null.", {
      taskId: debugId,
      channelId,
    });
    return { ok: false, error: "Discord could not fetch the channel for this interaction." };
  }

  const channelType = channel.type;
  const channelDebug = {
    taskId: debugId,
    channelId: channel.id,
    channelType,
    channelTypeName: channelTypeName(channelType),
    isTextBased: channel.isTextBased(),
    isThread: channel.isThread(),
    isThreadOnly: channel.isThreadOnly(),
  };
  console.log("Creating task room.", channelDebug);

  try {
    if (channel.isThread()) {
      return { ok: true, thread: channel, sendTaskMessage: true };
    }

    if (channel.type === ChannelType.GuildText) {
      const thread = await channel.threads.create({
        name: title,
        type: ChannelType.PublicThread,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        reason,
      });
      return { ok: true, thread, sendTaskMessage: true };
    }

    if (channel.type === ChannelType.GuildAnnouncement) {
      const thread = await channel.threads.create({
        name: title,
        type: ChannelType.AnnouncementThread,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        reason,
      });
      return { ok: true, thread, sendTaskMessage: true };
    }

    if (channel.type === ChannelType.GuildForum) {
      const thread = await channel.threads.create({
        name: title,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        message: { content: taskMessage },
        appliedTags: defaultForumTags(channel.availableTags),
        reason,
      });
      return { ok: true, thread, sendTaskMessage: false };
    }
  } catch (error) {
    console.error("Discord API error while creating task room.", {
      ...channelDebug,
      error,
    });
    return {
      ok: false,
      error: formatDiscordError(error),
    };
  }

  return {
    ok: false,
    error: `Unsupported channel type ${channelType} (${channelTypeName(
      channelType,
    )}). isTextBased=${channel.isTextBased()} isThread=${channel.isThread()} isThreadOnly=${channel.isThreadOnly()}`,
  };
}

function defaultForumTags(tags: readonly { id: string; moderated: boolean }[]): string[] | undefined {
  const firstPublicTag = tags.find((tag) => !tag.moderated);
  return firstPublicTag ? [firstPublicTag.id] : undefined;
}

function channelTypeName(type: ChannelType): string {
  return ChannelType[type] ?? "Unknown";
}

function formatDiscordError(error: unknown): string {
  const record = isRecord(error) ? error : {};
  const name = typeof record.name === "string" ? record.name : error instanceof Error ? error.name : "UnknownError";
  const code = record.code === undefined ? "none" : String(record.code);
  const message = truncate(error instanceof Error ? error.message : String(error), 700);
  const rawError = record.rawError === undefined ? "none" : safeJson(record.rawError);

  return `Discord API error:
name: ${name}
code: ${code}
message: ${message}
rawError: ${rawError}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeJson(value: unknown): string {
  try {
    return truncate(JSON.stringify(value), 900);
  } catch {
    return truncate(String(value), 900);
  }
}

async function postToOrchestrationParent(threadId: string | null, content: string): Promise<void> {
  if (!threadId) return;
  const channel = await client.channels.fetch(threadId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  const thread = channel as TextBasedChannel & { send: (content: string) => Promise<unknown> };
  for (const chunk of chunkDiscordMessage(content)) {
    await thread.send(chunk);
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 14)}...[truncated]`;
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function isRetryMessage(content: string): boolean {
  return /^(retry|try again|rerun|run again)$/i.test(content.trim());
}

async function acknowledgeQueuedMessage(message: Message, taskId: number): Promise<void> {
  try {
    await message.react("📨");
  } catch {
    const task = tasks.getById(taskId);
    await message.reply(`Queued for task ${task ? taskLabel(task) : `#${taskId}`}.`);
  }
}

function shutdown(): void {
  console.log("Shutting down.");
  pullRequestFeedbackWorker.stop();
  client.destroy();
  database.close();
  process.exit(0);
}
