import type { TaskService } from "../tasks/TaskService.js";
import type { TaskStore } from "../stores.js";
import { DEFAULT_MODEL, type Effort, type Task } from "../types.js";
import { AgentFleetPlanValidator } from "./AgentFleetPlanValidator.js";
import type { OrchestrationAgentsRepo } from "./repos/OrchestrationAgentsRepo.js";
import type { OrchestrationsRepo } from "./repos/OrchestrationsRepo.js";
import { OrchestrationStatusRenderer } from "./OrchestrationStatusRenderer.js";
import type { AgentFleetPlan, AgentFleetPlanAgent, Orchestration, OrchestrationAgent } from "./types.js";

export interface ChildTaskRoomInput {
  task: Task;
  title: string;
  message: string;
}

export interface ChildTaskRoomResult {
  threadId: string;
  threadUrl: string | null;
}

export interface OrchestrationAgentSpawnAdapter {
  createChildTaskRoom(input: ChildTaskRoomInput): Promise<ChildTaskRoomResult>;
  sendChildControlPanel(task: Task): Promise<void>;
  startChildTask(task: Task): Promise<void>;
  postToParent(orchestration: Orchestration, content: string): Promise<void>;
  updateParentControlPanel(orchestrationId: number): Promise<void>;
}

export class OrchestrationAgentSpawner {
  private readonly validator = new AgentFleetPlanValidator();
  private readonly renderer: OrchestrationStatusRenderer;

  constructor(
    private readonly orchestrations: OrchestrationsRepo,
    private readonly agents: OrchestrationAgentsRepo,
    private readonly tasks: TaskStore,
    private readonly taskService: TaskService,
    private readonly adapter: OrchestrationAgentSpawnAdapter,
  ) {
    this.renderer = new OrchestrationStatusRenderer(this.tasks);
  }

  async spawnAgentsFromPlan(orchestrationId: number): Promise<OrchestrationAgent[]> {
    const orchestration = requireValue(this.orchestrations.findById(orchestrationId), `Orchestration #${orchestrationId} not found.`);
    if (!orchestration.finalPlanJson) {
      throw new Error(`Orchestration #${orchestrationId} has no final AgentFleetPlan JSON.`);
    }
    const validation = this.validator.validateForOrchestration(orchestration.finalPlanJson, orchestration);
    if (!validation.ok || !validation.plan) {
      throw new Error(`AgentFleetPlan is invalid:\n${validation.errors.join("\n")}`);
    }

    this.orchestrations.updateStatus(orchestrationId, "LAUNCHING_AGENTS");
    this.agents.createMany(orchestrationId, validation.plan.agents);
    const created: OrchestrationAgent[] = [];
    for (const planned of this.agents.listByOrchestrationId(orchestrationId)) {
      const updated = await this.createChildTaskForAgent(orchestration, validation.plan, planned);
      created.push(updated);
    }

    this.orchestrations.markLaunched(orchestrationId);
    await this.postSpawnedAgentsMessage(orchestrationId);
    await this.adapter.updateParentControlPanel(orchestrationId);
    return created;
  }

