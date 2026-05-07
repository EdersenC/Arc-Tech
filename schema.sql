PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  project_channel_id TEXT NOT NULL DEFAULT '',
  project_channel_name TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  project_slug TEXT NOT NULL DEFAULT '',
  repo_path TEXT NOT NULL,
  worktrees_path TEXT NOT NULL,
  remote_url TEXT,
  remote_status TEXT NOT NULL DEFAULT 'missing',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_task_number INTEGER NOT NULL DEFAULT 0,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  discord_thread_id TEXT,
  status TEXT NOT NULL,
  merge_status TEXT NOT NULL DEFAULT 'OPEN',
  prompt TEXT NOT NULL,
  requested_by TEXT,
  mode TEXT NOT NULL DEFAULT 'implement',
  sandbox TEXT NOT NULL DEFAULT 'workspace-write',
  model TEXT NOT NULL DEFAULT 'gpt-5.3-codex',
  effort TEXT NOT NULL DEFAULT 'medium',
  base_branch TEXT,
  task_branch TEXT,
  worktree_path TEXT,
  codex_thread_id TEXT,
  live_status_message_id TEXT,
  control_panel_message_id TEXT,
  final_summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(discord_thread_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);

CREATE TABLE IF NOT EXISTS task_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  discord_message_id TEXT,
  discord_author_id TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_messages_task_status ON task_messages(task_id, status, created_at);

CREATE TABLE IF NOT EXISTS codex_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  item_type TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_codex_events_task ON codex_events(task_id, created_at);
