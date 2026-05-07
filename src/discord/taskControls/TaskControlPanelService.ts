import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AnyThreadChannel,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { GitManager } from "../../git.js";
import type { ProjectStore, TaskStore } from "../../stores.js";
import type { TaskMessagePump } from "../../taskMessagePump.js";
import { taskLabel } from "../../taskLabels.js";
import type { Effort, SandboxMode, Task, TaskMode } from "../../types.js";

const MODEL_OPTIONS = ["gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5"];
const EFFORT_OPTIONS: Effort[] = ["low", "medium", "high"];
const MODE_OPTIONS: TaskMode[] = ["ask", "plan_only", "implement"];
const SANDBOX_OPTIONS: SandboxMode[] = ["read-only", "workspace-write"];

type TaskButtonAction = "start" | "cancel" | "status" | "diff" | "test" | "request-changes" | "merge" | "abandon";
type TaskSelectField = "model" | "effort" | "mode" | "sandbox";

export class TaskControlPanelService {
  constructor(
    private readonly client: Client,
    private readonly tasks: TaskStore,
    private readonly projects: ProjectStore,
    private readonly git: GitManager,
    private readonly pump: TaskMessagePump,
  ) {}

  async sendControlPanel(task: Task): Promise<void> {
    const thread = await this.getTaskThread(task);
    if (!thread) {
      return;
    }

    const panel = await thread.send({
      content: this.panelContent(task),
      components: buttonRows(task),
    });
    this.tasks.update(task.id, { controlPanelMessageId: panel.id });

    await thread.send({
      content: `Task ${taskLabel(task)} config`,
      components: configRows(task),
    });
  }

  async updateControlPanel(task: Task): Promise<void> {
    if (!task.controlPanelMessageId) {
      return;
    }
    const thread = await this.getTaskThread(task);
    if (!thread || !("messages" in thread)) {
      return;
    }

    const message = await thread.messages.fetch(task.controlPanelMessageId).catch(() => null);
    if (!message) {
      return;
    }
    await message.edit({
      content: this.panelContent(task),
      components: buttonRows(task),
    });
  }

  async disableControlPanel(task: Task): Promise<void> {
    if (!task.controlPanelMessageId) {
      return;
    }
    const thread = await this.getTaskThread(task);
    if (!thread || !("messages" in thread)) {
      return;
    }

    const message = await thread.messages.fetch(task.controlPanelMessageId).catch(() => null);
    if (!message) {
      return;
    }
    await message.edit({
      content: this.panelContent(task),
      components: buttonRows(task, true),
    });
  }

  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const parsed = parseButtonCustomId(interaction.customId);
    if (!parsed) {
      return false;
    }

    if (parsed.action === "request-changes") {
      const task = await this.loadAuthorizedTask(interaction, parsed.taskId, false);
      if (!task) {
        return true;
      }
      await interaction.showModal(requestChangesModal(task.id));
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const task = await this.loadAuthorizedTask(interaction, parsed.taskId);
    if (!task) {
      return true;
    }

    if (parsed.action === "start") {
      await this.startTask(interaction, task);
      return true;
    }
    if (parsed.action === "cancel") {
      await this.cancelTask(interaction, task);
      return true;
    }
    if (parsed.action === "status") {
      await interaction.editReply(this.statusSummary(task));
      return true;
    }
    if (parsed.action === "diff") {
      await this.showDiff(interaction, task);
      return true;
    }
    if (parsed.action === "test") {
      await interaction.editReply(`Task ${taskLabel(task)} test run is not wired yet. Reply in the task thread with explicit test instructions.`);
      return true;
    }
    if (parsed.action === "merge") {
      await this.mergeTask(interaction, task);
      return true;
    }

    await this.abandonTask(interaction, task);
    return true;
  }

  async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
    const parsed = parseRequestChangesModalId(interaction.customId);
    if (!parsed) {
      return false;
    }

