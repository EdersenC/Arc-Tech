import type { ArcCanvasPromptCommandKind } from "../api";

const aliasToKind: Record<string, ArcCanvasPromptCommandKind> = {
  orchestrate: "orchestrate",
  orch: "orchestrate",
  orcharstarte: "orchestrate",
  orchstart: "orchestrate",
  implement: "implement",
  agent: "implement",
  plan: "plan",
  "plan-card": "plan",
  answer: "answer",
  "question-reply": "answer",
  continue: "continue_planning",
  "continue-planning": "continue_planning",
  "update-plan": "continue_planning",
  start: "start_work",
  "start-work": "start_work",
  "start-agents": "start_work",
  launch: "start_work",
  enough: "start_work",
  "enough-plan": "start_work",
  "done-planning": "start_work",
  remake: "remake_plan",
  "remake-plan": "remake_plan",
};

export const commandLabels: Record<ArcCanvasPromptCommandKind, string> = {
  orchestrate: "Orchestrate",
  implement: "Implement",
  plan: "Plan Card",
  answer: "Answer",
  continue_planning: "Continue Planning",
  start_work: "Start Work",
  remake_plan: "Remake Plan",
};

export function canonicalCommand(kind: ArcCanvasPromptCommandKind): string {
  if (kind === "implement") return "/implement";
  if (kind === "plan") return "/plan";
  if (kind === "answer") return "/answer";
  if (kind === "continue_planning") return "/continue-planning";
  if (kind === "start_work") return "/start-work";
  if (kind === "remake_plan") return "/remake-plan";
  return "/orchestrate";
}

export function normalizeCommand(value: string | undefined | null, fallback: ArcCanvasPromptCommandKind = "orchestrate"): ArcCanvasPromptCommandKind {
  const raw = (value ?? "").trim().replace(/^\//, "").toLowerCase();
  return aliasToKind[raw] ?? fallback;
}

export function parsePromptText(text: string, fallback: ArcCanvasPromptCommandKind): {
  commandKind: ArcCanvasPromptCommandKind;
  body: string;
  text: string;
} {
  const trimmed = text.trim();
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) {
    return { commandKind: fallback, body: trimmed, text: promptText(fallback, trimmed) };
  }
  const commandKind = normalizeCommand(match[1], fallback);
  const body = (match[2] ?? "").trim();
  return { commandKind, body, text: promptText(commandKind, body) };
}

export function promptText(kind: ArcCanvasPromptCommandKind, body: string): string {
  const command = canonicalCommand(kind);
  const trimmed = body.trim();
  return trimmed ? `${command} ${trimmed}` : command;
}
