# Discord Codex Runner

TypeScript Discord Gateway bot and Excalidraw command surface that create implementation tasks, store task chat/state in SQLite, and send queued messages to sandboxed non-interactive Codex runs in isolated task worktrees.

## Requirements

- Node.js 22 or newer
- npm
- Git
- Codex CLI installed and authenticated
- A Discord application with a bot token

## Environment

Create `.env` in the repo root:

```dotenv
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DATABASE_PATH=./data/app.sqlite
WORKSPACES_DIR=./workspaces
CODEX_BIN=codex
ENABLE_MESSAGE_CONTENT_INTENT=false
GITHUB_PR_ENABLED=false
GITHUB_PR_FEEDBACK_ENABLED=false
GITHUB_PR_FEEDBACK_POLL_MS=60000
GITHUB_BASE_BRANCH=main
GITHUB_REMOTE=origin
EXCALIDRAW_HOST=127.0.0.1
EXCALIDRAW_PORT=8787
EXCALIDRAW_CORS_ORIGIN=http://127.0.0.1:5173,http://localhost:5173
EXCALIDRAW_WORKSPACES_DIR=~/.arc-tech/excalidraw-workspaces
EXCALIDRAW_PROJECT_GUILD_ID=excalidraw
EXCALIDRAW_PROJECT_CHANNEL_ID=default
EXCALIDRAW_PROJECT_NAME=Excalidraw
```

`DISCORD_GUILD_ID` is required because commands are registered as guild commands.
The Excalidraw API can run without Discord credentials by using `loadConfig({ requireDiscord: false })`.
`EXCALIDRAW_CORS_ORIGIN` is a comma-separated allowlist. Use `*` only in a trusted local environment.
`EXCALIDRAW_WORKSPACES_DIR` defaults outside this repo so local Codex sandbox mounts do not depend on the Arc-Tech checkout path.

## Codebase Map

The runtime is intentionally small and centered on the Discord Gateway client in `src/index.ts`.

- `src/commands.ts` and `src/register-commands.ts` define and register the guild slash commands.
- `src/config.ts` loads environment variables with `dotenv` and resolves the SQLite database and workspace paths.
- `src/db.ts`, `schema.sql`, and `src/stores.ts` own the SQLite schema, lightweight migrations, and project/task/message persistence.
- `src/git.ts` manages project repositories, task worktrees, task commits, branch pushes, PR creation, merge, and cleanup.
- `src/taskControlPanel.ts` renders and handles the Discord buttons and select menus for each task.
- `src/taskMessagePump.ts` serializes queued task-thread messages into Codex runs and records completion/failure state.
- `src/tasks/ImplementService.ts` owns the shared `/implement` task creation, worktree setup, message queueing, and optional start path used by Discord and Excalidraw.
- `src/codexRunner.ts` shells out to `codex exec --json`; `src/codex/*` parses and routes the JSONL event stream.
- `src/progress/TaskProgressService.ts` keeps the live status message updated and posts major task events back to Discord.
- `src/orchestrations/*` owns the reusable planner-to-agent-fleet workflow behind `/orchestrate`.
- `src/tasks/TaskService.ts` centralizes low-level implementation task rows so `/implement` and orchestration children use the same backend path.
- `src/excalidraw/*` owns the HTTP API and persisted visual task-card state for the Excalidraw UI adapter.
- `web/` contains the React + `@excalidraw/excalidraw` MVP canvas.
- `src/cli/arcctl.ts` writes optional local bridge requests/events under `.codex-bridge/` for future custom UI or skill workflows.

## Discord Setup

1. Create an app in the Discord Developer Portal.
2. Add a bot user and copy its token into `DISCORD_TOKEN`.
3. Copy the application client ID into `DISCORD_CLIENT_ID`.
4. Copy your test server ID into `DISCORD_GUILD_ID`.
5. Invite the bot with these scopes:
   - `bot`
   - `applications.commands`
6. Give the bot permissions to:
   - View Channel
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Add Reactions
   - Use Application Commands
