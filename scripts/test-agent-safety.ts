import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { parseAgentSafetyEvents, safetyEventNeedsOrchestrator } from "../src/orchestrations/AgentSafetyEvents.js";
import { OrchestrationSafetyRepo } from "../src/orchestrations/repos/OrchestrationSafetyRepo.js";

testParser();
testRepo();
console.log("Agent safety tests passed.");

function testParser(): void {
  const events = parseAgentSafetyEvents(`Need approval.

\`\`\`ARC_AGENT_SAFETY_EVENT_JSON
[
  {
    "kind": "request_scope_change",
    "title": "Need schema ownership",
    "body": "The assigned service needs a schema column.",
    "severity": "high",
    "payload": {
      "originalScope": "service only",
      "requestedScope": "schema.sql",
      "reason": "persist new state",
      "riskIfDenied": "feature cannot save state",
      "affectedAgents": ["backend"]
    }
  },
  {
    "kind": "notify_dependency_ready",
    "title": "Contracts ready"
  },
  {
    "kind": "report_validation_result",
    "title": "Build failed",
    "payload": {
      "command": "npm run build",
      "status": "failed",
      "usefulOutput": "Type error",
      "suspectedCause": "API type mismatch",
      "requestedAction": "coordinate interface fix"
    }
  },
  {
    "kind": "handoff_to_integration",
    "title": "Ready for integration",
    "payload": {
      "summary": "Service slice complete",
      "changedFiles": ["src/service.ts"],
      "newInterfaces": [],
      "validationNotes": "tests passed"
    }
  }
]
\`\`\``);
  assert.equal(events.length, 4);
  assert.equal(events[0]?.kind, "request_scope_change");
  assert.equal(events[0]?.severity, "high");
  assert.equal(safetyEventNeedsOrchestrator("request_interface_change", "medium"), true);
  assert.equal(safetyEventNeedsOrchestrator("notify_dependency_ready", "low"), false);
  assert.equal(safetyEventNeedsOrchestrator("declare_assumption", "high"), true);
  assert.equal(safetyEventNeedsOrchestrator("report_validation_result", "medium", events[2]?.payload), true);
  assert.equal(safetyEventNeedsOrchestrator("handoff_to_integration", "low"), false);
}

function testRepo(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-agent-safety-"));
  const dbPath = path.join(tempDir, "test.sqlite");
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(fs.readFileSync(path.resolve(process.cwd(), "schema.sql"), "utf8"));
  try {
    db.prepare("INSERT INTO projects (id, guild_id, channel_id, repo_path, worktrees_path) VALUES (1, 'g', 'c', '/repo', '/w')").run();
    db.prepare(
      "INSERT INTO orchestrations (id, project_id, author_user_id, status, goal, min_agents, max_agents, auto_start_children) VALUES (10, 1, 'u', 'PLANNING', 'goal', 1, 3, 0)",
    ).run();
    const repo = new OrchestrationSafetyRepo(db);
    const record = repo.create({
      orchestrationId: 10,
      kind: "request_interface_change",
      title: "Change API payload",
      body: "Need to add a required field.",
      severity: "medium",
      needsOrchestratorAction: true,
      payload: { interfaceName: "POST /api/example" },
    });
    assert.equal(record.status, "open");
    assert.equal(record.needsOrchestratorAction, true);
    assert.equal(repo.listByOrchestrationId(10).length, 1);

    const approved = repo.updateStatus(record.id, "approved");
    assert.equal(approved?.status, "approved");
    assert.equal(approved?.needsOrchestratorAction, false);
    assert.ok(approved?.resolvedAt);
    const revisions = repo.listContractRevisions(10);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.revisionKind, "interface");

    const ready = repo.create({
      orchestrationId: 10,
      kind: "notify_dependency_ready",
      title: "Types ready",
    });
    assert.equal(ready.status, "resolved");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
