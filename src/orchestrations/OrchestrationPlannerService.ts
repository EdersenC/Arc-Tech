import type { CodexRunner } from "../codexRunner.js";
import type { GitManager } from "../git.js";
import type { ProjectStore } from "../stores.js";
import { DEFAULT_MODEL, type Effort } from "../types.js";
import { AgentFleetPlanValidator, stableJson } from "./AgentFleetPlanValidator.js";
import type { OrchestrationMessagesRepo } from "./repos/OrchestrationMessagesRepo.js";
import type { OrchestrationsRepo } from "./repos/OrchestrationsRepo.js";
import type { Orchestration, OrchestrationMessage } from "./types.js";

const PLANNER_SYSTEM_PROMPT = `You are the planner/orchestrator agent for a Discord-launched Codex workflow.
Your job is to act as the senior software architect, technical lead, workflow designer, agent coordinator, and PR/integration planner.
Do not edit code.
Do not implement.
Do not behave like a generic task splitter or passive summarizer.
Drive the design. Understand the project architecture before splitting work.
Ask only blocking questions when needed, with concrete options the user can pick from.
When the user says "enough plan", "done planning", "start work", "start agents", "launch", or equivalent, stop asking optional questions and proceed to launch readiness unless critical information is missing.
Keep a current plan with explicit phases:
1. Understand goal: restate requested outcome, repo constraints, unknowns, and whether the work is UI, backend, persistence, orchestration, runtime, PR, docs, or mixed.
2. Architecture pass: identify modules, data model, API contracts, frontend state/events, backend service boundaries, persistence/migrations, workflow graph interactions, and canvas prompt artifact interactions.
3. Interface contract pass: define source-of-truth contracts before spawning agents.
4. Agent decomposition pass: split by interface boundaries and non-overlapping ownership, not random file lists.
5. Integration strategy: identify assembly order, likely merge conflicts, final validation, and PR staging needs.
6. Launch readiness: spawn only when there is enough information or the user explicitly says the plan is enough.
Only produce strict AgentFleetPlan JSON when explicitly asked by the app during launch.
Each child agent must have a clear objective, prompt, acceptance criteria, and AgentWorkContract.
Define interfaces before assigning implementation work.
Make child agents independent by ownership boundary and contract, and prefer disjoint files/modules.
Preserve the workflow graph and canvas prompt artifact model: child agents may read workflow context but must not directly mutate WorkflowGraph or persisted prompt artifacts unless explicitly assigned by contract.
Include integration strategy, shared context, interfaceContracts, and child workContract objects.`;

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
  "interfaceContracts": [
    {
      "name": "string",
      "kind": "api|type|db|event|component|service|workflow|prompt-artifact",
      "contract": "string"
    }
  ],
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
      "acceptanceCriteria": ["string"],
      "workContract": {
        "contractVersion": "arc-agent-contract-v1",
        "orchestrationId": ${orchestration.id},
        "agentIndex": number,
        "agentName": "string",
        "role": "string",
        "objective": "string",
        "userGoal": "string",
        "sharedContext": "string",
        "ownedScope": {
          "files": ["optional string"],
          "directories": ["optional string"],
          "modules": ["optional string"],
          "responsibilities": ["string"]
        },
        "forbiddenScope": {
          "files": ["optional string"],
          "directories": ["optional string"],
          "modules": ["optional string"],
          "rules": ["string"]
        },
        "interfacesToConsume": [{"name": "string", "kind": "api|type|db|event|component|service|workflow|prompt-artifact", "contract": "string"}],
        "interfacesToProvide": [{"name": "string", "kind": "api|type|db|event|component|service|workflow|prompt-artifact", "contract": "string"}],
        "dataContracts": [{"name": "string", "ownerAgent": "optional string", "schema": "string", "compatibilityRules": ["string"]}],
        "integrationNotes": ["string"],
        "conflictAvoidanceRules": ["string"],
        "acceptanceCriteria": ["string"],
        "validationCommands": ["string"],
        "completionReportRequired": {
          "changedFiles": true,
          "contractDeviations": true,
          "newInterfaces": true,
          "validationResults": true,
          "risks": true
        }
      }
    }
  ]
}

Validation rules:
- agentCount must be at least ${Math.max(2, orchestration.minAgents)}
- agentCount must be at most ${Math.min(10, orchestration.maxAgents)}
- agentCount must equal agents.length
- every agent needs name, role, objective, prompt, and at least one acceptance criterion
- prTitle is optional, but when present it should describe that child agent's PR instead of copying the user command
- interfaceContracts should define shared API/type/db/event/component/service/workflow/prompt-artifact contracts needed by multiple agents
- every workContract should match its agent index/name/objective and should define ownedScope, forbiddenScope, consumed/provided interfaces, validationCommands, and conflictAvoidanceRules
- make agents as independent as practical and assign different files/modules where possible
- if one agent must own integration, name it explicitly and make sibling agents consume its interfaces instead of editing the same files

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
      interfaceContracts?: unknown[];
      agents?: Array<{ name?: string; role?: string; objective?: string; acceptanceCriteria?: string[] }>;
    };
    return stableJson({
      architectureSummary: parsed.architectureSummary,
      agentCount: parsed.agentCount,
      sharedContext: parsed.sharedContext,
      integrationStrategy: parsed.integrationStrategy,
      interfaceContracts: parsed.interfaceContracts,
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
