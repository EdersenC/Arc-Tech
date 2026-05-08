import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type AnyThreadChannel,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
} from "discord.js";
import { AgentFleetPlanValidator } from "./AgentFleetPlanValidator.js";
import { chunkDiscordMessage, OrchestrationStatusRenderer } from "./OrchestrationStatusRenderer.js";
import type { OrchestrationAgentSpawner } from "./OrchestrationAgentSpawner.js";
import type { OrchestrationPlannerService } from "./OrchestrationPlannerService.js";
import type { OrchestrationService } from "./OrchestrationService.js";
import type { OrchestrationAgentsRepo } from "./repos/OrchestrationAgentsRepo.js";
import type { OrchestrationsRepo } from "./repos/OrchestrationsRepo.js";
import type { Orchestration } from "./types.js";

type OrchestrationButtonAction =
  | "ask"
  | "show-plan"
  | "improve-plan"
  | "set-bounds"
  | "launch"
  | "cancel"
  | "agent-status"
  | "summarize"
  | "pause-fleet"
  | "cancel-fleet"
  | "spawn-extra";

export class OrchestrationControlPanel {
  private readonly renderer = new OrchestrationStatusRenderer();
  private readonly validator = new AgentFleetPlanValidator();

  constructor(
    private readonly client: Client,
    private readonly orchestrations: OrchestrationsRepo,
    private readonly agents: OrchestrationAgentsRepo,
    private readonly service: OrchestrationService,
    private readonly planner: OrchestrationPlannerService,
    private readonly spawner: OrchestrationAgentSpawner,
  ) {}

  async sendControlPanel(orchestration: Orchestration): Promise<void> {
    const thread = await this.getParentThread(orchestration);
    if (!thread) return;
    const message = await thread.send({
      content: this.renderer.renderDashboard(this.service.getOrchestrationView(orchestration.id)),
      components: buttonRows(orchestration),
    });
    this.service.updateControlPanelMessageId(orchestration.id, message.id);
  }

