# Orchestration Workflow

The parent orchestration thread is the command center. It holds the planning conversation, control panel, final AgentFleetPlan, spawned child links, and fleet summary.

Child agents are visible sibling task rooms. Each child receives its own branch, worktree, Discord task thread/forum post, objective, acceptance criteria, and control panel.

The TypeScript app owns Discord and Git lifecycle. Codex must not call Discord APIs, receive `DISCORD_TOKEN`, merge branches, delete sibling worktrees, or leave its assigned scope.

Before spawning children, the orchestrator should define shared interface contracts and per-agent `AgentWorkContract` objects. Child agents treat that contract as the source of truth for owned scope, forbidden scope, interfaces they consume/provide, data contracts, validation commands, conflict-avoidance rules, and completion reporting.
