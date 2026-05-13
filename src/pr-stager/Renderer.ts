import type { AgentCompletion } from "./AgentCompletion.js";
import { impactGraph } from "./GraphGenerator.js";
import { assertNoPrLeaks, sanitizeLine, sanitizeRepoPath } from "./Sanitizer.js";
import type { GitDiffFacts, PullRequestType } from "./Types.js";

export function renderPullRequestBody(input: {
  completion: AgentCompletion;
  diff: GitDiffFacts;
  type: PullRequestType;
}): string {
  const { completion, diff, type } = input;
  const body = [
    "## Summary",
    bulletList(completion.summary),
    "",
    "## What changed",
    bulletList(completion.changes.length ? completion.changes : diff.files.slice(0, 8).map((file) => `${file.status} ${file.path}`)),
    "",
    "## Verification",
    verificationList(completion),
    "",
    "## Risk / follow-up",
    bulletList([...completion.risks, ...completion.followUps, ...contractNotes(completion)], "No known risks or follow-ups were reported."),
    "",
    "## Review focus",
    bulletList(completion.reviewFocus.length ? completion.reviewFocus : reviewFocusFromDiff(diff)),
    "",
    "## Diff summary",
    diffSummary(diff, type),
    "",
    "## Impact graph",
    impactGraph(type, diff) ?? "Not generated for this PR type.",
    "",
    "## Comparison",
    comparisonSection(completion),
    "",
  ].join("\n");
  assertNoPrLeaks(body);
  return body;
}

function contractNotes(completion: AgentCompletion): string[] {
  return [
    ...completion.contractDeviations.map((item) => `Contract deviation: ${item}`),
    ...completion.newInterfaces.map((item) => `New interface: ${item}`),
  ];
}

function bulletList(items: string[], empty = "No details provided."): string {
  const cleaned = items.map((item) => sanitizeLine(item)).filter(Boolean);
  return cleaned.length ? cleaned.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

function verificationList(completion: AgentCompletion): string {
  if (!completion.verification.length) return "- Not reported.";
  return completion.verification
    .map((item) => {
      const notes = item.notes ? ` - ${sanitizeLine(item.notes)}` : "";
      return `- ${sanitizeLine(item.command)}: ${item.result}${notes}`;
    })
    .join("\n");
}

function reviewFocusFromDiff(diff: GitDiffFacts): string[] {
  return diff.files.slice(0, 5).map((file) => `Review ${file.status} ${sanitizeRepoPath(file.path)}`);
}

function diffSummary(diff: GitDiffFacts, type: PullRequestType): string {
  const fileLines = diff.files
    .slice(0, 20)
    .map((file) => {
      const churn = file.additions === null || file.deletions === null ? "" : ` (+${file.additions}/-${file.deletions})`;
      return `- ${file.status} ${sanitizeRepoPath(file.path)}${churn}`;
    })
    .join("\n");
  return [
    `- Type: ${type}`,
    `- Base: ${sanitizeLine(diff.baseBranch, 80)}`,
    `- Head: ${sanitizeLine(diff.headBranch, 80)}`,
    `- Files changed: ${diff.files.length}`,
    diff.stat ? "```text\n" + sanitizeDiffStat(diff.stat) + "\n```" : "- No git stat available.",
    fileLines,
  ].filter(Boolean).join("\n");
}

function sanitizeDiffStat(stat: string): string {
  const lines = stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 25);
  for (const line of lines) assertNoPrLeaks(line);
  return lines.join("\n");
}

function comparisonSection(completion: AgentCompletion): string {
  const comparison = completion.comparison;
  if (!comparison?.baseline) {
    return "No baseline comparison data provided.";
  }
  const lines = [
    `- Baseline: ${sanitizeLine(comparison.baseline)}`,
    comparison.current ? `- Current: ${sanitizeLine(comparison.current)}` : null,
    ...(comparison.notes ?? []).map((note) => `- ${sanitizeLine(note)}`),
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}
