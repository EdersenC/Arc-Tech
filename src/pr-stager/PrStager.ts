import type { Task } from "../types.js";
import { parseAgentCompletion, type AgentCompletion } from "./AgentCompletion.js";
import { classifyPullRequest } from "./Classifier.js";
import { renderPullRequestBody } from "./Renderer.js";
import { assertNoPrLeaks, findPrLeaks, sanitizeLine } from "./Sanitizer.js";
import type { GitDiffFacts, StagedPullRequest } from "./Types.js";

export function stagePullRequest(input: {
  task: Task;
  agentOutput: string;
  diff: GitDiffFacts;
  fallbackTitle: string;
}): StagedPullRequest {
  const completion = sanitizeCompletion(parseAgentCompletion(input.agentOutput));
  const type = classifyPullRequest(input.diff, completion);
  const title = safeTitle(completion.prTitle, input.fallbackTitle);
  assertNoPrLeaks(title);
  const body = renderPullRequestBody({ completion, diff: input.diff, type });
  assertNoPrLeaks(body);
  return { title, body, type };
}

function sanitizeCompletion(completion: AgentCompletion): AgentCompletion {
  return {
    ...completion,
    summary: cleanLines(completion.summary, ["Implements task changes with sanitized reviewer context."]),
    changes: cleanLines(completion.changes),
    verification: completion.verification
      .map((item) => ({
        command: safeLine(item.command),
        result: item.result,
        notes: item.notes ? safeLine(item.notes) : undefined,
      }))
      .filter((item) => item.command),
    risks: cleanLines(completion.risks),
    followUps: cleanLines(completion.followUps),
    reviewFocus: cleanLines(completion.reviewFocus),
    contractDeviations: cleanLines(completion.contractDeviations),
    newInterfaces: cleanLines(completion.newInterfaces),
    prTitle: completion.prTitle ? safeLine(completion.prTitle) : undefined,
    comparison: completion.comparison
      ? {
          baseline: completion.comparison.baseline ? safeLine(completion.comparison.baseline) : undefined,
          current: completion.comparison.current ? safeLine(completion.comparison.current) : undefined,
          notes: cleanLines(completion.comparison.notes ?? []),
        }
      : undefined,
  };
}

function cleanLines(values: readonly string[], fallback: string[] = []): string[] {
  const cleaned = values.map(safeLine).filter(Boolean);
  return cleaned.length ? cleaned : fallback;
}

function safeLine(value: string): string {
  const cleaned = sanitizeLine(value);
  return cleaned && findPrLeaks(cleaned).length === 0 ? cleaned : "";
}

function safeTitle(prTitle: string | undefined, fallbackTitle: string): string {
  const fromAgent = prTitle ? safeLine(prTitle).slice(0, 100) : "";
  if (fromAgent) return fromAgent;
  const fallback = safeLine(fallbackTitle).slice(0, 100);
  return fallback || "Arc-Tech task";
}
