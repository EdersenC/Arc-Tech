export function workflowNodeElementId(graphId: string, nodeId: string): string {
  return `arc-workflow-${graphId}-node-${nodeId}`;
}

export function workflowNodeLabelElementId(graphId: string, nodeId: string): string {
  return `arc-workflow-${graphId}-node-${nodeId}-label`;
}

export function workflowStatusElementId(graphId: string, nodeId: string): string {
  return `arc-workflow-${graphId}-node-${nodeId}-status`;
}

export function workflowEdgeElementId(graphId: string, edgeId: string): string {
  return `arc-workflow-${graphId}-edge-${edgeId}`;
}

export function workflowEdgeLabelElementId(graphId: string, edgeId: string): string {
  return `arc-workflow-${graphId}-edge-${edgeId}-label`;
}

export function workflowSectionElementId(graphId: string, sectionId: string): string {
  return `arc-workflow-${graphId}-${sectionId}`;
}

export function workflowSectionLabelElementId(graphId: string, sectionId: string): string {
  return `arc-workflow-${graphId}-${sectionId}-label`;
}

export function workflowNodeGroupId(graphId: string, nodeId: string): string {
  return `arc-workflow-${graphId}-node-${nodeId}-group`;
}
