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
      ["final_summary", "TEXT"],
      ["error", "TEXT"],
      ["requested_by", "TEXT"],
      ["mode", "TEXT NOT NULL DEFAULT 'implement'"],
    ]);
    this.backfillProjectTaskNumbers();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_project_task_number ON tasks(project_id, project_task_number);
      CREATE TABLE IF NOT EXISTS codex_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        item_type TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_codex_events_task ON codex_events(task_id, created_at);
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
