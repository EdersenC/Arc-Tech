import type { CanvasPromptCommandKind } from "./types.js";

const ALIAS_TO_KIND: Record<string, CanvasPromptCommandKind> = {
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

const KIND_TO_COMMAND: Record<CanvasPromptCommandKind, string> = {
  orchestrate: "/orchestrate",
  implement: "/implement",
  plan: "/plan",
  answer: "/answer",
  continue_planning: "/continue-planning",
  start_work: "/start-work",
  remake_plan: "/remake-plan",
};

export function normalizePromptCommand(value: string | undefined | null): CanvasPromptCommandKind {
  const raw = (value ?? "").trim().replace(/^\//, "").toLowerCase();
  return ALIAS_TO_KIND[raw] ?? "orchestrate";
}

export function canonicalPromptCommand(kind: CanvasPromptCommandKind): string {
  return KIND_TO_COMMAND[kind];
}

export function parsePromptText(input: string, fallback: CanvasPromptCommandKind): {
  commandKind: CanvasPromptCommandKind;
  commandText: string;
  body: string;
} {
  const trimmed = input.trim();
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) {
    const commandText = canonicalPromptCommand(fallback);
    return { commandKind: fallback, commandText, body: trimmed };
  }
  const commandKind = normalizePromptCommand(match[1]);
  return {
    commandKind,
    commandText: canonicalPromptCommand(commandKind),
    body: (match[2] ?? "").trim(),
  };
}

export function promptText(commandKind: CanvasPromptCommandKind, body: string): string {
  const command = canonicalPromptCommand(commandKind);
  const trimmed = body.trim();
  return trimmed ? `${command} ${trimmed}` : command;
}
