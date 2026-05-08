import type Database from "better-sqlite3";
import type { Effort } from "../../types.js";
import type { Orchestration, OrchestrationStatus } from "../types.js";

type OrchestrationRow = {
  id: number;
  project_id: number;
  discord_thread_id: string | null;
  discord_thread_url: string | null;
  control_panel_message_id: string | null;
  author_user_id: string;
  status: OrchestrationStatus;
  goal: string;
  planner_task_id: number | null;
  planner_model: string | null;
  planner_effort: Effort | null;
  min_agents: number;
  max_agents: number;
  auto_start_children: number;
  final_plan_json: string | null;
  final_summary: string | null;
  created_at: string;
  updated_at: string;
  launched_at: string | null;
  completed_at: string | null;
};

export class OrchestrationsRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    projectId: number;
    authorUserId: string;
    goal: string;
    plannerModel?: string | null;
    plannerEffort?: Effort;
    minAgents?: number;
    maxAgents?: number;
    autoStartChildren?: boolean;
  }): Orchestration {
    const result = this.db
      .prepare(
        `
        INSERT INTO orchestrations (
          project_id,
          author_user_id,
          status,
          goal,
          planner_model,
          planner_effort,
          min_agents,
          max_agents,
          auto_start_children
        )
        VALUES (
          @projectId,
          @authorUserId,
          'PLANNING',
          @goal,
          @plannerModel,
          @plannerEffort,
          @minAgents,
          @maxAgents,
          @autoStartChildren
        )
      `,
      )
      .run({
        projectId: input.projectId,
        authorUserId: input.authorUserId,
        goal: input.goal,
        plannerModel: input.plannerModel ?? null,
        plannerEffort: input.plannerEffort ?? "high",
        minAgents: input.minAgents ?? 2,
        maxAgents: input.maxAgents ?? 10,
        autoStartChildren: input.autoStartChildren === false ? 0 : 1,
      });
    const orchestration = this.findById(Number(result.lastInsertRowid));
    if (!orchestration) {
      throw new Error("Orchestration could not be loaded after insert.");
    }
    return orchestration;
  }

  findById(id: number): Orchestration | null {
    const row = this.db.prepare("SELECT * FROM orchestrations WHERE id = ?").get(id) as OrchestrationRow | undefined;
    return row ? mapOrchestration(row) : null;
  }

  findByDiscordThreadId(threadId: string): Orchestration | null {
    const row = this.db
      .prepare("SELECT * FROM orchestrations WHERE discord_thread_id = ?")
      .get(threadId) as OrchestrationRow | undefined;
    return row ? mapOrchestration(row) : null;
  }

  updateStatus(id: number, status: OrchestrationStatus): Orchestration {
    return this.update(id, { status });
  }

  updateControlPanelMessageId(id: number, messageId: string | null): Orchestration {
    return this.update(id, { controlPanelMessageId: messageId });
  }

  updateThread(id: number, threadId: string, threadUrl: string | null): Orchestration {
    return this.update(id, { discordThreadId: threadId, discordThreadUrl: threadUrl });
  }

  updateFinalPlan(id: number, planJson: string): Orchestration {
    return this.update(id, { finalPlanJson: planJson, status: "READY_TO_ORCHESTRATE" });
  }

  updateBounds(id: number, minAgents: number, maxAgents: number): Orchestration {
    return this.update(id, { minAgents, maxAgents });
  }

  markLaunched(id: number): Orchestration {
    this.db
      .prepare(
        `
        UPDATE orchestrations
        SET status = 'RUNNING_AGENTS',
            launched_at = COALESCE(launched_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      )
      .run(id);
    return requireOrchestration(this.findById(id), id);
  }

  markCompleted(id: number, summary: string): Orchestration {
    this.db
      .prepare(
        `
        UPDATE orchestrations
        SET status = 'COMPLETED',
            final_summary = ?,
            completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      )
      .run(summary, id);
    return requireOrchestration(this.findById(id), id);
  }

  listByProject(projectId: number): Orchestration[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestrations WHERE project_id = ? ORDER BY datetime(created_at) DESC, id DESC")
      .all(projectId) as OrchestrationRow[];
    return rows.map(mapOrchestration);
  }

  private update(
    id: number,
    fields: Partial<
      Pick<
        Orchestration,
        | "discordThreadId"
        | "discordThreadUrl"
        | "controlPanelMessageId"
        | "status"
        | "plannerTaskId"
        | "plannerModel"
        | "plannerEffort"
        | "minAgents"
        | "maxAgents"
        | "autoStartChildren"
        | "finalPlanJson"
        | "finalSummary"
      >
    >,
  ): Orchestration {
    const columnMap = {
      discordThreadId: "discord_thread_id",
      discordThreadUrl: "discord_thread_url",
      controlPanelMessageId: "control_panel_message_id",
      status: "status",
      plannerTaskId: "planner_task_id",
      plannerModel: "planner_model",
      plannerEffort: "planner_effort",
      minAgents: "min_agents",
      maxAgents: "max_agents",
      autoStartChildren: "auto_start_children",
      finalPlanJson: "final_plan_json",
      finalSummary: "final_summary",
    } as const;
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return requireOrchestration(this.findById(id), id);
    }
    const params: Record<string, unknown> = { id };
    const assignments = entries.map(([key, value]) => {
      params[key] = typeof value === "boolean" ? (value ? 1 : 0) : value;
      return `${columnMap[key as keyof typeof columnMap]} = @${key}`;
    });
    assignments.push("updated_at = CURRENT_TIMESTAMP");
    this.db.prepare(`UPDATE orchestrations SET ${assignments.join(", ")} WHERE id = @id`).run(params);
    return requireOrchestration(this.findById(id), id);
  }
}

function requireOrchestration(value: Orchestration | null, id: number): Orchestration {
  if (!value) {
    throw new Error(`Orchestration #${id} not found.`);
  }
  return value;
}

function mapOrchestration(row: OrchestrationRow): Orchestration {
  return {
    id: row.id,
    projectId: row.project_id,
    discordThreadId: row.discord_thread_id,
    discordThreadUrl: row.discord_thread_url,
    controlPanelMessageId: row.control_panel_message_id,
    authorUserId: row.author_user_id,
    status: row.status,
    goal: row.goal,
    plannerTaskId: row.planner_task_id,
    plannerModel: row.planner_model,
    plannerEffort: row.planner_effort,
    minAgents: row.min_agents,
    maxAgents: row.max_agents,
    autoStartChildren: row.auto_start_children !== 0,
    finalPlanJson: row.final_plan_json,
    finalSummary: row.final_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    launchedAt: row.launched_at,
    completedAt: row.completed_at,
  };
}
