import type Database from "better-sqlite3";
import type { Task } from "../types.js";
import type {
  NormalizedPullRequestFeedback,
  PullRequestFeedbackEvent,
  PullRequestIdentity,
  TrackedPullRequest,
} from "./PullRequestFeedbackTypes.js";

type TrackedPullRequestRow = {
  id: number;
  project_id: number;
  task_id: number;
  parent_orchestration_id: number | null;
  orchestration_agent_id: number | null;
  pr_url: string;
  owner: string;
  repo: string;
  number: number;
  branch_name: string | null;
  state: TrackedPullRequest["state"];
  last_polled_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

type PullRequestFeedbackEventRow = {
  id: number;
  tracked_pr_id: number;
  task_id: number;
  external_id: string;
  kind: PullRequestFeedbackEvent["kind"];
  author: string | null;
  body: string;
  html_url: string | null;
  path: string | null;
  line: number | null;
  review_state: string | null;
  github_created_at: string | null;
  github_updated_at: string | null;
  delivered_task_message_id: number | null;
  delivered_at: string | null;
  created_at: string;
};

export class PullRequestFeedbackRepo {
  constructor(private readonly db: Database.Database) {}

  upsertTrackedForTask(task: Task, identity: PullRequestIdentity, prUrl: string): TrackedPullRequest {
    this.db
      .prepare(
        `
        INSERT INTO tracked_pull_requests (
          project_id,
          task_id,
          parent_orchestration_id,
          orchestration_agent_id,
          pr_url,
          owner,
          repo,
          number,
          branch_name,
          state
        )
        VALUES (
          @projectId,
          @taskId,
          @parentOrchestrationId,
          @orchestrationAgentId,
          @prUrl,
          @owner,
          @repo,
          @number,
          @branchName,
          'open'
        )
        ON CONFLICT(task_id) DO UPDATE SET
          parent_orchestration_id = excluded.parent_orchestration_id,
          orchestration_agent_id = excluded.orchestration_agent_id,
          pr_url = excluded.pr_url,
          owner = excluded.owner,
          repo = excluded.repo,
          number = excluded.number,
          branch_name = excluded.branch_name,
          state = CASE WHEN tracked_pull_requests.state IN ('closed', 'merged') THEN tracked_pull_requests.state ELSE 'open' END,
          updated_at = CURRENT_TIMESTAMP
      `,
      )
      .run({
        projectId: task.projectId,
        taskId: task.id,
        parentOrchestrationId: task.parentOrchestrationId,
        orchestrationAgentId: task.orchestrationAgentId,
        prUrl,
        owner: identity.owner,
        repo: identity.repo,
        number: identity.number,
        branchName: task.taskBranch,
      });
    const tracked = this.findByTaskId(task.id);
    if (!tracked) {
      throw new Error(`Tracked PR for task #${task.id} could not be loaded after upsert.`);
    }
    return tracked;
  }

  findByTaskId(taskId: number): TrackedPullRequest | null {
    const row = this.db
      .prepare("SELECT * FROM tracked_pull_requests WHERE task_id = ?")
      .get(taskId) as TrackedPullRequestRow | undefined;
    return row ? mapTracked(row) : null;
  }

  listOpen(limit = 100): TrackedPullRequest[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM tracked_pull_requests
        WHERE state = 'open'
        ORDER BY COALESCE(datetime(last_polled_at), datetime(created_at)) ASC, id ASC
        LIMIT ?
      `,
      )
      .all(limit) as TrackedPullRequestRow[];
    return rows.map(mapTracked);
  }

  markPolled(id: number): void {
    this.db
      .prepare("UPDATE tracked_pull_requests SET last_polled_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(id);
  }

  markError(id: number, error: string): void {
    this.db
      .prepare("UPDATE tracked_pull_requests SET last_polled_at = CURRENT_TIMESTAMP, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(error, id);
  }

  markState(id: number, state: TrackedPullRequest["state"]): void {
    const terminal = state === "closed" || state === "merged";
    this.db
      .prepare(
        `
        UPDATE tracked_pull_requests
        SET state = ?,
            closed_at = CASE WHEN ? THEN COALESCE(closed_at, CURRENT_TIMESTAMP) ELSE closed_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      )
      .run(state, terminal ? 1 : 0, id);
  }

  createFeedbackEvent(
    tracked: TrackedPullRequest,
    feedback: NormalizedPullRequestFeedback,
    deliveredTaskMessageId: number | null,
  ): PullRequestFeedbackEvent | null {
    const result = this.db
      .prepare(
        `
        INSERT OR IGNORE INTO pull_request_feedback_events (
          tracked_pr_id,
          task_id,
          external_id,
          kind,
          author,
          body,
          html_url,
          path,
          line,
          review_state,
          github_created_at,
          github_updated_at,
          delivered_task_message_id,
          delivered_at
        )
        VALUES (
          @trackedPrId,
          @taskId,
          @externalId,
          @kind,
          @author,
          @body,
          @htmlUrl,
          @path,
          @line,
          @reviewState,
          @githubCreatedAt,
          @githubUpdatedAt,
          @deliveredTaskMessageId,
          CASE WHEN @deliveredTaskMessageId IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END
        )
      `,
      )
      .run({
        trackedPrId: tracked.id,
        taskId: tracked.taskId,
        externalId: feedback.externalId,
        kind: feedback.kind,
        author: feedback.author,
        body: feedback.body,
        htmlUrl: feedback.htmlUrl,
        path: feedback.path,
        line: feedback.line,
        reviewState: feedback.reviewState,
        githubCreatedAt: feedback.githubCreatedAt,
        githubUpdatedAt: feedback.githubUpdatedAt,
        deliveredTaskMessageId,
      });
    if (result.changes === 0) {
      return null;
    }
    const row = this.db
      .prepare("SELECT * FROM pull_request_feedback_events WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as PullRequestFeedbackEventRow | undefined;
    return row ? mapFeedback(row) : null;
  }

  markEventsDelivered(eventIds: number[], taskMessageId: number): void {
    if (eventIds.length === 0) {
      return;
    }
    const placeholders = eventIds.map(() => "?").join(",");
    this.db
      .prepare(
        `
        UPDATE pull_request_feedback_events
        SET delivered_task_message_id = ?,
            delivered_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `,
      )
      .run(taskMessageId, ...eventIds);
  }
}

function mapTracked(row: TrackedPullRequestRow): TrackedPullRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    parentOrchestrationId: row.parent_orchestration_id,
    orchestrationAgentId: row.orchestration_agent_id,
    prUrl: row.pr_url,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    branchName: row.branch_name,
    state: row.state,
    lastPolledAt: row.last_polled_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function mapFeedback(row: PullRequestFeedbackEventRow): PullRequestFeedbackEvent {
  return {
    id: row.id,
    trackedPrId: row.tracked_pr_id,
    taskId: row.task_id,
    externalId: row.external_id,
    kind: row.kind,
    author: row.author,
    body: row.body,
    htmlUrl: row.html_url,
    path: row.path,
    line: row.line,
    reviewState: row.review_state,
    githubCreatedAt: row.github_created_at,
    githubUpdatedAt: row.github_updated_at,
    deliveredTaskMessageId: row.delivered_task_message_id,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  };
}