7. Enable Message Content Intent:
   - Discord Developer Portal
   - Your app
   - Bot
   - Privileged Gateway Intents
   - Enable Message Content Intent

Without Message Content Intent, task-thread messages may arrive with empty content or may not work correctly.

After enabling the Developer Portal toggle, set:

```dotenv
ENABLE_MESSAGE_CONTENT_INTENT=true
```

If you set `ENABLE_MESSAGE_CONTENT_INTENT=true` before enabling the Developer Portal toggle, Discord will reject the Gateway connection with `Used disallowed intents`.

This is a Gateway bot. It uses `client.login(DISCORD_TOKEN)`, listens for `Events.InteractionCreate` and `Events.MessageCreate`, and does not need ngrok, a public HTTP server, or an Interactions Endpoint URL.

## Commands

Register guild commands:

```bash
npm run register-commands
```

Run in development:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Run compiled JavaScript:

```bash
npm start
```

Run the Excalidraw MVP:

```bash
npm run excalidraw
```

## Slash Commands

- `/implement msg:<text>` creates a SQLite task, creates an isolated git worktree and branch, creates a Discord task thread, stores the request, and posts task controls. Codex does not start until you press **Start**.
- `/orchestrate msg:<text>` creates a parent orchestration thread, starts a read-only planner Codex run, lets you chat with the planner, and launches 2-10 visible child implementation agents when you press **Orchestrate**.
- `/status` shows the current channel project, remote state, repo path, and recent tasks.

Task numbers shown in Discord are local to each project/channel. A new project starts at task `#1` even though SQLite keeps a separate internal global row id for component routing.

## Excalidraw Project Runner

Excalidraw is a second UI adapter for the same implementation runner. Start it with `npm run excalidraw`, then open the Vite URL printed in the terminal. The single startup command launches both the API server and the Vite canvas UI.
If launched with `sudo`, the Excalidraw process drops back to the original user before creating task worktrees so Codex does not inherit root-owned workspaces.

The canvas is project-based. Use the project selector to switch between Excalidraw projects, or create a new project from the top bar without restarting the server. Each Excalidraw project is a normal `projects` row with `guild_id=excalidraw` and its own synthetic channel id, repo path, worktrees path, project-local task numbers, task cards, task history, and remote config. Discord channel projects keep their existing guild/channel mapping and behavior.

The command panel accepts:

```text
/implement Add a health check endpoint to the API
/orchestrate Upgrade the visual runner planning flow
```

Modes:

- **Direct Agent** calls `POST /api/implement` with the selected `projectId`, creates the same SQLite task/worktree/queued message path as Discord, starts the task immediately, and draws a task card in the current visible canvas area. Direct Agent requires `GITHUB_PR_ENABLED=true` plus a connected remote for the active project so completed work can push a branch and create a PR.
- **Plan Card Only** persists a visual planning card in the active project and does not start Codex.

Use the repo panel to connect the active Excalidraw project to a GitHub remote. The API exposes `GET /api/excalidraw/projects`, `POST /api/excalidraw/projects`, `GET /api/excalidraw/project?projectId=...`, and `POST /api/excalidraw/project/remote` with `{ "projectId": 1, "remoteUrl": "https://github.com/owner/repo.git" }`. If PRs are disabled or no remote is connected for the active project, Direct Agent is blocked before task creation instead of silently completing local-only work without a PR.

Every Arc-generated Excalidraw element includes `customData.arc` with the card id, source, command, status, task id, and latest progress when one exists. The selected active project is persisted in browser local storage. The UI polls `GET /api/tasks?projectId=...` every few seconds and updates only that project's cards from SQLite without overwriting local drag positions. New cards are placed near the current visible viewport center instead of in a global grid.

