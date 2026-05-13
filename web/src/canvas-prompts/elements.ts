import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ArcCanvasPromptLink, ArcCanvasPromptNode } from "../api";
import { promptText } from "./commands";
import { promptBoxElementId, promptCommandElementId, promptLinkElementId, promptTextElementId } from "./ids";

const FONT_FAMILY = { Helvetica: 2 } as const;
const PROMPT_HEADER_HEIGHT = 40;
const PROMPT_BODY_BOTTOM_PADDING = 10;
const PROMPT_MIN_WIDTH = 260;
const PROMPT_MIN_HEIGHT = 130;

type CanvasRect = { x: number; y: number; width: number; height: number };
type BoundElement = { type?: string; id?: string | null };

export type PromptElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: number[][];
  text?: string;
  startBinding?: { elementId?: string | null } | null;
  endBinding?: { elementId?: string | null } | null;
  boundElements?: BoundElement[] | null;
  containerId?: string | null;
  autoResize?: boolean;
  fontSize?: number;
  fontFamily?: number;
  lineHeight?: number;
  textAlign?: string;
  verticalAlign?: string;
  groupIds?: readonly string[];
  customData?: {
    arcPrompt?: PromptElementMetadata;
  };
};

export interface PromptElementMetadata {
  source: "canvas-prompt";
  role: "box" | "text" | "command" | "arrow";
  promptId: string;
  linkId?: string;
  ownerId: string;
  projectId: number;
  commandKind: string;
  status: string;
}

export function promptsToElements(
  prompts: ArcCanvasPromptNode[],
  links: ArcCanvasPromptLink[],
  targetRects: Map<string, CanvasRect>,
) {
  const elements: unknown[] = [];
  const promptBounds = new Map<string, { body: CanvasRect; command: CanvasRect }>();
  for (const prompt of prompts) {
    const colors = promptColors(prompt.commandKind, prompt.status);
    const groupId = `arc-prompt-${prompt.id}`;
    const display = promptText(prompt.commandKind, prompt.body);
    const commandBounds = promptCommandTextBounds(prompt);
    const bodyBounds = promptBodyTextBounds(prompt);
    promptBounds.set(prompt.id, { body: bodyBounds, command: commandBounds });
    elements.push({
      id: promptBoxElementId(prompt.id),
      type: "rectangle",
      x: prompt.x,
      y: prompt.y,
      width: prompt.width,
      height: prompt.height,
      strokeColor: colors.stroke,
      backgroundColor: colors.background,
      fillStyle: "solid",
      roughness: 0,
      opacity: 96,
      roundness: { type: 3 },
      groupIds: [groupId],
      customData: { arcPrompt: promptMetadata(prompt, "box") },
    });
    elements.push({
      id: promptCommandElementId(prompt.id),
      type: "text",
      ...commandBounds,
      text: `${prompt.commandText} · ${prompt.status} · ${prompt.ownerLabel}`,
      originalText: `${prompt.commandText} · ${prompt.status} · ${prompt.ownerLabel}`,
      fontSize: 13,
      fontFamily: FONT_FAMILY.Helvetica,
      textAlign: "left",
      verticalAlign: "top",
      strokeColor: colors.accent,
      backgroundColor: "transparent",
      groupIds: [groupId],
      customData: { arcPrompt: promptMetadata(prompt, "command") },
    });
    elements.push({
      id: promptTextElementId(prompt.id),
      type: "text",
      ...bodyBounds,
      text: display,
      originalText: display,
      fontSize: 17,
      fontFamily: FONT_FAMILY.Helvetica,
      autoResize: false,
      lineHeight: 1.25,
      textAlign: "center",
      verticalAlign: "top",
      strokeColor: colors.text,
      backgroundColor: "transparent",
      groupIds: [groupId],
      customData: { arcPrompt: promptMetadata(prompt, "text") },
    });
  }

  for (const link of links) {
    const prompt = prompts.find((candidate) => candidate.id === link.promptNodeId);
    const target = targetRects.get(link.targetId) ?? (link.targetWorkflowNodeId ? targetRects.get(link.targetWorkflowNodeId) : undefined);
    if (!prompt || !target) continue;
    const route = promptArrowRoute(prompt, target);
    elements.push({
      id: promptLinkElementId(link.id),
      type: "arrow",
      x: route.x,
      y: route.y,
      width: route.width,
      height: route.height,
      points: route.points,
      strokeColor: link.status === "failed" ? "#ef4444" : link.status === "sent" || link.status === "historical" ? "#22c55e" : link.status === "sending" ? "#fbbf24" : link.status === "waiting_for_body" ? "#f97316" : "#38bdf8",
      backgroundColor: "transparent",
      roughness: 0,
      endArrowhead: "arrow",
      customData: {
        arcPrompt: {
          source: "canvas-prompt",
          role: "arrow",
          promptId: prompt.id,
          linkId: link.id,
          ownerId: prompt.ownerId,
          projectId: prompt.projectId,
          commandKind: prompt.commandKind,
          status: link.status,
        },
      },
    });
  }
  const converted = convertToExcalidrawElements(elements as Parameters<typeof convertToExcalidrawElements>[0], {
    regenerateIds: false,
  });
  return converted.map((element) => {
    const metadata = (element as PromptElement).customData?.arcPrompt;
    if (!metadata) return element;
    const bounds = promptBounds.get(metadata.promptId);
    if (!bounds) return element;
    if (metadata.role === "text") {
      return { ...element, ...bounds.body, containerId: null, autoResize: false };
    }
    if (metadata.role === "command") {
      return { ...element, ...bounds.command, containerId: null, autoResize: false };
    }
    if (metadata.role === "box") {
      return { ...element, boundElements: stripPromptTextBinding((element as PromptElement).boundElements, metadata.promptId) };
    }
    return element;
  });
}

