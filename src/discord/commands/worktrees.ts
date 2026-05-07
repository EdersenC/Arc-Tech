import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Channel,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { GitCleanupService, GitCleanupWorktree, GitWorktreeDetails } from "../../git/GitCleanupService.js";
import type { ProjectStore } from "../../stores.js";
import type { Project } from "../../types.js";

const MAX_MESSAGE_LENGTH = 1900;
const MAX_LISTED_WORKTREES = 6;
const MAX_DETAIL_BUTTONS = 5;

type CleanupAction = "cleanup-merged" | "cleanup-abandoned" | "prune-missing";

export class WorktreesCommand {
  constructor(private readonly projects: ProjectStore, private readonly cleanup: GitCleanupService) {}

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName !== "worktrees") {
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const project = await this.resolveProject(interaction);
    if (!project) {
      await interaction.editReply("No project exists yet for this channel.");
      return;
    }

    const worktrees = await this.listProjectWorktrees(project);
    await interaction.editReply({
      content: truncate(formatWorktreeList(project, worktrees), MAX_MESSAGE_LENGTH),
      components: worktreeButtons(worktrees),
    });
  }

  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const action = parseCustomId(interaction.customId);
    if (!action) {
      return false;
    }

    await interaction.deferUpdate();
    const project = await this.resolveProject(interaction);
    if (!project) {
      await interaction.editReply({ content: "No project exists yet for this channel.", components: [] });
      return true;
    }

    if (action.type === "refresh") {
      const worktrees = await this.listProjectWorktrees(project);
      await interaction.editReply({
        content: truncate(formatWorktreeList(project, worktrees), MAX_MESSAGE_LENGTH),
        components: worktreeButtons(worktrees),
      });
      return true;
    }

    if (action.type === "details") {
      const details = await this.cleanup.getWorktreeDetails(action.taskId);
      const worktrees = await this.listProjectWorktrees(project);
      await interaction.editReply({
        content: truncate(formatDetails(project, details), MAX_MESSAGE_LENGTH),
        components: worktreeButtons(worktrees),
      });
      return true;
    }

    const result =
      action.type === "cleanup-merged"
        ? await this.cleanup.cleanupMergedWorktrees()
        : action.type === "cleanup-abandoned"
          ? await this.cleanup.cleanupAbandonedWorktrees()
          : await this.cleanup.pruneMissingWorktreeRecords();
    const candidates = result.candidates.filter((worktree) => worktree.projectId === project.id);
    const worktrees = await this.listProjectWorktrees(project);
    await interaction.editReply({
      content: truncate(formatDryRun(project, action.type, result.message, candidates), MAX_MESSAGE_LENGTH),
      components: worktreeButtons(worktrees),
    });
    return true;
  }

  private async listProjectWorktrees(project: Project): Promise<GitCleanupWorktree[]> {
    return (await this.cleanup.listWorktrees()).filter((worktree) => worktree.projectId === project.id);
  }

  private async resolveProject(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<Project | null> {
    if (!interaction.guildId) {
      return null;
    }
    const projectChannel = await resolveProjectChannel(interaction);
    return this.projects.getByGuildChannel(interaction.guildId, projectChannel.id);
  }
}

function worktreeButtons(worktrees: GitCleanupWorktree[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gitclean:refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gitclean:cleanup-merged").setLabel("Cleanup Merged").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("gitclean:cleanup-abandoned").setLabel("Cleanup Abandoned").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("gitclean:prune-missing").setLabel("Prune Missing").setStyle(ButtonStyle.Secondary),
    ),
  ];

  const details = worktrees.slice(0, MAX_DETAIL_BUTTONS);
  if (details.length > 0) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        details.map((worktree) =>
          new ButtonBuilder()
            .setCustomId(`gitclean:details:${worktree.taskId}`)
            .setLabel(`Details #${worktree.projectTaskNumber}`)
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    );
  }

  return rows;
}

