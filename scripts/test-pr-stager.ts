import assert from "node:assert/strict";
import { parseNameStatus, parseNumstat } from "../src/git.js";
import { parseAgentCompletion } from "../src/pr-stager/AgentCompletion.js";
import { classifyPullRequest } from "../src/pr-stager/Classifier.js";
import { renderPullRequestBody } from "../src/pr-stager/Renderer.js";
import { findPrLeaks } from "../src/pr-stager/Sanitizer.js";
import { stagePullRequest } from "../src/pr-stager/PrStager.js";
import type { GitDiffFacts } from "../src/pr-stager/Types.js";
import type { Task } from "../src/types.js";

const cleanCompletionBlock = `Done.

\`\`\`ARC_AGENT_COMPLETION_JSON
{
  "summary": ["Adds a safe PR staging flow."],
  "changes": ["Renders a reviewer-focused PR body from structured completion data."],
  "verification": [{"command": "npm run build", "result": "passed"}],
  "risks": ["Existing open PRs will be edited with the new body format."],
  "followUps": [],
  "reviewFocus": ["Check the sanitizer and rendered body shape."],
  "prTitle": "Add PR stager"
}
\`\`\``;

const baseDiff: GitDiffFacts = {
  baseBranch: "main",
  headBranch: "codex/task-8",
  stat: " src/pr-stager/Renderer.ts | 42 +++++\n 1 file changed, 42 insertions(+)",
  files: [{ path: "src/pr-stager/Renderer.ts", status: "added", additions: 42, deletions: 0 }],
};

tableSanitizer();
testParser();
testGitFixtureParsing();
testClassifier();
testRendererSnapshot();
testLeakRegression();
console.log("PR stager tests passed.");

function tableSanitizer(): void {
  const blocked = [
    "/home/eddy/.arc-tech/excalidraw-workspaces/task-8",
    "/Users/eddy/project",
    "WorkflowGraph: { nodes: [] }",
    "Detailed prompt:\nsecret",
    "Rules:\n- internal",
    "system/developer instructions",
    "worktrees/task-1",
  ];
  for (const value of blocked) {
    assert.ok(findPrLeaks(value).length > 0, `expected leak in ${value}`);
  }
  const clean = ["src/pr-stager/Renderer.ts", "web/src/App.tsx", "docs/pr-stager.md"];
  for (const value of clean) {
    assert.equal(findPrLeaks(value).length, 0, `expected clean value ${value}`);
  }
}

function testParser(): void {
  const parsed = parseAgentCompletion(cleanCompletionBlock);
  assert.deepEqual(parsed.summary, ["Adds a safe PR staging flow."]);
  assert.equal(parsed.verification[0]?.result, "passed");
}

function testGitFixtureParsing(): void {
  const files = parseNameStatus("A\tsrc/new.ts\nM\tREADME.md\nR100\tsrc/old.ts\tsrc/new-name.ts\n");
  const stats = parseNumstat("10\t0\tsrc/new.ts\n2\t1\tREADME.md\n5\t3\tsrc/new-name.ts\n4\t2\tsrc/{old-name.ts => renamed-name.ts}\n");
  assert.deepEqual(files, [
    { status: "added", path: "src/new.ts" },
    { status: "modified", path: "README.md" },
    { status: "renamed", path: "src/new-name.ts" },
  ]);
  assert.deepEqual(stats.get("src/new-name.ts"), { additions: 5, deletions: 3 });
  assert.deepEqual(stats.get("src/renamed-name.ts"), { additions: 4, deletions: 2 });
}