export function stripPromptTextBinding(boundElements: BoundElement[] | null | undefined, promptId: string): BoundElement[] | null {
  const kept = (boundElements ?? []).filter((boundElement) => boundElement.id !== promptTextElementId(promptId));
  return kept.length ? kept : null;
}

export function promptBodyTextBounds(box: CanvasRect): CanvasRect {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y + PROMPT_HEADER_HEIGHT),
    width: Math.max(PROMPT_MIN_WIDTH, Math.round(box.width)),
    height: Math.max(80, Math.round(box.height - PROMPT_HEADER_HEIGHT - PROMPT_BODY_BOTTOM_PADDING)),
  };
}

export function promptCommandTextBounds(box: CanvasRect): CanvasRect {
  return {
    x: Math.round(box.x + 16),
    y: Math.round(box.y + 12),
    width: Math.max(80, Math.round(box.width - 32)),
    height: 24,
  };
}

export function promptLayoutFromElements(elements: readonly PromptElement[]): Map<string, Partial<Pick<ArcCanvasPromptNode, "x" | "y" | "width" | "height" | "body" | "commandKind">> & { text?: string }> {
  const layouts = new Map<string, Partial<Pick<ArcCanvasPromptNode, "x" | "y" | "width" | "height" | "body" | "commandKind">> & { text?: string }>();
  for (const element of elements) {
    const promptId = element.customData?.arcPrompt?.promptId;
    if (!promptId) continue;
    if (element.id === promptBoxElementId(promptId)) {
      layouts.set(promptId, {
        ...(layouts.get(promptId) ?? {}),
        x: Math.round(element.x),
        y: Math.round(element.y),
        width: Math.max(PROMPT_MIN_WIDTH, Math.round(element.width)),
        height: Math.max(PROMPT_MIN_HEIGHT, Math.round(element.height)),
      });
      continue;
    }
    if (element.id === promptTextElementId(promptId) && typeof element.text === "string") {
      layouts.set(promptId, { ...(layouts.get(promptId) ?? {}), text: element.text });
    }
  }
  return layouts;
}

function promptMetadata(prompt: ArcCanvasPromptNode, role: "box" | "text" | "command"): PromptElementMetadata {
  return {
    source: "canvas-prompt",
    role,
    promptId: prompt.id,
    ownerId: prompt.ownerId,
    projectId: prompt.projectId,
    commandKind: prompt.commandKind,
    status: prompt.status,
  };
}

function promptColors(commandKind: string, status: string): { stroke: string; background: string; accent: string; text: string } {
  if (status === "failed") return { stroke: "#ef4444", background: "#2b1214", accent: "#fca5a5", text: "#fee2e2" };
  if (status === "sent" || status === "historical") return { stroke: "#22c55e", background: "#10251a", accent: "#86efac", text: "#dcfce7" };
  if (status === "dirty") return { stroke: "#f59e0b", background: "#2b2110", accent: "#fbbf24", text: "#fef3c7" };
  if (status === "waiting_for_body") return { stroke: "#f97316", background: "#2b1a10", accent: "#fdba74", text: "#ffedd5" };
  if (commandKind === "implement") return { stroke: "#38bdf8", background: "#0d2230", accent: "#7dd3fc", text: "#e0f2fe" };
  if (commandKind === "plan") return { stroke: "#a78bfa", background: "#211734", accent: "#c4b5fd", text: "#ede9fe" };
  if (commandKind === "answer") return { stroke: "#f472b6", background: "#321629", accent: "#f9a8d4", text: "#fce7f3" };
  if (commandKind === "continue_planning") return { stroke: "#2dd4bf", background: "#0f2827", accent: "#5eead4", text: "#ccfbf1" };
  if (commandKind === "start_work") return { stroke: "#facc15", background: "#2b250b", accent: "#fde047", text: "#fef9c3" };
  if (commandKind === "remake_plan") return { stroke: "#fb7185", background: "#2f111a", accent: "#fda4af", text: "#ffe4e6" };
  return { stroke: "#34d399", background: "#0f261f", accent: "#6ee7b7", text: "#d1fae5" };
}

function promptArrowRoute(prompt: ArcCanvasPromptNode, target: CanvasRect): { x: number; y: number; width: number; height: number; points: number[][] } {
  const promptCenter = { x: prompt.x + prompt.width / 2, y: prompt.y + prompt.height / 2 };
  const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const horizontal = Math.abs(targetCenter.x - promptCenter.x) >= Math.abs(targetCenter.y - promptCenter.y);
  const start = horizontal
    ? { x: targetCenter.x >= promptCenter.x ? prompt.x + prompt.width : prompt.x, y: promptCenter.y }
    : { x: promptCenter.x, y: targetCenter.y >= promptCenter.y ? prompt.y + prompt.height : prompt.y };
  const end = horizontal
    ? { x: targetCenter.x >= promptCenter.x ? target.x : target.x + target.width, y: targetCenter.y }
    : { x: targetCenter.x, y: targetCenter.y >= promptCenter.y ? target.y : target.y + target.height };
  return {
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
  };
}