function formatWorktreeList(project: Project, worktrees: GitCleanupWorktree[]): string {
  const staleCount = worktrees.filter((worktree) => worktree.stale).length;
  const missingCount = worktrees.filter((worktree) => worktree.missing).length;
  const dirtyCount = worktrees.filter((worktree) => worktree.hasUncommittedChanges).length;
  const lines = worktrees.slice(0, MAX_LISTED_WORKTREES).map(formatWorktreeLine);
  const overflow = worktrees.length > MAX_LISTED_WORKTREES ? `\n...and ${worktrees.length - MAX_LISTED_WORKTREES} more.` : "";

  return `Worktrees for ${project.projectName}
Known: ${worktrees.length} | stale: ${staleCount} | missing: ${missingCount} | dirty: ${dirtyCount}

${lines.length > 0 ? lines.join("\n") : "No task worktrees recorded."}${overflow}`;
}

function formatDryRun(project: Project, action: CleanupAction, message: string, candidates: GitCleanupWorktree[]): string {
  const actionLabel =
    action === "cleanup-merged" ? "Cleanup Merged" : action === "cleanup-abandoned" ? "Cleanup Abandoned" : "Prune Missing";
  const lines = candidates.slice(0, MAX_LISTED_WORKTREES).map(formatWorktreeLine);
  const overflow = candidates.length > MAX_LISTED_WORKTREES ? `\n...and ${candidates.length - MAX_LISTED_WORKTREES} more.` : "";

  return `${actionLabel} dry run for ${project.projectName}
${message}

Would affect: ${candidates.length}
${lines.length > 0 ? lines.join("\n") : "No matching worktrees."}${overflow}`;
}

function formatDetails(project: Project, details: GitWorktreeDetails | null): string {
  if (!details || details.projectId !== project.id) {
    return `Worktree details for ${project.projectName}
Task not found for this project.`;
  }

  return `Worktree details for #${details.projectTaskNumber} (task ${details.taskId})
Status: ${details.status}
Branch: ${details.branch ?? "not recorded"}
Current branch: ${details.currentBranch ?? "unknown"}
HEAD: ${details.head ?? "unknown"}
Path: ${details.worktreePath}
Exists: ${details.exists ? "yes" : "no"}
Stale: ${details.stale ? "yes" : "no"}
Missing: ${details.missing ? "yes" : "no"}
Uncommitted changes: ${formatDirty(details)}
${details.inspectError ? `Inspect error: ${details.inspectError}` : ""}`;
}

function formatWorktreeLine(worktree: GitCleanupWorktree): string {
  const badges = [
    worktree.stale ? "stale" : null,
    worktree.missing ? "missing" : null,
    worktree.hasUncommittedChanges ? "dirty" : null,
  ].filter(Boolean);
  const suffix = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
  return `#${worktree.projectTaskNumber} task ${worktree.taskId} ${worktree.status}${suffix} ${worktree.branch ?? "no-branch"}\n${shortPath(
    worktree.worktreePath,
  )}`;
}

function formatDirty(worktree: GitCleanupWorktree): string {
  if (worktree.hasUncommittedChanges === null) {
    return "unknown";
  }
  if (!worktree.hasUncommittedChanges) {
    return "no";
  }
  return `yes${worktree.uncommittedSummary ? `\n${worktree.uncommittedSummary}` : ""}`;
}

function parseCustomId(
  customId: string,
): { type: "refresh" } | { type: CleanupAction } | { type: "details"; taskId: number } | null {
  if (customId === "gitclean:refresh") {
    return { type: "refresh" };
  }
  if (customId === "gitclean:cleanup-merged") {
    return { type: "cleanup-merged" };
  }
  if (customId === "gitclean:cleanup-abandoned") {
    return { type: "cleanup-abandoned" };
  }
  if (customId === "gitclean:prune-missing") {
    return { type: "prune-missing" };
  }
  const details = /^gitclean:details:(\d+)$/.exec(customId);
  return details ? { type: "details", taskId: Number(details[1]) } : null;
}

async function resolveProjectChannel(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<{ id: string; name: string }> {
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

function channelName(channel: Channel): string {
  return "name" in channel && typeof channel.name === "string" && channel.name.trim() ? channel.name : channel.id;
}

function shortPath(value: string): string {
  if (value.length <= 120) {
    return value;
  }
  return `${value.slice(0, 58)}...${value.slice(-59)}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 14)}...[truncated]`;
}
