import type { Project } from "../types.js";
import { AgentFleetPlanValidator } from "./AgentFleetPlanValidator.js";
import type { OrchestrationAgentsRepo } from "./repos/OrchestrationAgentsRepo.js";
import type { OrchestrationMessagesRepo } from "./repos/OrchestrationMessagesRepo.js";
import type { OrchestrationsRepo } from "./repos/OrchestrationsRepo.js";
import type { Orchestration, OrchestrationStatus, OrchestrationView } from "./types.js";

export class OrchestrationService {
  private readonly validator = new AgentFleetPlanValidator();

  constructor(
    private readonly orchestrations: OrchestrationsRepo,
    private readonly agents: OrchestrationAgentsRepo,
    private readonly messages: OrchestrationMessagesRepo,
  ) {}

  createOrchestration(project: Project, author: { id: string }, goal: string): Orchestration {
    const orchestration = this.orchestrations.create({
      projectId: project.id,
      authorUserId: author.id,
      goal,
      plannerEffort: "high",
      minAgents: 2,
      maxAgents: 10,
      autoStartChildren: true,
    });
    return this.orchestrations.updateStatus(orchestration.id, "draft_created");
  }

  appendUserMessage(
    orchestrationId: number,
    message: { content: string; discordMessageId?: string | null; authorUserId?: string | null },
  ): void {
    this.messages.create(orchestrationId, "user", message.content, {
      discordMessageId: message.discordMessageId ?? null,
      authorUserId: message.authorUserId ?? null,
    });
    const orchestration = this.requireOrchestration(orchestrationId);
    if (isConversationState(orchestration.status)) {
      this.orchestrations.updateStatus(orchestrationId, "refining_plan");
    }
  }

  cancelOrchestration(orchestrationId: number): Orchestration {
    this.messages.create(orchestrationId, "system", "Orchestration canceled.");
    return this.orchestrations.updateStatus(orchestrationId, "CANCELED");
  }

  launchOrchestration(orchestrationId: number): Orchestration {
    const orchestration = this.requireOrchestration(orchestrationId);
    if (!orchestration.finalPlanJson) {
      throw new Error(`Orchestration #${orchestrationId} does not have a final AgentFleetPlan yet.`);
    }
    const validation = this.validator.validateForOrchestration(orchestration.finalPlanJson, orchestration);
    if (!validation.ok) {
      throw new Error(`AgentFleetPlan is invalid:\n${validation.errors.join("\n")}`);
    }
    return this.orchestrations.updateStatus(orchestrationId, "LAUNCHING_AGENTS");
  }

  updateParentStatusPanel(_orchestrationId: number): void {
    // Discord-specific panel editing is handled by OrchestrationControlPanel.
  }

  getOrchestrationView(orchestrationId: number): OrchestrationView {
    const orchestration = this.requireOrchestration(orchestrationId);
    return {
      orchestration,
      agents: this.agents.listByOrchestrationId(orchestrationId),
      messages: this.messages.listByOrchestrationId(orchestrationId),
    };
  }

  updateStatus(orchestrationId: number, status: OrchestrationStatus): Orchestration {
    return this.orchestrations.updateStatus(orchestrationId, status);
  }

  updateCardIds(orchestrationId: number, parentCardId: string | null, borderCardId: string | null): Orchestration {
    return this.orchestrations.updateCardIds(orchestrationId, parentCardId, borderCardId);
  }

  updateThread(orchestrationId: number, threadId: string, threadUrl: string | null): Orchestration {
    return this.orchestrations.updateThread(orchestrationId, threadId, threadUrl);
  }

  updateControlPanelMessageId(orchestrationId: number, messageId: string | null): Orchestration {
    return this.orchestrations.updateControlPanelMessageId(orchestrationId, messageId);
  }

  updateBounds(orchestrationId: number, minAgents: number, maxAgents: number): Orchestration {
    const min = clamp(minAgents, 2, 10);
    const max = clamp(maxAgents, 2, 10);
    return this.orchestrations.updateBounds(orchestrationId, Math.min(min, max), Math.max(min, max));
  }

  private requireOrchestration(orchestrationId: number): Orchestration {
    const orchestration = this.orchestrations.findById(orchestrationId);
    if (!orchestration) {
      throw new Error(`Orchestration #${orchestrationId} not found.`);
    }
    return orchestration;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isConversationState(status: OrchestrationStatus): boolean {
  return [
    "WAITING_USER",
    "ready_for_approval",
    "asking_questions",
    "waiting_for_user_choice",
    "refining_plan",
    "draft_created",
    "PLANNING",
  ].includes(status);
}
