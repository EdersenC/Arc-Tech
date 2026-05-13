import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ArcPersistedWorkflowGraph, ArcWorkflowEdge, ArcWorkflowGraph, ArcWorkflowNode } from "./api";
import {
  workflowEdgeElementId,
  workflowEdgeLabelElementId,
  workflowNodeElementId,
  workflowNodeGroupId,
  workflowNodeLabelElementId,
  workflowSectionElementId,
  workflowSectionLabelElementId,
  workflowStatusElementId,
} from "./workflowIds";
import { layoutWorkflowGraph, type WorkflowAvoidRect, type WorkflowLayoutOptions } from "./workflowLayout";

const FONT_FAMILY = { Helvetica: 2 } as const;

export interface WorkflowElementOptions extends WorkflowLayoutOptions {
  persisted: ArcPersistedWorkflowGraph;
  avoidRects?: WorkflowAvoidRect[];
}

export interface WorkflowElementMetadata {
  graphId: string;
  projectId: number;
  orchestrationId: number | null;
  workflowNodeId?: string;
  workflowEdgeId?: string;
  semanticType: "node" | "node_label" | "status_badge" | "edge" | "edge_label" | "section";
  revision: number;
}

export type WorkflowExcalidrawElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  customData?: { arcWorkflow?: WorkflowElementMetadata };
};

export function graphToExcalidrawElements(graph: ArcWorkflowGraph, options: WorkflowElementOptions): readonly WorkflowExcalidrawElement[] {
  const layout = layoutWorkflowGraph(graph, options);
  const persisted = options.persisted;
  const elements: unknown[] = [];

  for (const section of layout.sections) {
    elements.push({
      id: workflowSectionElementId(graph.id, section.id),
      type: "rectangle",
      x: section.x,
      y: section.y,
      width: section.width,
      height: section.height,
      strokeColor: "#94a3b8",
      backgroundColor: "#f8fafc",
      fillStyle: "solid",
      opacity: 48,
      roughness: 0,
      strokeStyle: "dashed",
      locked: true,
      customData: { arcWorkflow: metadata(persisted, "section") },
    });
    elements.push({
      id: workflowSectionLabelElementId(graph.id, section.id),
      type: "text",
      x: section.x + 16,
      y: section.y + 12,
      width: section.width - 32,
      height: 24,
      text: section.title,
      fontSize: 16,
      fontFamily: FONT_FAMILY.Helvetica,
      strokeColor: "#334155",
      backgroundColor: "transparent",
      locked: true,
      customData: { arcWorkflow: metadata(persisted, "section") },
    });
  }

  for (const edge of graph.edges) {
    const from = layout.nodes.get(edge.fromNodeId);
    const to = layout.nodes.get(edge.toNodeId);
    if (!from || !to) continue;
    const route = edgeRoute(from, to);
    elements.push({
      id: workflowEdgeElementId(graph.id, edge.id),
      type: "arrow",
      x: route.x,
      y: route.y,
      width: route.width,
      height: route.height,
      points: route.points,
      strokeColor: edgeColor(edge),
      backgroundColor: "transparent",
      roughness: 0,
      endArrowhead: "arrow",
      locked: true,
      customData: { arcWorkflow: metadata(persisted, "edge", { workflowEdgeId: edge.id }) },
    });
    if (edge.label || edge.kind) {
      elements.push({
        id: workflowEdgeLabelElementId(graph.id, edge.id),
        type: "text",
        x: route.labelX,
        y: route.labelY,
        width: 120,
        height: 22,
        text: edge.label || edge.kind,
        fontSize: 12,
        fontFamily: FONT_FAMILY.Helvetica,
        strokeColor: "#475569",
        backgroundColor: "#f8fafc",
        locked: true,
        customData: { arcWorkflow: metadata(persisted, "edge_label", { workflowEdgeId: edge.id }) },
      });
    }
  }

  for (const node of graph.nodes) {
    const box = layout.nodes.get(node.id);
    if (!box) continue;
    const groupId = workflowNodeGroupId(graph.id, node.id);
    elements.push({
      id: workflowNodeElementId(graph.id, node.id),
      type: "rectangle",
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      strokeColor: nodeStrokeColor(node),
      backgroundColor: nodeBackgroundColor(node),
      fillStyle: "solid",
      roughness: 0,
      opacity: 100,
      roundness: { type: 3 },
      boundElements: [{ type: "text", id: workflowNodeLabelElementId(graph.id, node.id) }],
      groupIds: [groupId],
      customData: { arcWorkflow: metadata(persisted, "node", { workflowNodeId: node.id }) },
    });
    const labelWidth = box.width - 32;
    const labelHeight = box.height - 48;
    const labelText = fitCanvasText(nodeText(node), labelWidth, labelHeight, 15);
    elements.push({
      id: workflowNodeLabelElementId(graph.id, node.id),
      type: "text",
      x: box.x + 16,
      y: box.y + 18,
      width: labelWidth,
      height: labelHeight,
      text: labelText,
      originalText: labelText,
      fontSize: 15,
      fontFamily: FONT_FAMILY.Helvetica,
      containerId: workflowNodeElementId(graph.id, node.id),
      autoResize: false,
      lineHeight: 1.25,
      textAlign: "left",
      verticalAlign: "top",
      strokeColor: "#0f172a",
      backgroundColor: "transparent",
      groupIds: [groupId],
      customData: { arcWorkflow: metadata(persisted, "node_label", { workflowNodeId: node.id }) },
    });
    elements.push({
      id: workflowStatusElementId(graph.id, node.id),
      type: "text",
      x: box.x + 16,
      y: box.y + box.height - 28,
      width: box.width - 32,
      height: 18,
      text: `${node.kind} · ${node.status}`,
      fontSize: 12,
      fontFamily: FONT_FAMILY.Helvetica,
      textAlign: "left",
      verticalAlign: "top",
      strokeColor: statusColor(node.status),
      backgroundColor: "transparent",
      groupIds: [groupId],
      customData: { arcWorkflow: metadata(persisted, "status_badge", { workflowNodeId: node.id }) },
    });
  }

  return convertToExcalidrawElements(elements as Parameters<typeof convertToExcalidrawElements>[0], {
    regenerateIds: false,
  }) as readonly WorkflowExcalidrawElement[];
}

