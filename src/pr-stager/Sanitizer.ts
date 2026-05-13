export interface LeakFinding {
  label: string;
  match: string;
}

export class PrLeakError extends Error {
  constructor(readonly findings: LeakFinding[]) {
    super(`PR body failed leak detection: ${findings.map((finding) => finding.label).join("; ")}`);
    this.name = "PrLeakError";
  }
}

const LEAK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "absolute /home path", pattern: /\/home\/[^\s)"'`<]+/i },
  { label: "absolute /Users path", pattern: /\/Users\/[^\s)"'`<]+/i },
  { label: "Windows absolute path", pattern: /[A-Za-z]:\\[^\s)"'`<]+/ },
  { label: ".arc-tech internal path", pattern: /\.arc-tech/i },
  { label: "worktree internals", pattern: /\bworktrees?\b/i },
  { label: "Excalidraw workspace internals", pattern: /excalidraw-workspaces/i },
  { label: "WorkflowGraph dump", pattern: /WorkflowGraph/i },
  { label: "detailed prompt", pattern: /Detailed prompt/i },
  { label: "internal rules", pattern: /(?:^|\n)\s*Rules\s*:/i },
  { label: "system instructions", pattern: /system\/developer instructions|developer instructions|system instructions/i },
  { label: "raw task prompt", pattern: /(?:^|\n)\s*(?:Original request|Task prompt|Raw prompt)\s*:/i },
];

export function findPrLeaks(value: string): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const { label, pattern } of LEAK_PATTERNS) {
    const match = pattern.exec(value);
    if (match?.[0]) {
      findings.push({ label, match: match[0] });
    }
  }
  return findings;
}

export function assertNoPrLeaks(value: string): void {
  const findings = findPrLeaks(value);
  if (findings.length) {
    throw new PrLeakError(findings);
  }
}

export function sanitizeLine(value: string, max = 220): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function sanitizeRepoPath(value: string): string {
  const cleaned = value.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (!cleaned || cleaned.startsWith("/") || cleaned.includes("..")) {
    throw new PrLeakError([{ label: "non repo-relative path", match: value }]);
  }
  assertNoPrLeaks(cleaned);
  return cleaned;
}
