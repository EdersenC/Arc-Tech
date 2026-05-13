import type { CodexRunner } from "../codexRunner.js";
import type { GitManager } from "../git.js";
import type { ProjectStore } from "../stores.js";
import { DEFAULT_MODEL, type Effort } from "../types.js";
import { AgentFleetPlanValidator, stableJson } from "./AgentFleetPlanValidator.js";
import type { OrchestrationMessagesRepo } from "./repos/OrchestrationMessagesRepo.js";
import type { OrchestrationsRepo } from "./repos/OrchestrationsRepo.js";
import type { Orchestration, OrchestrationMessage } from "./types.js";

const PLANNER_SYSTEM_PROMPT = `You are the planner/orchestrator agent for a Discord-launched Codex workflow.
Your job is to interview the user, clarify requirements, propose architecture, and split the final plan into 2-10 child implementation agents.
Do not edit code.
Do not implement.
Ask questions when needed.
Offer concrete options the user can pick from.
Keep a current plan.
Only produce strict AgentFleetPlan JSON when explicitly asked by the app during launch.
Each child agent must have a clear objective, prompt, and acceptance criteria.
Make child agents as independent as practical to reduce merge conflicts.
Prefer agents that own different files/modules.
Include integration strategy and shared context.`;

export interface PlannerRunOptions {
  extraInstructions?: string;
  metadata?: unknown;
}

export class OrchestrationPlannerService {
  private readonly validator = new AgentFleetPlanValidator();

  constructor(
    private readonly orchestrations: OrchestrationsRepo,
    private readonly messages: OrchestrationMessagesRepo,
    private readonly projects: ProjectStore,
    private readonly git: GitManager,
    private readonly runner: CodexRunner,
  ) {}

  async startPlanner(orchestrationId: number, options: PlannerRunOptions = {}): Promise<string> {
    const orchestration = this.requireOrchestration(orchestrationId);
    this.orchestrations.updateStatus(orchestrationId, "PLANNING");
    const response = await this.runPlanner(orchestration, this.buildPlannerPrompt(orchestration, this.messages.listRecent(orchestrationId, 30), options.extraInstructions));
    this.messages.create(orchestrationId, "planner", response, { metadata: options.metadata });
    this.orchestrations.updateStatus(orchestrationId, "WAITING_USER");
    return response;
  }

  async continuePlanner(orchestrationId: number, _userMessage?: string, options: PlannerRunOptions = {}): Promise<string> {
    const orchestration = this.requireOrchestration(orchestrationId);
    this.orchestrations.updateStatus(orchestrationId, "PLANNING");
    const response = await this.runPlanner(orchestration, this.buildPlannerPrompt(orchestration, this.messages.listRecent(orchestrationId, 40), options.extraInstructions));
    this.messages.create(orchestrationId, "planner", response, { metadata: options.metadata });
    this.orchestrations.updateStatus(orchestrationId, "WAITING_USER");
    return response;
  }

  async improvePlan(orchestrationId: number): Promise<string> {
    const orchestration = this.requireOrchestration(orchestrationId);
    this.messages.create(orchestrationId, "system", "Improve the current plan based on the full conversation. Keep it conversational.");
    return this.continuePlanner(orchestrationId);
  }

  async showCurrentPlan(orchestrationId: number): Promise<string> {
    const orchestration = this.requireOrchestration(orchestrationId);
    if (orchestration.finalPlanJson) {
      return summarizeFleetPlan(orchestration.finalPlanJson);
    }
    const recent = this.messages
      .listRecent(orchestrationId, 10)
      .filter((message) => message.role === "planner")
      .at(-1);
    return recent?.content ?? "No planner response has been captured yet.";
  }

  async generateFleetPlan(orchestrationId: number, options: PlannerRunOptions = {}): Promise<{ raw: string; validJson?: string; errors: string[] }> {
    const orchestration = this.requireOrchestration(orchestrationId);
    this.orchestrations.updateStatus(orchestrationId, "PLANNING");
    const raw = await this.runPlanner(orchestration, this.buildFleetPlanPrompt(orchestration, this.messages.listRecent(orchestrationId, 80), options.extraInstructions));
    const validation = this.validator.validateForOrchestration(raw, orchestration);
    if (validation.ok && validation.json) {
      this.orchestrations.updateFinalPlan(orchestrationId, validation.json);
      this.messages.create(orchestrationId, "planner", validation.json, { metadata: { ...metadataRecord(options.metadata), fleetPlan: true } });
      return { raw, validJson: validation.json, errors: [] };
    }
    this.messages.create(orchestrationId, "planner", raw, { metadata: { ...metadataRecord(options.metadata), invalidFleetPlan: true, errors: validation.errors } });
    return { raw, errors: validation.errors };
  }

