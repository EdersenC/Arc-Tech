import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export class AppDatabase {
  readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("foreign_keys = ON");
    this.db.exec(fs.readFileSync(path.resolve(process.cwd(), "schema.sql"), "utf8"));
    this.applyMigrations();
  }

  close(): void {
    this.db.close();
  }

  private applyMigrations(): void {
    this.addColumns("projects", [
      ["project_channel_id", "TEXT NOT NULL DEFAULT ''"],
      ["project_channel_name", "TEXT NOT NULL DEFAULT ''"],
      ["project_name", "TEXT NOT NULL DEFAULT ''"],
      ["project_slug", "TEXT NOT NULL DEFAULT ''"],
      ["remote_url", "TEXT"],
      ["remote_status", "TEXT NOT NULL DEFAULT 'missing'"],
    ]);
    this.addColumns("task_messages", [
      ["discord_author_id", "TEXT"],
      ["status", "TEXT NOT NULL DEFAULT 'queued'"],
      ["processed_at", "TEXT"],
    ]);
    this.addColumns("tasks", [
      ["project_task_number", "INTEGER NOT NULL DEFAULT 0"],
      ["merge_status", "TEXT NOT NULL DEFAULT 'OPEN'"],
      ["codex_thread_id", "TEXT"],
      ["live_status_message_id", "TEXT"],
      ["control_panel_message_id", "TEXT"],
      ["pull_request_url", "TEXT"],
      ["pr_url", "TEXT"],
      ["final_summary", "TEXT"],
      ["completion_summary", "TEXT"],
      ["discord_thread_url", "TEXT"],
      ["parent_orchestration_id", "INTEGER"],
      ["orchestration_agent_id", "INTEGER"],
      ["agent_role", "TEXT"],
      ["error", "TEXT"],
      ["requested_by", "TEXT"],
      ["mode", "TEXT NOT NULL DEFAULT 'implement'"],
      ["sandbox", "TEXT NOT NULL DEFAULT 'workspace-write'"],
      ["model", "TEXT NOT NULL DEFAULT 'gpt-5.3-codex'"],
      ["effort", "TEXT NOT NULL DEFAULT 'medium'"],
      ["base_branch", "TEXT"],
      ["task_branch", "TEXT"],
      ["worktree_path", "TEXT"],
    ]);
    this.backfillProjectTaskNumbers();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_project_task_number ON tasks(project_id, project_task_number);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent_orchestration ON tasks(parent_orchestration_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_orchestration_agent ON tasks(orchestration_agent_id);
      CREATE TABLE IF NOT EXISTS orchestrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        discord_thread_id TEXT,
        discord_thread_url TEXT,
        control_panel_message_id TEXT,
        parent_card_id TEXT,
        border_card_id TEXT,
        author_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        goal TEXT NOT NULL,
        planner_task_id INTEGER,
        planner_model TEXT,
        planner_effort TEXT,
        min_agents INTEGER NOT NULL DEFAULT 2,
        max_agents INTEGER NOT NULL DEFAULT 10,
        auto_start_children INTEGER NOT NULL DEFAULT 1,
        final_plan_json TEXT,
        final_summary TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        launched_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orchestrations_project ON orchestrations(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_orchestrations_thread ON orchestrations(discord_thread_id);
      CREATE TABLE IF NOT EXISTS workflow_graphs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        orchestration_id INTEGER REFERENCES orchestrations(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        graph_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_graphs_project ON workflow_graphs(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_graphs_orchestration ON workflow_graphs(orchestration_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_graphs_project_orchestration_unique
        ON workflow_graphs(project_id, orchestration_id)
        WHERE orchestration_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS workflow_patches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        graph_id INTEGER NOT NULL REFERENCES workflow_graphs(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        orchestration_id INTEGER REFERENCES orchestrations(id) ON DELETE SET NULL,
        base_revision INTEGER NOT NULL,
        resulting_revision INTEGER NOT NULL,
        patch_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'planner',
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_patches_graph ON workflow_patches(graph_id, resulting_revision);
      CREATE INDEX IF NOT EXISTS idx_workflow_patches_project ON workflow_patches(project_id, created_at);
      CREATE TABLE IF NOT EXISTS orchestration_agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orchestration_id INTEGER NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
        child_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        agent_index INTEGER NOT NULL,
        agent_name TEXT NOT NULL,
        role TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        branch_name TEXT,
        worktree_path TEXT,
        discord_thread_id TEXT,
        discord_thread_url TEXT,
        pr_url TEXT,
        completion_summary TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE (orchestration_id, agent_index)
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_agents_orchestration ON orchestration_agents(orchestration_id, agent_index);
      CREATE INDEX IF NOT EXISTS idx_orchestration_agents_child_task ON orchestration_agents(child_task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_agents_child_task_unique
        ON orchestration_agents(child_task_id)
        WHERE child_task_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS orchestration_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orchestration_id INTEGER NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
        discord_message_id TEXT,
        author_user_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_messages_orchestration ON orchestration_messages(orchestration_id, created_at);
      CREATE TABLE IF NOT EXISTS tracked_pull_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        parent_orchestration_id INTEGER,
        orchestration_agent_id INTEGER,
        pr_url TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        branch_name TEXT,
        state TEXT NOT NULL DEFAULT 'open',
        last_polled_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at TEXT,
        UNIQUE (owner, repo, number),
        UNIQUE (task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tracked_pull_requests_state ON tracked_pull_requests(state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tracked_pull_requests_project ON tracked_pull_requests(project_id, state);
      CREATE TABLE IF NOT EXISTS pull_request_feedback_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracked_pr_id INTEGER NOT NULL REFERENCES tracked_pull_requests(id) ON DELETE CASCADE,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        author TEXT,
        body TEXT NOT NULL,
        html_url TEXT,
        path TEXT,
        line INTEGER,
        review_state TEXT,
        github_created_at TEXT,
        github_updated_at TEXT,
        delivered_task_message_id INTEGER REFERENCES task_messages(id) ON DELETE SET NULL,
        delivered_at TEXT,
        reaction_status TEXT NOT NULL DEFAULT 'pending',
        reaction_error TEXT,
        reacted_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (tracked_pr_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pull_request_feedback_events_task ON pull_request_feedback_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pull_request_feedback_events_delivery ON pull_request_feedback_events(delivered_at);
      CREATE TABLE IF NOT EXISTS codex_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        item_type TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_codex_events_task ON codex_events(task_id, created_at);
      CREATE TABLE IF NOT EXISTS excalidraw_cards (
        id TEXT PRIMARY KEY,
        task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        source TEXT NOT NULL DEFAULT 'excalidraw',
        mode TEXT NOT NULL,
        command TEXT NOT NULL,
        title TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_card_id TEXT,
        metadata_json TEXT,
        branch TEXT,
        x REAL NOT NULL DEFAULT 80,
        y REAL NOT NULL DEFAULT 80,
        width REAL NOT NULL DEFAULT 360,
        height REAL NOT NULL DEFAULT 180,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_excalidraw_cards_task ON excalidraw_cards(task_id);
      CREATE INDEX IF NOT EXISTS idx_excalidraw_cards_project ON excalidraw_cards(project_id, updated_at);
    `);
    this.addColumns("orchestrations", [
      ["parent_card_id", "TEXT"],
      ["border_card_id", "TEXT"],
    ]);
    this.addColumns("excalidraw_cards", [
      ["parent_card_id", "TEXT"],
      ["metadata_json", "TEXT"],
    ]);
    this.addColumns("pull_request_feedback_events", [
      ["reaction_status", "TEXT NOT NULL DEFAULT 'pending'"],
      ["reaction_error", "TEXT"],
      ["reacted_at", "TEXT"],
    ]);
    this.addColumns("tracked_pull_requests", [
      ["last_feedback_at", "TEXT"],
      ["polling_suspended_at", "TEXT"],
      ["polling_suspended_reason", "TEXT"],
    ]);
    this.db.exec(`
      UPDATE tracked_pull_requests
      SET last_feedback_at = (
        SELECT MAX(COALESCE(e.github_updated_at, e.github_created_at, e.created_at))
        FROM pull_request_feedback_events e
        WHERE e.tracked_pr_id = tracked_pull_requests.id
      )
      WHERE last_feedback_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM pull_request_feedback_events e
          WHERE e.tracked_pr_id = tracked_pull_requests.id
        );
      CREATE INDEX IF NOT EXISTS idx_tracked_pull_requests_polling
        ON tracked_pull_requests(state, polling_suspended_at, last_polled_at);
    `);
  }

  private addColumns(table: string, columns: Array<[string, string]>): void {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    for (const [name, definition] of columns) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private backfillProjectTaskNumbers(): void {
    const needsBackfill = this.db
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_task_number <= 0")
      .get() as { count: number };
    if (needsBackfill.count === 0) {
      return;
    }

    const rows = this.db
      .prepare("SELECT id, project_id FROM tasks ORDER BY project_id ASC, id ASC")
      .all() as Array<{ id: number; project_id: number }>;
    const counters = new Map<number, number>();
    const update = this.db.prepare("UPDATE tasks SET project_task_number = ? WHERE id = ?");
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const next = (counters.get(row.project_id) ?? 0) + 1;
        counters.set(row.project_id, next);
        update.run(next, row.id);
      }
    });
    tx();
  }
}