Direct agent cards grow as runner information arrives, including phase, latest activity, PR feedback resolution state, command events, changed files, queue counts, summaries, errors, and concise link buttons. Card links are structured data derived from task state, including PR URLs, Discord thread URLs when present, and Excalidraw task detail links. The small link text elements use Excalidraw element links; raw URLs are kept out of the card body. Moving cards persists their canvas position with `PATCH /api/excalidraw/cards/:id`; deleting cards is visual-only for now and never deletes the real task.

Click a task card to open the right-side detail drawer. The drawer loads `GET /api/tasks/:id/history`, showing task status, project, branch, worktree, prompt, changed files, latest activity, command events, final summary or error, full task message history, recent Codex events, and PR feedback events. The drawer also has a follow-up chat box backed by `POST /api/tasks/:id/messages`; messages are queued through the same `TaskMessagePump` path used by Discord task-thread replies. Closed, failed, merged, abandoned, or remote-waiting tasks are rejected with a clear API error.

Excalidraw `/orchestrate` starts a project-scoped visual planning session instead of immediately spawning agents. The parent orchestration card opens a sidebar with the planner transcript, clickable poll-style options, freeform planner replies, final plan review, and a **Spawn Agents** control. Spawning requires explicit approval. When approved, the API creates real child implementation tasks through `ImplementService`, lays their cards out inside one bordered orchestration group in a 3-column grid, and stores parent/child links through task orchestration ids and card metadata. Clicking the outer orchestration card reopens the master plan/history; clicking a child card opens that agent task's normal history and follow-up chat.

### Live Workflow Canvas v1

Live workflow canvas v1 adds a model-owned `WorkflowGraph` to Excalidraw `/orchestrate`. The graph is the source of truth for goals, requirements, architecture decisions, components, risks, questions, milestones, and proposed agent tasks. Excalidraw is only the visual projection.

Run it from a fresh checkout:

```bash
npm install
cp .env.example .env
npm run excalidraw
```

Open the Vite URL printed by `npm run excalidraw`, create or select an Excalidraw project, connect a repo remote if Direct Agent or Spawn Agents needs PR-backed work, then submit:

```text
/orchestrate ace multiplayer snake game
```

The server creates the parent orchestration and an initial project-scoped workflow graph. The browser subscribes to:

```text
GET /api/workflows/events?projectId=<activeProjectId>
```

and renders locked workflow boxes/arrows into the same canvas as task cards. The sidebar shows workflow stream state, current revision, and latest patch reason/status.

Planner/model messages may include semantic workflow patches in this fenced format:

````markdown
```ARC_WORKFLOW_PATCH_JSON
{
  "id": "patch-replace-p2p-with-https-rev-0",
  "graphId": "workflow-project-1-orchestration-12",
  "baseRevision": 0,
  "reason": "Replace P2P multiplayer with HTTPS.",
  "author": "planner",
  "createdAt": "2026-05-09T12:05:00.000Z",
  "operations": []
}
```
````

The server extracts the newest `ARC_WORKFLOW_PATCH_JSON` block, validates it, rejects raw Excalidraw JSON, checks `baseRevision`, applies it through `WorkflowService`, persists patch history, and emits `workflow.patch_applied` or `workflow.patch_rejected`.

Important v1 rule: direct user canvas edits do not change workflow state. Moving or deleting workflow-owned Excalidraw elements is visual-only and is restored from the latest `WorkflowGraph` snapshot. User input changes the graph only by going through the planner/model. Task-card dragging still uses the existing card persistence path and does not mutate `WorkflowGraph`.

Troubleshooting workflow streams:

- Status shows `Workflow reconnecting`: the browser `EventSource` lost the SSE connection and is reconnecting automatically. Check that `npm run excalidraw` is still running and the active project id is valid.
- Status shows `Workflow disconnected`: the EventSource closed. Reload the page or switch projects to create a new stream.
- Patch rejected with a stale revision: the planner emitted a patch for an older `baseRevision`. Fetch the latest graph snapshot and regenerate the patch against the current revision.
- Patch rejected as malformed: inspect the newest `ARC_WORKFLOW_PATCH_JSON` block; it must contain one complete JSON object and no markdown inside the block.
- Canvas does not update: check the browser console for stream parse errors and the server log for `Workflow patch applied` or `Workflow patch rejected`.

