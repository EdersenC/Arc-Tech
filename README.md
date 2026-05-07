# Discord Codex Runner

TypeScript Discord Gateway bot that creates a task thread with `/implement`, stores task-thread chat in SQLite, and sends queued task messages to sandboxed non-interactive Codex runs in the task worktree.

## Requirements

- Node.js 22 or newer
- npm
- Git
- Codex CLI installed and authenticated
- A Discord application with a bot token

## Environment

Create `.env`:

```bash
cp .env.example .env
```

Fill in:

```dotenv
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DATABASE_PATH=./data/app.sqlite
WORKSPACES_DIR=./workspaces
CODEX_BIN=codex
ENABLE_MESSAGE_CONTENT_INTENT=false
```

`DISCORD_GUILD_ID` is required because commands are registered as guild commands.

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

## Slash Commands

- `/implement msg:<text>` creates a SQLite task, creates an isolated git worktree and branch, creates a Discord task thread, stores the request, and posts task controls. Codex does not start until you press **Start**.
- `/status` shows the current channel project, remote state, repo path, and recent tasks.

Task numbers shown in Discord are local to each project/channel. A new project starts at task `#1` even though SQLite keeps a separate internal global row id for component routing.

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