  async createChildTaskForAgent(
    orchestration: Orchestration,
    fleetPlan: AgentFleetPlan,
    agent: OrchestrationAgent,
  ): Promise<OrchestrationAgent> {
    if (agent.childTaskId) {
      return agent;
    }
    const project = this.taskService.getProject(orchestration.projectId);
    if (!project) {
      throw new Error(`Project #${orchestration.projectId} not found.`);
    }
    const planAgent = fleetPlan.agents[agent.agentIndex - 1];
    if (!planAgent) {
      throw new Error(`Fleet plan is missing agent index ${agent.agentIndex}.`);
    }
    const branchName = this.generateBranchName(orchestration.id, agent.agentIndex, agent.agentName);
    const worktreeName = `orch-${orchestration.id}-agent-${agent.agentIndex}-${slugify(agent.agentName)}`;
    const childPrompt = this.buildChildTaskPrompt(orchestration, fleetPlan, planAgent, agent.agentIndex, branchName);
    let task = this.taskService.createImplementationTask({
      project,
      prompt: childPrompt,
      requestedBy: orchestration.authorUserId,
      mode: "implement",
      sandbox: "workspace-write",
      model: planAgent.model ?? DEFAULT_MODEL,
      effort: planAgent.effort ?? ("medium" as Effort),
      parentOrchestrationId: orchestration.id,
      orchestrationAgentId: agent.id,
      agentRole: planAgent.role,
    });
    task = await this.taskService.createOrRefreshWorktree(project, task, { branchName, worktreeName });
    if (!task.worktreePath) {
      throw new Error(`Task #${task.id} did not get a worktree path for orchestration agent #${agent.id}.`);
    }
    this.agents.updateChildTask(agent.id, task.id);
    this.agents.updateBranch(agent.id, branchName, task.worktreePath);

    const title = `Agent #${agent.agentIndex} / Task #${task.id} - ${agent.agentName}`;
    const room = await this.adapter.createChildTaskRoom({ task, title, message: childThreadMessage(orchestration, agent, task, childPrompt) });
    task = this.tasks.update(task.id, {
      discordThreadId: room.threadId,
      discordThreadUrl: room.threadUrl,
      status: orchestration.autoStartChildren ? "QUEUED" : "PENDING_START",
    });
    this.agents.updateThread(agent.id, room.threadId, room.threadUrl);
    this.tasks.enqueueUserMessage({
      taskId: task.id,
      discordMessageId: null,
      discordAuthorId: orchestration.authorUserId,
      content: childPrompt,
    });
    await this.adapter.sendChildControlPanel(task);
    if (orchestration.autoStartChildren) {
      this.agents.updateStatus(agent.id, "queued");
      await this.adapter.startChildTask(task);
    }
    return requireValue(this.agents.findById(agent.id), `Orchestration agent #${agent.id} not found after spawn.`);
  }

  buildChildTaskPrompt(
    orchestration: Orchestration,
    fleetPlan: AgentFleetPlan,
    agent: AgentFleetPlanAgent,
    index: number,
    branchName: string,
  ): string {
    return `You are child implementation agent ${index} for orchestration #${orchestration.id}.

Agent name:
${agent.name}

Role:
${agent.role}

Objective:
${agent.objective}

Shared context:
${fleetPlan.sharedContext}

Integration strategy:
${fleetPlan.integrationStrategy}

Depends on:
${agent.dependsOn?.length ? agent.dependsOn.join("\n") : "None"}

Expected files:
${agent.expectedFiles?.length ? agent.expectedFiles.join("\n") : "Not specified"}

Suggested PR title:
${agent.prTitle ?? `${agent.name}: ${agent.objective}`.slice(0, 100)}

Acceptance criteria:
${agent.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}

Branch:
${branchName}

Detailed prompt:
${agent.prompt}

Rules:
- Work only on your assigned objective.
- Avoid unrelated refactors.
- Keep changes mergeable with sibling agents.
- Do not modify files outside your scope unless necessary.
- Do not merge your branch.
- Do not run git add, git commit, git push, or gh pr create.
- The TypeScript runner owns committing, pushing, and pull request creation after your run exits.
- Do not delete sibling worktrees.
- Do not change branches.
- Run relevant tests if available.
- End with a concise completion summary:
  - what changed
  - files changed
  - tests run
  - known risks
  - branch
  - PR title: <short descriptive title>`;
  }

  generateBranchName(orchestrationId: number, agentIndex: number, agentName: string): string {
    return `codex/orch-${orchestrationId}/agent-${agentIndex}-${slugify(agentName)}`;
  }

  async postSpawnedAgentsMessage(orchestrationId: number): Promise<void> {
    const orchestration = requireValue(this.orchestrations.findById(orchestrationId), `Orchestration #${orchestrationId} not found.`);
    const agents = this.agents.listByOrchestrationId(orchestrationId);
    await this.adapter.postToParent(orchestration, this.renderer.renderSpawnedAgents(agents));
  }
}

function childThreadMessage(orchestration: Orchestration, agent: OrchestrationAgent, task: Task, prompt: string): string {
  return `Child Agent Control Room
Parent orchestration: #${orchestration.id}
Agent index: ${agent.agentIndex}
Agent name: ${agent.agentName}
Role: ${agent.role}
Task: #${task.id}
Branch: ${task.taskBranch ?? "not created"}
Worktree: ${task.worktreePath ?? "not created"}

${prompt}`;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "agent";
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}
