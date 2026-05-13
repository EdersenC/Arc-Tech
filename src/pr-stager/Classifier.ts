import type { AgentCompletion } from "./AgentCompletion.js";
import type { GitDiffFacts, PullRequestType } from "./Types.js";

export function classifyPullRequest(diff: GitDiffFacts, completion: AgentCompletion): PullRequestType {
  const files = diff.files.map((file) => file.path);
  if (files.length === 0) return "chore";
  if (isBroad(files)) return "mixed";
  if (mostly(files, isDocPath)) return "docs";
  if (mostly(files, isTestPath)) return "test";
  if (mostly(files, isConfigPath)) return "config";
  if (files.some(isContractPath)) return "contract";
  if (mostly(files, isChorePath)) return "chore";

  const text = [...completion.summary, ...completion.changes, ...completion.reviewFocus].join(" ").toLowerCase();
  if (/\b(refactor|move|rename|restructure|split|extract)\b/.test(text)) return "refactor";
  if (/\b(fix|bug|regression|patch|crash|error)\b/.test(text)) return "patch";
  return "implementation";
}

function mostly(files: string[], predicate: (path: string) => boolean): boolean {
  return files.filter(predicate).length / files.length >= 0.7;
}

function isBroad(files: string[]): boolean {
  const roots = new Set(files.map((file) => file.split("/")[0] ?? file));
  return roots.size >= 5 || files.length > 30;
}

function isDocPath(path: string): boolean {
  return /(^|\/)(docs?|README|CHANGELOG|CONTRIBUTING)|\.(md|mdx|rst|txt)$/i.test(path);
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|fixtures)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function isConfigPath(path: string): boolean {
  return /(^|\/)(\.github|\.vscode|config)(\/|$)|(^|\/)(package-lock|pnpm-lock|yarn\.lock|tsconfig|vite\.config|eslint|prettier|dockerfile|compose|\.env\.example)/i.test(path) || /\.(json|ya?ml|toml|ini)$/i.test(path);
}

function isContractPath(path: string): boolean {
  return /(^|\/)(schema|schemas|contracts?|protocols?|types)(\/|$)|\.(proto|graphql|gql)$/i.test(path);
}

function isChorePath(path: string): boolean {
  return /(^|\/)(scripts?|tools?|bin|\.github)(\/|$)|(^|\/)(package-lock|pnpm-lock|yarn\.lock)/i.test(path);
}
