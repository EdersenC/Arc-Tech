import type { Task } from "../types.js";
import { parseAgentCompletion } from "./AgentCompletion.js";
import { classifyPullRequest } from "./Classifier.js";
import { renderPullRequestBody } from "./Renderer.js";
import { assertNoPrLeaks, sanitizeLine } from "./Sanitizer.js";
import type { GitDiffFacts, StagedPullRequest } from "./Types.js";

export function stagePullRequest(input: {
  task: Task;
  agentOutput: string;
  diff: GitDiffFacts;
  fallbackTitle: string;
}): StagedPullRequest {
  const completion = parseAgentCompletion(input.agentOutput);
  const type = classifyPullRequest(input.diff, completion);
  const title = sanitizeLine(completion.prTitle || input.fallbackTitle, 100) || input.fallbackTitle;
  assertNoPrLeaks(title);
  const body = renderPullRequestBody({ completion, diff: input.diff, type });
  assertNoPrLeaks(body);
  return { title, body, type };
}
