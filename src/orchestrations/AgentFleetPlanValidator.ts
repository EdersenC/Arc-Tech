import { z } from "zod";
import type { Orchestration } from "./types.js";

const roleSchema = z.enum(["planner", "implementer", "tester", "reviewer", "refactor", "docs"]);
const effortSchema = z.enum(["low", "medium", "high"]);

export const agentFleetPlanSchema = z.object({
  orchestrationGoal: z.string().trim().min(1),
  architectureSummary: z.string().trim().min(1),
  agentCount: z.number().int(),
  sharedContext: z.string().trim().min(1),
  integrationStrategy: z.string().trim().min(1),
  agents: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        role: roleSchema,
        objective: z.string().trim().min(1),
        prompt: z.string().trim().min(1),
        model: z.string().trim().min(1).optional(),
        effort: effortSchema.optional(),
        prTitle: z.string().trim().min(1).max(100).optional(),
        dependsOn: z.array(z.string().trim().min(1)).optional(),
        expectedFiles: z.array(z.string().trim().min(1)).optional(),
        acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
      }),
    )
    .min(2)
    .max(10),
});

export type ValidatedAgentFleetPlan = z.infer<typeof agentFleetPlanSchema>;

export interface AgentFleetPlanValidationResult {
  ok: boolean;
  plan?: ValidatedAgentFleetPlan;
  json?: string;
  errors: string[];
}

export class AgentFleetPlanValidator {
  validateForOrchestration(raw: string | unknown, orchestration: Pick<Orchestration, "minAgents" | "maxAgents">): AgentFleetPlanValidationResult {
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(extractJsonObject(raw));
      } catch (error) {
        return { ok: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
      }
    }

    const schemaResult = agentFleetPlanSchema.safeParse(parsed);
    if (!schemaResult.success) {
      return {
        ok: false,
        errors: schemaResult.error.issues.map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`),
      };
    }

    const plan = schemaResult.data;
    const minAgents = clamp(orchestration.minAgents, 2, 10);
    const maxAgents = clamp(orchestration.maxAgents, 2, 10);
    const errors: string[] = [];
    if (plan.agentCount < minAgents) {
      errors.push(`agentCount must be >= orchestration min_agents (${minAgents}).`);
    }
    if (plan.agentCount > maxAgents) {
      errors.push(`agentCount must be <= orchestration max_agents (${maxAgents}).`);
    }
    if (plan.agentCount < 2) {
      errors.push("agentCount must be >= hard lower bound 2.");
    }
    if (plan.agentCount > 10) {
      errors.push("agentCount must be <= hard upper bound 10.");
    }
    if (plan.agents.length !== plan.agentCount) {
      errors.push(`agents.length (${plan.agents.length}) must equal agentCount (${plan.agentCount}).`);
    }

    return errors.length === 0 ? { ok: true, plan, json: stableJson(plan), errors: [] } : { ok: false, errors };
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function extractJsonObject(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    return fenced[1].trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
