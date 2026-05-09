import type { WorkflowPatch } from "./types.js";
import { validateWorkflowPatch } from "./validation.js";

export const WORKFLOW_PATCH_BLOCK = "ARC_WORKFLOW_PATCH_JSON";

export type PlannerWorkflowPatchParseResult =
  | { status: "none" }
  | { status: "valid"; patch: WorkflowPatch }
  | { status: "rejected"; error: string; raw: string };

export function extractNewestWorkflowPatchBlock(content: string): string | null {
  const blocks = [...content.matchAll(/```ARC_WORKFLOW_PATCH_JSON\s*([\s\S]*?)```/g)];
  const newest = blocks.at(-1);
  return newest ? newest[1].trim() : null;
}

export function parsePlannerWorkflowPatch(content: string): PlannerWorkflowPatchParseResult {
  const raw = extractNewestWorkflowPatchBlock(content);
  if (!raw) {
    return { status: "none" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "rejected",
      raw,
      error: `Workflow patch JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const validation = validateWorkflowPatch(parsed);
  if (!validation.ok || !validation.value) {
    return {
      status: "rejected",
      raw,
      error: `Workflow patch JSON is invalid: ${validation.errors.join("; ")}`,
    };
  }

  return { status: "valid", patch: validation.value };
}