function edgeRoute(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number; points: number[][]; labelX: number; labelY: number } {
  const forward = to.x >= from.x;
  const start = forward
    ? { x: from.x + from.width, y: from.y + from.height / 2 }
    : { x: from.x, y: from.y + from.height / 2 };
  const end = forward
    ? { x: to.x, y: to.y + to.height / 2 }
    : { x: to.x + to.width, y: to.y + to.height / 2 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const elbowX = Math.abs(dx) >= 72 ? dx / 2 : dx >= 0 ? 36 : -36;
  const points = [
    [0, 0],
    [elbowX, 0],
    [elbowX, dy],
    [dx, dy],
  ];
  return {
    x: start.x,
    y: start.y,
    width: dx,
    height: dy,
    points,
    labelX: start.x + elbowX - 42,
    labelY: start.y + dy / 2 - 18,
  };
}

function metadata(
  persisted: ArcPersistedWorkflowGraph,
  semanticType: WorkflowElementMetadata["semanticType"],
  extra: Partial<WorkflowElementMetadata> = {},
): WorkflowElementMetadata {
  return {
    graphId: persisted.graph.id,
    projectId: persisted.projectId,
    orchestrationId: persisted.orchestrationId,
    semanticType,
    revision: persisted.revision,
    ...extra,
  };
}

function nodeText(node: ArcWorkflowNode): string {
  return [node.title, node.summary, node.body].filter(Boolean).join("\n");
}

function fitCanvasText(text: string, width: number, height: number, fontSize: number): string {
  const charsPerLine = Math.max(10, Math.floor(width / (fontSize * 0.55)));
  const maxLines = Math.max(1, Math.floor(height / (fontSize * 1.25)));
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (lines.length >= maxLines) break;
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      if (!current) {
        current = word;
      } else if (`${current} ${word}`.length <= charsPerLine) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
      while (current.length > charsPerLine) {
        lines.push(current.slice(0, charsPerLine));
        current = current.slice(charsPerLine);
      }
      if (lines.length >= maxLines) break;
    }
    if (lines.length < maxLines && current) {
      lines.push(current);
    }
  }
  if (lines.length === 0) return "";
  const sourceHasMore = text.split("\n").length > lines.length || lines.join(" ").length < text.replace(/\s+/g, " ").trim().length;
  if (sourceHasMore) {
    const last = lines[lines.length - 1] ?? "";
    lines[lines.length - 1] = `${last.slice(0, Math.max(0, charsPerLine - 3)).trimEnd()}...`;
  }
  return lines.join("\n");
}

function nodeStrokeColor(node: ArcWorkflowNode): string {
  if (node.status === "blocked") return "#b91c1c";
  if (node.status === "complete") return "#15803d";
  if (node.status === "deprecated") return "#64748b";
  if (node.kind === "risk") return "#b45309";
  if (node.kind === "open_question") return "#7c3aed";
  if (node.kind === "goal") return "#1d4ed8";
  return "#334155";
}

function nodeBackgroundColor(node: ArcWorkflowNode): string {
  if (node.status === "blocked") return "#fee2e2";
  if (node.status === "complete") return "#dcfce7";
  if (node.status === "deprecated") return "#f1f5f9";
  if (node.kind === "risk") return "#fef3c7";
  if (node.kind === "open_question") return "#ede9fe";
  if (node.kind === "goal") return "#dbeafe";
  return "#ffffff";
}

function statusColor(status: string): string {
  if (status === "blocked") return "#b91c1c";
  if (status === "complete") return "#15803d";
  if (status === "deprecated") return "#64748b";
  if (status === "in_progress") return "#1d4ed8";
  return "#475569";
}

function edgeColor(edge: ArcWorkflowEdge): string {
  if (edge.status === "deprecated") return "#94a3b8";
  if (edge.kind === "blocks") return "#b91c1c";
  if (edge.kind === "implements") return "#1d4ed8";
  return "#475569";
}
