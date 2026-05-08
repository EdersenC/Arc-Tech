import type Database from "better-sqlite3";
import type { Effort } from "../../types.js";
import type {
  AgentFleetPlanAgent,
  OrchestrationAgent,
  OrchestrationAgentStatus,
} from "../types.js";

type OrchestrationAgentRow = {
  id: number;
  orchestration_id: number;
  child_task_id: number | null;
  agent_index: number;
  agent_name: string;
  role: string;
  prompt: string;
  model: string | null;
  effort: Effort | null;
  status: OrchestrationAgentStatus;
  branch_name: string | null;
  worktree_path: string | null;
  discord_thread_id: string | null;
  discord_thread_url: string | null;
  pr_url: string | null;
  completion_summary: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export class OrchestrationAgentsRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    orchestrationId: number;
    agentIndex: number;
    agentName: string;
    role: string;
    prompt: string;
    model?: string | null;
    effort?: Effort | null;
    status?: OrchestrationAgentStatus;
  }): OrchestrationAgent {
    this.db
      .prepare(
        `
        INSERT INTO orchestration_agents (
          orchestration_id,
          agent_index,
          agent_name,
          role,
          prompt,
          model,
          effort,
          status
        )
        VALUES (
          @orchestrationId,
          @agentIndex,
          @agentName,
          @role,
          @prompt,
          @model,
          @effort,
          @status
        )
        ON CONFLICT(orchestration_id, agent_index) DO UPDATE SET
          agent_name = excluded.agent_name,
          role = excluded.role,
          prompt = excluded.prompt,
          model = excluded.model,
          effort = excluded.effort
      `,
      )
      .run({
        orchestrationId: input.orchestrationId,
        agentIndex: input.agentIndex,
        agentName: input.agentName,
        role: input.role,
        prompt: input.prompt,
        model: input.model ?? null,
        effort: input.effort ?? null,
        status: input.status ?? "planned",
      });
    const agent = this.findByOrchestrationIndex(input.orchestrationId, input.agentIndex);
    if (!agent) {
      throw new Error("Orchestration agent could not be loaded after insert.");
    }
    return agent;
  }

  createMany(orchestrationId: number, agents: AgentFleetPlanAgent[]): OrchestrationAgent[] {
    const created: OrchestrationAgent[] = [];
    const tx = this.db.transaction(() => {
      agents.forEach((agent, index) => {
        created.push(
          this.create({
            orchestrationId,
            agentIndex: index + 1,
            agentName: agent.name,
            role: agent.role,
            prompt: agent.prompt,
            model: agent.model ?? null,
            effort: agent.effort ?? null,
          }),
        );
      });
    });
    tx();
    return created;
  }

  listByOrchestrationId(orchestrationId: number): OrchestrationAgent[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestration_agents WHERE orchestration_id = ? ORDER BY agent_index ASC")
      .all(orchestrationId) as OrchestrationAgentRow[];
    return rows.map(mapAgent);
  }

  findById(id: number): OrchestrationAgent | null {
    const row = this.db.prepare("SELECT * FROM orchestration_agents WHERE id = ?").get(id) as OrchestrationAgentRow | undefined;
    return row ? mapAgent(row) : null;
  }

  findByChildTaskId(taskId: number): OrchestrationAgent | null {
    const row = this.db
      .prepare("SELECT * FROM orchestration_agents WHERE child_task_id = ?")
      .get(taskId) as OrchestrationAgentRow | undefined;
    return row ? mapAgent(row) : null;
  }

  updateChildTask(agentId: number, childTaskId: number): OrchestrationAgent {
    return this.update(agentId, { childTaskId, status: "created" });
  }

  updateStatus(agentId: number, status: OrchestrationAgentStatus): OrchestrationAgent {
    const timestampColumn =
      status === "running" || status === "queued"
        ? ", started_at = COALESCE(started_at, CURRENT_TIMESTAMP)"
        : status === "done" || status === "failed" || status === "canceled"
          ? ", completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)"
          : "";
    this.db
      .prepare(`UPDATE orchestration_agents SET status = ?${timestampColumn} WHERE id = ?`)
      .run(status, agentId);
    return requireAgent(this.findById(agentId), agentId);
  }

  updateThread(agentId: number, threadId: string | null, threadUrl: string | null): OrchestrationAgent {
    return this.update(agentId, { discordThreadId: threadId, discordThreadUrl: threadUrl });
  }

  updateBranch(agentId: number, branchName: string, worktreePath: string): OrchestrationAgent {
    return this.update(agentId, { branchName, worktreePath });
  }

  updateCompletion(
    agentId: number,
    completion: { status: OrchestrationAgentStatus; prUrl?: string | null; completionSummary?: string | null },
  ): OrchestrationAgent {
    this.db
      .prepare(
        `
        UPDATE orchestration_agents
        SET status = @status,
            pr_url = COALESCE(@prUrl, pr_url),
            completion_summary = COALESCE(@completionSummary, completion_summary),
            completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
        WHERE id = @agentId
      `,
      )
      .run({
        agentId,
        status: completion.status,
        prUrl: completion.prUrl ?? null,
        completionSummary: completion.completionSummary ?? null,
      });
    return requireAgent(this.findById(agentId), agentId);
  }

  private findByOrchestrationIndex(orchestrationId: number, agentIndex: number): OrchestrationAgent | null {
    const row = this.db
      .prepare("SELECT * FROM orchestration_agents WHERE orchestration_id = ? AND agent_index = ?")
      .get(orchestrationId, agentIndex) as OrchestrationAgentRow | undefined;
    return row ? mapAgent(row) : null;
  }

  private update(
    id: number,
    fields: Partial<
      Pick<
        OrchestrationAgent,
        "childTaskId" | "status" | "branchName" | "worktreePath" | "discordThreadId" | "discordThreadUrl" | "prUrl" | "completionSummary"
      >
    >,
  ): OrchestrationAgent {
    const columnMap = {
      childTaskId: "child_task_id",
      status: "status",
      branchName: "branch_name",
      worktreePath: "worktree_path",
      discordThreadId: "discord_thread_id",
      discordThreadUrl: "discord_thread_url",
      prUrl: "pr_url",
      completionSummary: "completion_summary",
    } as const;
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return requireAgent(this.findById(id), id);
    }
    const params: Record<string, unknown> = { id };
    const assignments = entries.map(([key, value]) => {
      params[key] = value;
      return `${columnMap[key as keyof typeof columnMap]} = @${key}`;
    });
    this.db.prepare(`UPDATE orchestration_agents SET ${assignments.join(", ")} WHERE id = @id`).run(params);
    return requireAgent(this.findById(id), id);
  }
}

function requireAgent(value: OrchestrationAgent | null, id: number): OrchestrationAgent {
  if (!value) {
    throw new Error(`Orchestration agent #${id} not found.`);
  }
  return value;
}

function mapAgent(row: OrchestrationAgentRow): OrchestrationAgent {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    childTaskId: row.child_task_id,
    agentIndex: row.agent_index,
    agentName: row.agent_name,
    role: row.role,
    prompt: row.prompt,
    model: row.model,
    effort: row.effort,
    status: row.status,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    discordThreadId: row.discord_thread_id,
    discordThreadUrl: row.discord_thread_url,
    prUrl: row.pr_url,
    completionSummary: row.completion_summary,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