function testClassifier(): void {
  const completion = parseAgentCompletion(cleanCompletionBlock);
  const cases: Array<[string, string[], string]> = [
    ["implementation", ["src/service.ts", "src/api.ts"], "add feature"],
    ["patch", ["src/service.ts", "src/service.test.ts"], "fix bug regression"],
    ["chore", ["scripts/build.ts", "package-lock.json"], "update tooling"],
    ["refactor", ["src/a.ts", "src/b.ts"], "refactor module boundaries"],
    ["docs", ["README.md", "docs/usage.md"], "docs"],
    ["test", ["src/foo.test.ts", "tests/foo.spec.ts"], "tests"],
    ["config", ["tsconfig.json", ".github/workflows/ci.yml"], "config"],
    ["contract", ["src/types/api.ts", "schema.sql"], "schema contracts"],
    ["mixed", ["src/a.ts", "web/a.ts", "docs/a.md", "scripts/a.ts", "schema.sql"], "broad"],
  ];
  for (const [expected, paths, text] of cases) {
    const diff = diffFor(paths);
    const actual = classifyPullRequest(diff, { ...completion, summary: [text], changes: [text] });
    assert.equal(actual, expected);
  }
}

function testRendererSnapshot(): void {
  const completion = parseAgentCompletion(cleanCompletionBlock);
  const body = renderPullRequestBody({ completion, diff: baseDiff, type: "implementation" });
  assert.equal(body, `## Summary
- Adds a safe PR staging flow.

## What changed
- Renders a reviewer-focused PR body from structured completion data.

## Verification
- npm run build: passed

## Risk / follow-up
- Existing open PRs will be edited with the new body format.

## Review focus
- Check the sanitizer and rendered body shape.

## Diff summary
- Type: implementation
- Base: main
- Head: codex/task-8
- Files changed: 1
\`\`\`text
src/pr-stager/Renderer.ts | 42 +++++
1 file changed, 42 insertions(+)
\`\`\`
- added src/pr-stager/Renderer.ts (+42/-0)

## Impact graph
\`\`\`mermaid
flowchart TD
  PR[PR changes]
  PR --> R0[src]
  R0 --> F1[src/pr-stager/Renderer.ts]
\`\`\`

## Comparison
No baseline comparison data provided.
`);
}

function testLeakRegression(): void {
  const task = fakeTask();
  const staged = stagePullRequest({
    task,
    agentOutput: `\`\`\`ARC_AGENT_COMPLETION_JSON
{"summary":["Uses /home/eddy/.arc-tech/excalidraw-workspaces/x"],"changes":["WorkflowGraph dump"],"verification":[],"risks":[],"followUps":[],"reviewFocus":[],"prTitle":"leaky"}
\`\`\``,
    diff: baseDiff,
    fallbackTitle: "fallback",
  });
  assert.equal(findPrLeaks(staged.body).length, 0);
  assert.match(staged.body, /sanitized reviewer context/);
  assert.doesNotThrow(() => stagePullRequest({ task, agentOutput: cleanCompletionBlock, diff: baseDiff, fallbackTitle: "fallback" }));
}

function diffFor(paths: string[]): GitDiffFacts {
  return {
    baseBranch: "main",
    headBranch: "codex/task-test",
    stat: `${paths.length} files changed`,
    files: paths.map((filePath) => ({ path: filePath, status: "modified", additions: 1, deletions: 0 })),
  };
}

function fakeTask(): Task {
  return {
    id: 1,
    projectId: 1,
    projectTaskNumber: 1,
    guildId: "guild",
    channelId: "channel",
    discordThreadId: null,
    status: "WAITING_REVIEW",
    mergeStatus: "none",
    prompt: "Do the task",
    requestedBy: null,
    mode: "implement",
    sandbox: "workspace-write",
    model: "model",
    effort: "medium",
    baseBranch: "main",
    taskBranch: "codex/task-1",
    worktreePath: null,
    codexThreadId: null,
    liveStatusMessageId: null,
    controlPanelMessageId: null,
    pullRequestUrl: null,
    prUrl: null,
    finalSummary: null,
    completionSummary: null,
    discordThreadUrl: null,
    parentOrchestrationId: null,
    orchestrationAgentId: null,
    agentRole: null,
    error: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
}