See `docs/demo-workflow-snake-game.md` for a manual end-to-end demo.

The Excalidraw API intentionally does not log in to Discord and does not expose Discord tokens. Execution still flows through `ImplementService`, `TaskMessagePump`, `CodexRunner`, and `GitManager`; the canvas never runs shell commands directly.

For compiled serving, `npm run build` writes the web bundle to `dist/web`; the Excalidraw API serves that directory when Vite is not in front of it.

Current limitations: collaborative multi-user editing is not enabled, workflow event fanout is in-memory for v1, and task controls such as diff/merge/cancel remain in the existing Discord task UI for now.

## Project Git Remote

Each Discord channel maps to one local project repo. On the first implementation task for a channel, if the base repo does not have an `origin` remote and the project has not been marked local-only, the task enters `WAITING_REMOTE`.

The bot posts a prompt in the task thread. Reply with one of:

```text
https://github.com/owner/repo.git
git@github.com:owner/repo.git
git remote add origin https://github.com/owner/repo.git
skip
```

A valid URL configures `origin`, fetches the remote, checks out the remote default branch into the project base repo, and then creates the task worktree/branch from that pulled base. `skip` marks the project local-only and creates the task worktree from the local empty base. After either choice, press **Start** in the task control panel.

## Data and Workspace Layout

The bot keeps durable state in SQLite at `DATABASE_PATH`. The schema contains:

- `projects`: one row per Discord guild/channel project, including the base repo path, worktrees path, and remote state.
- `tasks`: one row per implementation task, including the visible project-local task number, branch/worktree paths, selected model/effort/mode/sandbox, PR URL, and final summary.
- `task_messages`: queued, processing, processed, and failed user messages for each task thread.
- `codex_events`: raw parsed Codex JSONL events used for live progress and diagnostics.
- `orchestrations`: parent planner rooms, bounds, final AgentFleetPlan JSON, and status.
- `orchestration_agents`: child agent rows linked to visible task threads, branches, worktrees, summaries, and optional PR URLs.
- `orchestration_messages`: parent-thread planner conversation history.
- `excalidraw_cards`: persisted visual cards, linked task ids, project ids, canvas position, label, branch, and status for the Excalidraw UI.
- `workflow_graphs`: current authoritative `WorkflowGraph` snapshots scoped to a project and optional orchestration.
- `workflow_patches`: append-only semantic `WorkflowPatch` history with base/resulting revisions and planner reasons.

Project files live under `WORKSPACES_DIR/<guild>/<project-slug>-<channel-id>/` with a `repo/` base checkout and isolated task worktrees in `worktrees/task-<n>/`. Task branches use `codex/task-<n>`, where `<n>` is the project-local task number shown in Discord.

Excalidraw project files use the same project layout under `EXCALIDRAW_WORKSPACES_DIR/excalidraw/<project-slug>-<synthetic-channel-id>/`. Switching canvas projects switches the active project row, so cards, tasks, branches, worktrees, and remote readiness stay scoped to that project.

Orchestration child branches use `codex/orch-<orchestrationId>/agent-<index>-<slug>`. Child worktrees are still isolated under the project `worktrees/` directory.

## Orchestration Workflow

`/orchestrate` is a planner-to-agent-fleet workflow:

1. The app creates a parent orchestration thread/forum post.
2. A planner Codex run starts in read-only planning mode.
3. Users chat with the planner in the parent thread or through **Ask Planner**.
4. The parent control panel can show/improve the plan, set agent bounds, launch, or cancel.
5. **Orchestrate** asks the planner for strict AgentFleetPlan JSON, validates it, repairs once if needed, and then spawns 2-10 children.
6. Every child maps to a visible sibling task thread/forum post with its own branch, worktree, task control panel, and auto-started Codex run.
7. Child completion updates the parent thread with task link, branch, summary, and PR URL when available.
8. When all children are terminal, the parent posts a fleet summary and moves to review.