    const task = this.tasks.getById(parsed.taskId);
    if (!task) {
      await interaction.reply({ content: `Task #${parsed.taskId} does not exist.`, flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!this.isAllowed(interaction, task)) {
      await interaction.reply({ content: `You are not allowed to control task ${taskLabel(task)}.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.reply({
      content: `Request Changes recorded for task ${taskLabel(task)}. Follow-up queue wiring is not enabled in this ticket.`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<boolean> {
    const parsed = parseSelectCustomId(interaction.customId);
    if (!parsed) {
      return false;
    }

    await interaction.deferUpdate();
    const task = this.tasks.getById(parsed.taskId);
    if (!task) {
      await interaction.followUp({ content: `Task #${parsed.taskId} does not exist.`, flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!this.isAllowed(interaction, task)) {
      await interaction.followUp({ content: `You are not allowed to control task ${taskLabel(task)}.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    const value = interaction.values[0];
    const update = selectedConfigUpdate(parsed.field, value);
    if (!update) {
      await interaction.followUp({ content: `Unsupported ${parsed.field} value: ${value}`, flags: MessageFlags.Ephemeral });
      return true;
    }

    const updated = this.tasks.update(task.id, update);
    await interaction.message.edit({
      content: `Task ${taskLabel(updated)} config`,
      components: configRows(updated),
    });
    await this.updateControlPanel(updated);
    return true;
  }

  private async startTask(interaction: ButtonInteraction, task: Task): Promise<void> {
    if (isClosed(task)) {
      await interaction.editReply(`Task ${taskLabel(task)} is closed with status ${task.status}.`);
      return;
    }
    if (task.status === "RUNNING" || this.pump.activeTasks.has(task.id)) {
      await interaction.editReply(`Task ${taskLabel(task)} is already running.`);
      return;
    }
    let project = this.projects.getById(task.projectId);
    if (task.status === "WAITING_REMOTE") {
      const origin = project ? await this.git.getProjectOrigin(project).catch(() => null) : null;
      if (!project || !origin) {
        await interaction.editReply(`Task ${taskLabel(task)} is waiting for Git remote setup. Reply in the task thread with a remote URL or \`skip\`.`);
        return;
      }
      this.projects.updateRemote(project.id, { remoteUrl: origin, remoteStatus: "configured" });
      await this.git.pullProjectOrigin(project);
      const worktree = await this.git.createTaskWorktree(project, task, { reset: true });
      task = this.tasks.update(task.id, {
        status: "PENDING_START",
        error: null,
        baseBranch: worktree.baseBranch,
        taskBranch: worktree.taskBranch,
        worktreePath: worktree.worktreePath,
      });
    }

    if (!task.worktreePath || !task.taskBranch) {
      project ??= this.projects.getById(task.projectId);
      if (!project) {
        await interaction.editReply(`Project #${task.projectId} does not exist.`);
        return;
      }
      const origin = await this.git.getProjectOrigin(project).catch(() => null);
      if (origin) {
        this.projects.updateRemote(project.id, { remoteUrl: origin, remoteStatus: "configured" });
        await this.git.pullProjectOrigin(project);
      }
      const worktree = await this.git.createTaskWorktree(project, task);
      task = this.tasks.update(task.id, {
        baseBranch: worktree.baseBranch,
        taskBranch: worktree.taskBranch,
        worktreePath: worktree.worktreePath,
      });
    }

    const updated = this.tasks.update(task.id, { status: "QUEUED", error: null });
    this.pump.enqueue(task.id);
    await this.updateControlPanel(updated);
    await interaction.editReply(`Task ${taskLabel(updated)} started.`);
  }

  private async cancelTask(interaction: ButtonInteraction, task: Task): Promise<void> {
    if (isClosed(task)) {
      await interaction.editReply(`Task ${taskLabel(task)} is already closed with status ${task.status}.`);
      return;
    }

    await this.pump.cancelTask(task);
    const updated = this.tasks.getById(task.id) ?? task;
    await this.updateControlPanel(updated);
    await interaction.editReply(`Task ${taskLabel(updated)} canceled.`);
  }

  private async showDiff(interaction: ButtonInteraction, task: Task): Promise<void> {
    const diff = await this.git.getDiffStat(task);
    await interaction.editReply(truncate(`Task ${taskLabel(task)} diff stat:\n${diff}`, 1900));
  }

  private async mergeTask(interaction: ButtonInteraction, task: Task): Promise<void> {
    if (!(task.status === "WAITING_REVIEW" || task.status === "DONE")) {
      await interaction.editReply(`Task ${taskLabel(task)} is not ready to merge. Current status: ${task.status}.`);
      return;
    }
    const project = this.projects.getById(task.projectId);
    if (!project) {
      await interaction.editReply(`Project #${task.projectId} does not exist.`);
      return;
    }

    try {
      const stat = await this.git.mergeTaskToMain(project, task);
      const updated = this.tasks.update(task.id, { status: "MERGED", mergeStatus: "merged", error: null });
      await this.disableControlPanel(updated);
      await interaction.editReply(truncate(`Task ${taskLabel(updated)} merged into ${task.baseBranch ?? "main"}.\n\n${stat}`, 1900));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = this.tasks.update(task.id, { mergeStatus: "conflict", error: message });
      await this.updateControlPanel(updated);
      await interaction.editReply(truncate(`Task ${taskLabel(updated)} merge conflict.\n\n${message}`, 1900));
    }
  }

  private async abandonTask(interaction: ButtonInteraction, task: Task): Promise<void> {
    const project = this.projects.getById(task.projectId);
    if (!project) {
      await interaction.editReply(`Project #${task.projectId} does not exist.`);
      return;
    }

    if (this.pump.activeTasks.has(task.id) || task.status === "RUNNING" || task.status === "QUEUED") {
      await this.pump.cancelTask(task);
    }
    this.tasks.failQueuedMessages(task.id);
    await this.git.cleanupTaskWorktree(project, task);
    const updated = this.tasks.update(task.id, {
      status: "ABANDONED",
      mergeStatus: "abandoned",
      error: "Abandoned from Discord control panel.",
    });
    await this.disableControlPanel(updated);
    await interaction.editReply(`Task ${taskLabel(updated)} abandoned and its worktree was removed.`);
  }

  private async loadAuthorizedTask(
    interaction: ButtonInteraction,
    taskId: number,
    reply = true,
  ): Promise<Task | null> {
    const task = this.tasks.getById(taskId);
    if (!task) {
      if (reply) {
        await interaction.editReply(`Task #${taskId} does not exist.`);
      } else {
        await interaction.reply({ content: `Task #${taskId} does not exist.`, flags: MessageFlags.Ephemeral });
      }
      return null;
    }
    if (!this.isAllowed(interaction, task)) {
      if (reply) {
        await interaction.editReply(`You are not allowed to control task ${taskLabel(task)}.`);
      } else {
        await interaction.reply({ content: `You are not allowed to control task ${taskLabel(task)}.`, flags: MessageFlags.Ephemeral });
      }
      return null;
    }
    return task;
  }

  private isAllowed(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, task: Task): boolean {
    if (task.requestedBy && interaction.user.id === task.requestedBy) {
      return true;
    }
    return Boolean(
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
    );
  }

  private async getTaskThread(task: Task): Promise<AnyThreadChannel | null> {
    if (!task.discordThreadId) {
      return null;
    }
    const channel = await this.client.channels.fetch(task.discordThreadId).catch(() => null);
    return channel?.isThread() ? channel : null;
  }

  private statusSummary(task: Task): string {
    return `Task ${taskLabel(task)}\nStatus: ${task.status}\nBranch: ${task.taskBranch ?? "not created"}\nWorktree: ${task.worktreePath ?? "not created"}`;
  }

  private panelContent(task: Task): string {
    return `Task Control Panel
Task ID: ${taskLabel(task)}
Status: ${task.status}
Branch: ${task.taskBranch ?? "not created"}
Worktree: ${task.worktreePath ?? "not created"}
Mode: ${task.mode}
Model: ${task.model}
Effort: ${task.effort}
Sandbox: ${task.sandbox}`;
  }
}

function buttonRows(task: Task, forceDisabled = false): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = forceDisabled || isClosed(task);
  const startDisabled = disabled || task.status === "RUNNING" || task.status === "QUEUED";
  const mergeDisabled = disabled || !(task.status === "WAITING_REVIEW" || task.status === "DONE");

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`taskctl:start:${task.id}`).setLabel("Start").setStyle(ButtonStyle.Success).setDisabled(startDisabled),
      new ButtonBuilder().setCustomId(`taskctl:cancel:${task.id}`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`taskctl:status:${task.id}`).setLabel("Show Status").setStyle(ButtonStyle.Secondary).setDisabled(forceDisabled),
      new ButtonBuilder().setCustomId(`taskctl:diff:${task.id}`).setLabel("Show Diff").setStyle(ButtonStyle.Secondary).setDisabled(forceDisabled),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`taskctl:test:${task.id}`).setLabel("Run Tests").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`taskctl:request-changes:${task.id}`)
        .setLabel("Request Changes")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder().setCustomId(`taskctl:merge:${task.id}`).setLabel("Merge").setStyle(ButtonStyle.Primary).setDisabled(mergeDisabled),
      new ButtonBuilder().setCustomId(`taskctl:abandon:${task.id}`).setLabel("Abandon").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ),
  ];
}