  async updateControlPanel(orchestrationId: number): Promise<void> {
    const orchestration = this.orchestrations.findById(orchestrationId);
    if (!orchestration) return;
    if (!orchestration.controlPanelMessageId) {
      await this.sendControlPanel(orchestration);
      return;
    }
    const thread = await this.getParentThread(orchestration);
    if (!thread || !("messages" in thread)) return;
    const message = await thread.messages.fetch(orchestration.controlPanelMessageId).catch(() => null);
    if (!message) {
      await this.sendControlPanel(orchestration);
      return;
    }
    await message.edit({
      content: this.renderer.renderDashboard(this.service.getOrchestrationView(orchestration.id)),
      components: buttonRows(orchestration),
    });
  }

  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const parsed = parseButtonCustomId(interaction.customId);
    if (!parsed) return false;
    const orchestration = this.orchestrations.findById(parsed.orchestrationId);
    if (!orchestration) {
      await interaction.reply({ content: `Orchestration #${parsed.orchestrationId} does not exist.`, flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!isAllowed(interaction, orchestration)) {
      await interaction.reply({ content: `You are not allowed to control orchestration #${orchestration.id}.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (parsed.action === "ask") {
      await interaction.showModal(askPlannerModal(orchestration.id));
      return true;
    }
    if (parsed.action === "set-bounds") {
      await interaction.showModal(boundsModal(orchestration));
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (parsed.action === "show-plan") {
      await this.replyWithChunks(interaction, await this.planner.showCurrentPlan(orchestration.id));
      return true;
    }
    if (parsed.action === "improve-plan") {
      const response = await this.planner.improvePlan(orchestration.id);
      await this.postToParent(orchestration.id, response);
      await this.updateControlPanel(orchestration.id);
      await interaction.editReply("Planner improved the current plan in the parent thread.");
      return true;
    }
    if (parsed.action === "launch") {
      await this.launch(interaction, orchestration);
      return true;
    }
    if (parsed.action === "cancel" || parsed.action === "cancel-fleet") {
      this.service.cancelOrchestration(orchestration.id);
      await this.updateControlPanel(orchestration.id);
      await interaction.editReply(`Orchestration #${orchestration.id} canceled. Already-spawned child tasks were not canceled automatically.`);
      return true;
    }
    if (parsed.action === "agent-status") {
      await this.replyWithChunks(interaction, this.renderer.renderDashboard(this.service.getOrchestrationView(orchestration.id)));
      return true;
    }
    if (parsed.action === "summarize") {
      await this.replyWithChunks(interaction, this.renderer.renderFinalSummary(orchestration, this.agents.listByOrchestrationId(orchestration.id)));
      return true;
    }
    await interaction.editReply(`${parsed.action} is reserved for the future web/control workflow.`);
    return true;
  }

  async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
    const ask = /^orch:ask-modal:(\d+)$/.exec(interaction.customId);
    if (ask) {
      const orchestrationId = Number(ask[1]);
      const orchestration = this.orchestrations.findById(orchestrationId);
      if (!orchestration) {
        await interaction.reply({ content: `Orchestration #${orchestrationId} does not exist.`, flags: MessageFlags.Ephemeral });
        return true;
      }
      if (!isAllowed(interaction, orchestration)) {
        await interaction.reply({ content: `You are not allowed to control orchestration #${orchestration.id}.`, flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const content = interaction.fields.getTextInputValue("message").trim();
      this.service.appendUserMessage(orchestrationId, {
        content,
        discordMessageId: null,
        authorUserId: interaction.user.id,
      });
      const response = await this.planner.continuePlanner(orchestrationId, content);
      await this.postToParent(orchestrationId, response);
      await this.updateControlPanel(orchestrationId);
      await interaction.editReply("Planner replied in the parent orchestration thread.");
      return true;
    }

    const bounds = /^orch:set-bounds-modal:(\d+)$/.exec(interaction.customId);
    if (bounds) {
      const orchestrationId = Number(bounds[1]);
      const orchestration = this.orchestrations.findById(orchestrationId);
      if (!orchestration) {
        await interaction.reply({ content: `Orchestration #${orchestrationId} does not exist.`, flags: MessageFlags.Ephemeral });
        return true;
      }
      if (!isAllowed(interaction, orchestration)) {
        await interaction.reply({ content: `You are not allowed to control orchestration #${orchestration.id}.`, flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const min = Number.parseInt(interaction.fields.getTextInputValue("min_agents"), 10);
      const max = Number.parseInt(interaction.fields.getTextInputValue("max_agents"), 10);
      const updated = this.service.updateBounds(orchestrationId, Number.isFinite(min) ? min : 2, Number.isFinite(max) ? max : 10);
      await this.updateControlPanel(orchestrationId);
      await interaction.editReply(`Bounds set to ${updated.minAgents}-${updated.maxAgents}.`);
      return true;
    }

    return false;
  }

  async postToParent(orchestrationId: number, content: string): Promise<void> {
    const orchestration = this.orchestrations.findById(orchestrationId);
    if (!orchestration) return;
    const thread = await this.getParentThread(orchestration);
    if (!thread) return;
    for (const chunk of chunkDiscordMessage(content)) {
      await thread.send(chunk);
    }
  }

  private async launch(interaction: ButtonInteraction, orchestration: Orchestration): Promise<void> {
    let current = this.orchestrations.findById(orchestration.id) ?? orchestration;
    if (!current.finalPlanJson) {
      const generated = await this.planner.generateFleetPlan(current.id);
      if (!generated.validJson) {
        const repaired = await this.planner.repairFleetPlan(current.id, generated.raw, generated.errors);
        if (!repaired.validJson) {
          this.service.updateStatus(current.id, "WAITING_USER");
          await this.postToParent(current.id, `AgentFleetPlan validation failed:\n${repaired.errors.map((error) => `- ${error}`).join("\n")}`);
          await this.updateControlPanel(current.id);
          await interaction.editReply("Planner could not produce a valid fleet plan. Validation errors were posted in the parent thread.");
          return;
        }
      }
      current = this.orchestrations.findById(current.id) ?? current;
    }

    const validation = this.validator.validateForOrchestration(current.finalPlanJson ?? "", current);
    if (!validation.ok) {
      this.service.updateStatus(current.id, "WAITING_USER");
      await this.postToParent(current.id, `AgentFleetPlan validation failed:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`);
      await this.updateControlPanel(current.id);
      await interaction.editReply("Fleet plan is invalid. Validation errors were posted in the parent thread.");
      return;
    }

    await this.spawner.spawnAgentsFromPlan(current.id);
    await interaction.editReply(`Orchestration #${current.id} launched.`);
  }

  private async replyWithChunks(interaction: ButtonInteraction, content: string): Promise<void> {
    const chunks = chunkDiscordMessage(content);
    await interaction.editReply(chunks.shift() ?? "No content.");
    for (const chunk of chunks) {
      await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
    }
  }

  private async getParentThread(orchestration: Orchestration): Promise<AnyThreadChannel | null> {
    if (!orchestration.discordThreadId) return null;
    const channel = await this.client.channels.fetch(orchestration.discordThreadId).catch(() => null);
    return channel?.isThread() ? channel : null;
  }
}

function buttonRows(orchestration: Orchestration): ActionRowBuilder<ButtonBuilder>[] {
  const closed = orchestration.status === "CANCELED" || orchestration.status === "COMPLETED" || orchestration.status === "FAILED";
  const launched = orchestration.status === "LAUNCHING_AGENTS" || orchestration.status === "RUNNING_AGENTS" || orchestration.status === "WAITING_REVIEW";
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`orch:ask:${orchestration.id}`).setLabel("Ask Planner").setStyle(ButtonStyle.Primary).setDisabled(closed),
      new ButtonBuilder().setCustomId(`orch:show-plan:${orchestration.id}`).setLabel("Show Plan").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`orch:improve-plan:${orchestration.id}`)
        .setLabel("Improve Plan")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(closed || launched),
      new ButtonBuilder()
        .setCustomId(`orch:set-bounds:${orchestration.id}`)
        .setLabel("Set Bounds")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(closed || launched),
      new ButtonBuilder()
        .setCustomId(`orch:launch:${orchestration.id}`)
        .setLabel("Orchestrate")
        .setStyle(ButtonStyle.Success)
        .setDisabled(closed || launched),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`orch:agent-status:${orchestration.id}`)
        .setLabel("Show Agent Status")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!launched),
      new ButtonBuilder()
        .setCustomId(`orch:summarize:${orchestration.id}`)
        .setLabel("Summarize Results")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!launched),
      new ButtonBuilder()
        .setCustomId(`orch:pause-fleet:${orchestration.id}`)
        .setLabel("Pause Fleet")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`orch:spawn-extra:${orchestration.id}`)
        .setLabel("Spawn Extra Agent")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`orch:cancel:${orchestration.id}`)
        .setLabel(launched ? "Cancel Fleet" : "Cancel")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(closed),
    ),
  ];
}