The parent thread is the command center. Child threads are sibling task rooms, not nested Discord threads and not hidden background jobs.

Planner runs use:

```bash
codex exec --cd <projectRepo> --json --sandbox read-only -c approval_policy=never <plannerPrompt>
```

Child implementation runs use:

```bash
codex exec --cd <childWorktree> --json --sandbox workspace-write -c approval_policy=never <childPrompt>
```

`CodexRunner` removes Discord credentials from the child process environment before spawning Codex. Codex must not call Discord APIs directly; the TypeScript app owns Discord.

## Orchestration Controls

Parent custom IDs:

- `orch:ask:<id>`
- `orch:show-plan:<id>`
- `orch:improve-plan:<id>`
- `orch:set-bounds:<id>`
- `orch:launch:<id>`
- `orch:cancel:<id>`
- `orch:agent-status:<id>`
- `orch:summarize:<id>`
- `orch:pause-fleet:<id>`
- `orch:spawn-extra:<id>`

Bounds are clamped to a hard minimum of 2 and hard maximum of 10. Children auto-start in the MVP.

## Optional PRs

PR URLs are optional. With `GITHUB_PR_ENABLED=false`, tasks still commit locally and report branch/worktree paths. With GitHub PRs enabled and `gh` configured, the app can push task branches and create or update PRs. Missing GitHub integration does not fail an orchestration.

Implementation agents can propose their own PR names by ending with `PR title: <short descriptive title>`. Orchestration planners can also include optional child-level `prTitle` values in the AgentFleetPlan. The TypeScript runner sanitizes these titles and still owns `gh pr create`/`gh pr edit`; Codex never receives GitHub control directly. If no title is proposed, the runner falls back to the task number plus a shortened command.

## PR Feedback Worker

When `GITHUB_PR_FEEDBACK_ENABLED=true`, the runner polls tracked open PRs created by agent tasks. The worker uses `gh api` to read PR issue comments, review summaries, and inline review comments. New feedback is deduped in SQLite, queued as a normal task follow-up, and the owning agent task is automatically enqueued.

The worker starts in both the Discord bot and the standalone Excalidraw server. It posts a short visibility update in the child task thread and parent orchestration thread when applicable. Excalidraw cards show PR feedback as `queued`, `resolving`, or `resolved` while the same task runner handles the follow-up. Codex receives only the task follow-up prompt in its existing worktree and branch; it does not receive Discord credentials and does not call Discord APIs.

When feedback is queued, the runner attempts to add an `eyes` reaction to supported GitHub issue comments and inline review comments so the reviewer can see that Arc-Tech picked it up. Review summary events are still queued for the agent, but GitHub does not expose the same reaction endpoint for every review event.

Polling defaults to the PR feature flag. Set `GITHUB_PR_FEEDBACK_POLL_MS` to control the interval.

## arcctl and Skills

`arcctl` is a lightweight local bridge for future custom UI and skill flows. It never calls Discord APIs and does not require `DISCORD_TOKEN`.

```bash
tsx src/cli/arcctl.ts orchestrate status
tsx src/cli/arcctl.ts orchestrate propose-plan --file fleet-plan.json
tsx src/cli/arcctl.ts orchestrate spawn --file fleet-plan.json
tsx src/cli/arcctl.ts orchestrate report-agent-done --agent-id 1 --summary-file summary.md --pr-url https://github.com/owner/repo/pull/1
```

Bridge files are generated at runtime under `.codex-bridge/requests/`, `.codex-bridge/responses/`, and `.codex-bridge/events.jsonl`. The directory is gitignored to keep bridge traffic out of commits.

The repo also includes:

- `.agents/skills/arc-orchestrator`
- `.agents/skills/arc-implementation-agent`

## Task Controls

Each task thread gets a Task Control Panel with these button custom IDs:

- `task:start:<taskId>`
- `task:cancel:<taskId>`
- `task:diff:<taskId>`
- `task:merge:<taskId>`
- `task:abandon:<taskId>`
- `task:ask:<taskId>`

`<taskId>` in component IDs is the internal SQLite task row id. The visible Discord task number remains project-local.

The panel supports:

- **Start**: enqueue the task for Codex.
- **Cancel**: cancel queued work or abort the running Codex child process.
- **Show Diff**: show the current git diff stat.
- **Merge**: merge a completed task branch into the base branch.
- **Abandon**: mark the task abandoned and remove its task worktree.
- **Ask Codex**: tells you to send a normal message in the task thread.

Task config is controlled with Discord select menus for model, effort, mode, and sandbox. Discord limits one message to five component rows, so the MVP sends the buttons in the stored control panel message and the select menus in a companion config message. Changing a select updates SQLite and edits the control panel text to show the selected config.

## Task Thread Chat

Normal user messages inside a Codex task thread are routed to that task:

- The bot ignores bot/system messages.
- The bot only processes messages inside Discord threads.
- It matches `message.channel.id` to `tasks.discord_thread_id`.
- It stores user messages in `task_messages` with `status='queued'`.
- It acknowledges with a reaction or a short reply.
- It drains queued messages sequentially per task.

If Codex is already running for that task, the message stays queued and is processed after the current run finishes. The app does not write into Codex stdin or interrupt active runs unless the user sends `stop` or `cancel`.

If the task has not been started yet, thread messages are queued and held until **Start** is pressed.

Thread shortcuts:

- `status` posts task status, branch, and worktree.
- `diff` posts git diff stat.
- `stop` or `cancel` cancels queued/running Codex work for that task.

Closed tasks with status `CANCELED`, `FAILED`, `MERGED`, or `ABANDONED` reject new chat follow-ups.

## Codex Execution

Implementation and follow-up turns run with sandboxing enabled:

```bash
codex exec --cd <taskWorktreePath> --json --sandbox workspace-write -c approval_policy=never <prompt>
```

The app never uses:

```bash
--dangerously-bypass-approvals-and-sandbox
```

For MVP continuation, the app runs a new `codex exec` in the same task worktree and branch with the prior summary plus queued messages. The `CodexRunner` interface has separate `runTask` and `continueTask` methods so a future SDK-backed implementation can resume a stored Codex thread/session id directly.

Each Codex process gets a private writable temp directory at `.codex-tmp/` inside the task worktree. The runner exports `TMPDIR`, `TMP`, `TEMP`, and `XDG_RUNTIME_DIR` to that path so Codex/bubblewrap does not depend on a shared `/tmp` lock directory. `.codex-tmp/` is excluded from task commits.

Implementation tasks run with the task worktree as `--cd`. Codex edits files only inside that isolated worktree and is instructed not to run `git add`, `git commit`, `git push`, or `gh pr create`. The TypeScript runner owns Git metadata writes and PR creation outside the Codex sandbox.

Codex's primary completion goal for implementation tasks is to finish the file changes and provide a clear summary. It is instructed not to merge to main or edit files in the base repo or other task worktrees.

After Codex finishes, the orchestrator runs the Git lifecycle path:

- removes `.codex-tmp/`
- commits any remaining uncommitted task changes
- pushes the task branch when GitHub PR integration is enabled
- creates or reuses a GitHub pull request with `gh` when available, using the agent-proposed PR title when provided
- posts the PR link in the task thread when one exists

## Live Progress

Codex is run with `--json`, and stdout is parsed as a JSON Lines stream while the process is running. Raw parsed events are stored in SQLite in `codex_events`.

The task thread gets one persistent `Live Status` message that is edited instead of posting a new message for every event. It shows:

- task ID
- branch
- current phase
- last Codex event type
- current command
- last update time
- changed file count

The bot only posts new messages for major events such as task start, plan updates, failures, errors, and completion. Stderr is stored separately and only posted when it looks critical or when the process fails.
