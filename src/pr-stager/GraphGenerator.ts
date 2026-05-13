import { sanitizeRepoPath } from "./Sanitizer.js";
import type { GitDiffFacts, PullRequestType } from "./Types.js";

export function impactGraph(type: PullRequestType, diff: GitDiffFacts): string | null {
  if (!["implementation", "contract", "mixed", "refactor"].includes(type)) {
    return null;
  }
  const files = diff.files.slice(0, 12).map((file) => sanitizeRepoPath(file.path));
  if (!files.length) return null;

  const lines = ["```mermaid", "flowchart TD", "  PR[PR changes]"];
  const roots = new Map<string, string[]>();
  for (const file of files) {
    const root = file.includes("/") ? file.split("/")[0] : ".";
    roots.set(root, [...(roots.get(root) ?? []), file]);
  }
  let index = 0;
  for (const [root, rootFiles] of roots) {
    const rootId = `R${index++}`;
    lines.push(`  PR --> ${rootId}[${mermaidLabel(root)}]`);
    for (const file of rootFiles.slice(0, 5)) {
      const fileId = `F${index++}`;
      lines.push(`  ${rootId} --> ${fileId}[${mermaidLabel(file)}]`);
    }
  }
  lines.push("```");
  return lines.join("\n");
}

function mermaidLabel(value: string): string {
  return value.replace(/["[\]{}<>]/g, "").slice(0, 80);
}