function requestChangesModal(taskId: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`taskfollow:request-changes:${taskId}`)
    .setTitle(`Request Changes #${taskId}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("request")
          .setLabel("Requested changes")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500),
      ),
    );
}

function configRows(task: Task): ActionRowBuilder<StringSelectMenuBuilder>[] {
  return [
    selectRow("model", task.id, "Model", optionsWithCurrent(MODEL_OPTIONS, task.model), task.model),
    selectRow("effort", task.id, "Effort", EFFORT_OPTIONS, task.effort),
    selectRow("mode", task.id, "Mode", MODE_OPTIONS, task.mode),
    selectRow("sandbox", task.id, "Sandbox", SANDBOX_OPTIONS, task.sandbox),
  ];
}

function selectRow(
  field: TaskSelectField,
  taskId: number,
  placeholder: string,
  options: string[],
  current: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`task:select:${field}:${taskId}`)
      .setPlaceholder(placeholder)
      .addOptions(
        options.map((value) => ({
          label: labelFor(value),
          value,
          default: value === current,
        })),
      ),
  );
}

function parseButtonCustomId(customId: string): { action: TaskButtonAction; taskId: number } | null {
  const match = /^taskctl:(start|cancel|status|diff|test|request-changes|merge|abandon):(\d+)$/.exec(customId);
  if (!match) {
    return null;
  }
  return { action: match[1] as TaskButtonAction, taskId: Number(match[2]) };
}

function parseRequestChangesModalId(customId: string): { taskId: number } | null {
  const match = /^taskfollow:request-changes:(\d+)$/.exec(customId);
  if (!match) {
    return null;
  }
  return { taskId: Number(match[1]) };
}

function parseSelectCustomId(customId: string): { field: TaskSelectField; taskId: number } | null {
  const match = /^task:select:(model|effort|mode|sandbox):(\d+)$/.exec(customId);
  if (!match) {
    return null;
  }
  return { field: match[1] as TaskSelectField, taskId: Number(match[2]) };
}

function selectedConfigUpdate(field: TaskSelectField, value: string): Partial<Pick<Task, "model" | "effort" | "mode" | "sandbox">> | null {
  if (field === "model") {
    return { model: value };
  }
  if (field === "effort" && EFFORT_OPTIONS.includes(value as Effort)) {
    return { effort: value as Effort };
  }
  if (field === "mode" && MODE_OPTIONS.includes(value as TaskMode)) {
    return { mode: value as TaskMode };
  }
  if (field === "sandbox" && SANDBOX_OPTIONS.includes(value as SandboxMode)) {
    return { sandbox: value as SandboxMode };
  }
  return null;
}

function optionsWithCurrent(options: string[], current: string): string[] {
  return options.includes(current) ? options : [current, ...options];
}

function labelFor(value: string): string {
  if (value === "plan_only") {
    return "Plan only";
  }
  if (value === "workspace-write") {
    return "Workspace write";
  }
  if (value === "read-only") {
    return "Read only";
  }
  return value;
}

function isClosed(task: Task): boolean {
  return task.status === "CANCELED" || task.status === "FAILED" || task.status === "MERGED" || task.status === "ABANDONED";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 14)}...[truncated]`;
}