function askPlannerModal(orchestrationId: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`orch:ask-modal:${orchestrationId}`)
    .setTitle("Ask Planner")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("message")
          .setLabel("Message")
          .setRequired(true)
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1800),
      ),
    );
}

function boundsModal(orchestration: Orchestration): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`orch:set-bounds-modal:${orchestration.id}`)
    .setTitle("Set Agent Bounds")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("min_agents")
          .setLabel("Minimum agents")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setValue(String(orchestration.minAgents)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("max_agents")
          .setLabel("Maximum agents")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setValue(String(orchestration.maxAgents)),
      ),
    );
}

function parseButtonCustomId(customId: string): { action: OrchestrationButtonAction; orchestrationId: number } | null {
  const match =
    /^orch:(ask|show-plan|improve-plan|set-bounds|launch|cancel|agent-status|summarize|pause-fleet|cancel-fleet|spawn-extra):(\d+)$/.exec(
      customId,
    );
  if (!match) return null;
  return { action: match[1] as OrchestrationButtonAction, orchestrationId: Number(match[2]) };
}

function isAllowed(interaction: ButtonInteraction | ModalSubmitInteraction, orchestration: Orchestration): boolean {
  if (interaction.user.id === orchestration.authorUserId) {
    return true;
  }
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  );
}