  async repairFleetPlan(orchestrationId: number, invalidJson: string, errors: string[]): Promise<{ raw: string; validJson?: string; errors: string[] }> {
    const orchestration = this.requireOrchestration(orchestrationId);
    const raw = await this.runPlanner(
      orchestration,
      `${this.buildFleetPlanPrompt(orchestration, this.messages.listRecent(orchestrationId, 80))}

The previous JSON was invalid. Repair it and output JSON only.

Validation errors:
${errors.map((error) => `- ${error}`).join("\n")}

Invalid output:
${invalidJson}`,
    );
    const validation = this.validator.validateForOrchestration(raw, orchestration);
    if (validation.ok && validation.json) {
      this.orchestrations.updateFinalPlan(orchestrationId, validation.json);
      this.messages.create(orchestrationId, "planner", validation.json, { metadata: { fleetPlan: true, repaired: true } });
      return { raw, validJson: validation.json, errors: [] };
    }
    this.orchestrations.updateStatus(orchestrationId, "WAITING_USER");
    this.messages.create(orchestrationId, "planner", raw, { metadata: { invalidFleetPlan: true, repaired: true, errors: validation.errors } });
    return { raw, errors: validation.errors };
  }

  buildPlannerPrompt(orchestration: Orchestration, history: OrchestrationMessage[], extraInstructions?: string): string {
    return `${PLANNER_SYSTEM_PROMPT}

Mode: planning conversation only. Do not emit final AgentFleetPlan JSON yet unless the app explicitly asks during launch.

Orchestration #${orchestration.id}
Goal:
${orchestration.goal}

Bounds: min_agents=${orchestration.minAgents}, max_agents=${orchestration.maxAgents}

Conversation so far:
${formatHistory(history)}

${extraInstructions ? `Additional orchestration instructions:\n${extraInstructions}\n\n` : ""}
Respond to the user with concise planning help, concrete options, and the current plan.`;
  }

  buildFleetPlanPrompt(orchestration: Orchestration, history: OrchestrationMessage[], extraInstructions?: string): string {
    return `${PLANNER_SYSTEM_PROMPT}

The app is launching the fleet now. Output strict JSON only. Do not include markdown, comments, prose, or code fences.

AgentFleetPlan schema:
{
  "orchestrationGoal": "string",
  "architectureSummary": "string",
  "agentCount": number,
  "sharedContext": "string",
  "integrationStrategy": "string",
  "agents": [
    {
      "name": "string",
      "role": "planner|implementer|tester|reviewer|refactor|docs",
      "objective": "string",
      "prompt": "string",
      "model": "optional string",
      "effort": "optional low|medium|high",
      "prTitle": "optional short pull request title",
      "dependsOn": ["optional string"],
      "expectedFiles": ["optional string"],
      "acceptanceCriteria": ["string"]
    }
  ]
}

Validation rules:
- agentCount must be at least ${Math.max(2, orchestration.minAgents)}
- agentCount must be at most ${Math.min(10, orchestration.maxAgents)}
- agentCount must equal agents.length
- every agent needs name, role, objective, prompt, and at least one acceptance criterion
- prTitle is optional, but when present it should describe that child agent's PR instead of copying the user command
- make agents as independent as practical and assign different files/modules where possible

Orchestration #${orchestration.id}
Goal:
${orchestration.goal}

Conversation:
${formatHistory(history)}

${extraInstructions ? `Additional orchestration instructions:\n${extraInstructions}\n\n` : ""}
JSON only.`;
  }

  private async runPlanner(orchestration: Orchestration, prompt: string): Promise<string> {
    const project = this.projects.getById(orchestration.projectId);
    if (!project) {
      throw new Error(`Project #${orchestration.projectId} not found.`);
    }
    await this.git.ensureProjectRepo(project);
    const result = await this.runner.runTask({
      taskId: orchestration.id,
      projectPath: project.repoPath,
      worktreePath: project.repoPath,
      taskBranch: "planner",
      prompt,
      sandbox: "read-only",
      model: orchestration.plannerModel ?? DEFAULT_MODEL,
      effort: (orchestration.plannerEffort ?? "high") as Effort,
      onEvent: () => undefined,
    });
    return result.finalSummary.trim();
  }

  private requireOrchestration(orchestrationId: number): Orchestration {
    const orchestration = this.orchestrations.findById(orchestrationId);
    if (!orchestration) {
      throw new Error(`Orchestration #${orchestrationId} not found.`);
    }
    return orchestration;
  }
}

function formatHistory(history: OrchestrationMessage[]): string {
  if (history.length === 0) {
    return "(none yet)";
  }
  return history.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function summarizeFleetPlan(value: string): string {
  try {
    const parsed = JSON.parse(value) as {
      architectureSummary?: string;
      agentCount?: number;
      sharedContext?: string;
      integrationStrategy?: string;
      agents?: Array<{ name?: string; role?: string; objective?: string; acceptanceCriteria?: string[] }>;
    };
    return stableJson({
      architectureSummary: parsed.architectureSummary,
      agentCount: parsed.agentCount,
      sharedContext: parsed.sharedContext,
      integrationStrategy: parsed.integrationStrategy,
      agents: parsed.agents?.map((agent) => ({
        name: agent.name,
        role: agent.role,
        objective: agent.objective,
        acceptanceCriteria: agent.acceptanceCriteria,
      })),
    });
  } catch {
    return value;
  }
}
