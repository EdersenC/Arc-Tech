import type { ArcWorkflowGraph, ArcWorkflowLayoutHint, ArcWorkflowNode } from "./api";

export interface WorkflowAvoidRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkflowNodeLayout {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lane: string;
  sectionId: string;
  order: number;
}

export interface WorkflowSectionLayout {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkflowLayoutResult {
  nodes: Map<string, WorkflowNodeLayout>;
  sections: WorkflowSectionLayout[];
}

export interface WorkflowLayoutOptions {
  avoidRects?: WorkflowAvoidRect[];
  baseX?: number;
  baseY?: number;
}

const NODE_WIDTH = 300;
const MIN_NODE_HEIGHT = 120;
const COLUMN_GAP = 72;
const ROW_GAP = 34;
const SECTION_PAD = 26;
const SECTION_TITLE_HEIGHT = 38;

const KIND_LANES = [
  ["goal", "Goals"],
  ["requirement", "Requirements"],
  ["decision", "Decisions"],
  ["system_component", "System"],
  ["frontend_component", "Frontend"],
  ["backend_component", "Backend"],
  ["data_store", "Data"],
  ["external_service", "External"],
  ["agent_task", "Agent Tasks"],
  ["milestone", "Milestones"],
  ["risk", "Risks"],
  ["open_question", "Questions"],
  ["note", "Notes"],
] as const;

const KIND_LANE_LABELS = new Map<string, string>(KIND_LANES);

export function layoutWorkflowGraph(graph: ArcWorkflowGraph, options: WorkflowLayoutOptions = {}): WorkflowLayoutResult {
  const hintByNodeId = new Map(graph.layoutHints.map((hint) => [hint.nodeId, hint]));
  const lanes = groupedNodes(graph.nodes, hintByNodeId);
  const base = workflowBase(options.avoidRects ?? [], options.baseX, options.baseY);
  const nodes = new Map<string, WorkflowNodeLayout>();
  const sections: WorkflowSectionLayout[] = [];
  let currentX = base.x;

  lanes.forEach((laneNodes, lane) => {
    const sectionId = stableSectionId(lane);
    let currentY = base.y + SECTION_PAD + SECTION_TITLE_HEIGHT;
    let maxHeight = SECTION_PAD + SECTION_TITLE_HEIGHT;
    laneNodes.forEach((node, index) => {
      const hint = hintByNodeId.get(node.id);
      const height = nodeHeight(node);
      const layout: WorkflowNodeLayout = {
        nodeId: node.id,
        x: hintX(hint, currentX),
        y: hintY(hint, currentY),
        width: NODE_WIDTH,
        height,
        lane,
        sectionId: hint?.sectionId ?? sectionId,
        order: hint?.order ?? index,
      };
      nodes.set(node.id, layout);
      currentY = Math.max(currentY, layout.y + height + ROW_GAP);
      maxHeight = Math.max(maxHeight, layout.y - base.y + height + SECTION_PAD);
    });
    sections.push({
      id: sectionId,
      title: lane,
      x: currentX - SECTION_PAD,
      y: base.y,
      width: NODE_WIDTH + SECTION_PAD * 2,
      height: Math.max(240, maxHeight),
    });
    currentX += NODE_WIDTH + COLUMN_GAP;
  });

  return { nodes, sections };
}

function groupedNodes(nodes: ArcWorkflowNode[], hintByNodeId: Map<string, ArcWorkflowLayoutHint>): Map<string, ArcWorkflowNode[]> {
  const lanes = new Map<string, ArcWorkflowNode[]>();
  const laneOrder = new Map<string, number>();
  KIND_LANES.forEach(([, label], index) => laneOrder.set(label, index));

  for (const node of nodes) {
    const hint = hintByNodeId.get(node.id);
    const lane = hint?.lane || hint?.group || KIND_LANE_LABELS.get(node.kind) || titleCase(node.kind);
    const values = lanes.get(lane) ?? [];
    values.push(node);
    lanes.set(lane, values);
    if (!laneOrder.has(lane)) {
      laneOrder.set(lane, 100 + stableHash(lane) % 100);
    }
  }

  for (const [lane, values] of lanes) {
    values.sort((left, right) => {
      const leftHint = hintByNodeId.get(left.id);
      const rightHint = hintByNodeId.get(right.id);
      const orderDelta = (leftHint?.order ?? Number.MAX_SAFE_INTEGER) - (rightHint?.order ?? Number.MAX_SAFE_INTEGER);
      if (orderDelta !== 0) return orderDelta;
      return left.id.localeCompare(right.id);
    });
    lanes.set(lane, values);
  }

  return new Map([...lanes.entries()].sort(([left], [right]) => (laneOrder.get(left) ?? 999) - (laneOrder.get(right) ?? 999)));
}

function workflowBase(avoidRects: WorkflowAvoidRect[], baseX?: number, baseY?: number): { x: number; y: number } {
  if (typeof baseX === "number" && typeof baseY === "number") {
    return { x: Math.round(baseX), y: Math.round(baseY) };
  }
  if (avoidRects.length === 0) {
    return { x: 80, y: 760 };
  }
  const maxRight = Math.max(...avoidRects.map((rect) => rect.x + rect.width));
  const minTop = Math.min(...avoidRects.map((rect) => rect.y));
  return {
    x: Math.round(maxRight + 120),
    y: Math.round(Math.min(760, Math.max(80, minTop))),
  };
}

function nodeHeight(node: ArcWorkflowNode): number {
  const text = [node.title, node.summary, node.body].filter(Boolean).join(" ");
  return Math.max(MIN_NODE_HEIGHT, Math.min(220, 96 + Math.ceil(text.length / 44) * 18));
}

function hintX(hint: ArcWorkflowLayoutHint | undefined, fallback: number): number {
  return fallback + (hint ? stableHash(`${hint.id}:x`) % 11 : 0);
}

function hintY(hint: ArcWorkflowLayoutHint | undefined, fallback: number): number {
  if (hint?.order !== undefined) return fallback;
  return fallback + (hint ? stableHash(`${hint.id}:y`) % 9 : 0);
}

function stableSectionId(lane: string): string {
  return `section-${lane.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow"}`;
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
