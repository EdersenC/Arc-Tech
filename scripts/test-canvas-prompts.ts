import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { CanvasPromptRepo, canvasPromptDispatchHash } from "../src/canvas-prompts/CanvasPromptRepo.js";
import { parsePromptText } from "../src/canvas-prompts/commandParser.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-canvas-prompts-"));
const dbPath = path.join(tempDir, "test.sqlite");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
db.exec(fs.readFileSync(path.resolve(process.cwd(), "schema.sql"), "utf8"));

try {
  db.prepare("INSERT INTO projects (id, guild_id, channel_id, repo_path, worktrees_path) VALUES (1, 'g', 'c', '/repo', '/w')").run();
  const repo = new CanvasPromptRepo(db);

  assert.deepEqual(parsePromptText("/orcharstarte build the thing", "plan"), {
    commandKind: "orchestrate",
    commandText: "/orchestrate",
    body: "build the thing",
  });
  assert.deepEqual(parsePromptText("/agent fix it", "orchestrate"), {
    commandKind: "implement",
    commandText: "/implement",
    body: "fix it",
  });
  assert.deepEqual(parsePromptText("plain body", "answer"), {
    commandKind: "answer",
    commandText: "/answer",
    body: "plain body",
  });
  assert.deepEqual(parsePromptText("/done-planning launch it", "orchestrate"), {
    commandKind: "start_work",
    commandText: "/start-work",
    body: "launch it",
  });
  assert.deepEqual(parsePromptText("/update-plan use the answers", "orchestrate"), {
    commandKind: "continue_planning",
    commandText: "/continue-planning",
    body: "use the answers",
  });

  const prompt = repo.createPrompt({
    projectId: 1,
    ownerId: "local-test",
    ownerLabel: "Test user",
    commandKind: "orchestrate",
    body: "continue from this node",
    x: 10,
    y: 20,
  });
  assert.equal(repo.listByProject(1).prompts.length, 1);

  const link = repo.createLink({
    projectId: 1,
    promptNodeId: prompt.id,
    ownerId: prompt.ownerId,
    targetKind: "workflow_node",
    targetId: "goal-node",
    orchestrationId: 7,
    workflowGraphId: "workflow-1",
    workflowNodeId: "goal-node",
  });
  assert.equal(repo.listByProject(1).links.length, 1);
  assert.throws(
    () => repo.createLink({
      projectId: 1,
      promptNodeId: prompt.id,
      ownerId: prompt.ownerId,
      targetKind: "task_card",
      targetId: "card-1",
    }),
    /Only one workflow target/,
  );

  const linkedDraft = repo.createPrompt({
    projectId: 1,
    ownerId: "local-test",
    ownerLabel: "Test user",
    commandKind: "answer",
    body: "not dispatched",
    x: 5,
    y: 5,
  });
  repo.createLink({
    projectId: 1,
    promptNodeId: linkedDraft.id,
    ownerId: linkedDraft.ownerId,
    targetKind: "open_question",
    targetId: "question-1",
    orchestrationId: 7,
    workflowNodeId: "question-1",
  });
  assert.deepEqual(repo.deletePrompt(linkedDraft.id), { deleted: true, locked: false });

  const hash = canvasPromptDispatchHash(prompt, link);
  repo.markDispatchSent(link.id, hash);
  assert.equal(repo.deletePrompt(prompt.id).locked, true);
  assert.equal(repo.deleteLink(link.id).locked, true);

  const updated = repo.updatePrompt(prompt.id, { body: "changed" });
  assert.equal(updated?.status, "dirty");
  assert.equal(repo.findLink(link.id)?.status, "dirty");

  const draft = repo.createPrompt({
    projectId: 1,
    ownerId: "local-test",
    ownerLabel: "Test user",
    commandKind: "plan",
    body: "draft",
    x: 0,
    y: 0,
  });
  assert.deepEqual(repo.deletePrompt(draft.id), { deleted: true, locked: false });
  assert.equal(repo.findPrompt(draft.id), null);

  console.log("Canvas prompt tests passed.");
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
