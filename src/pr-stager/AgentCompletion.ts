import { z } from "zod";

const VerificationSchema = z.object({
  command: z.string().min(1),
  result: z.enum(["passed", "failed", "not_run"]),
  notes: z.string().optional(),
});

const ComparisonSchema = z.object({
  baseline: z.string().optional(),
  current: z.string().optional(),
  notes: z.array(z.string()).optional(),
});

const AgentCompletionSchema = z.object({
  summary: z.array(z.string()).min(1),
  changes: z.array(z.string()).default([]),
  verification: z.array(VerificationSchema).default([]),
  risks: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  reviewFocus: z.array(z.string()).default([]),
  prTitle: z.string().optional(),
  comparison: ComparisonSchema.optional(),
});

export type AgentCompletion = z.infer<typeof AgentCompletionSchema>;

export class AgentCompletionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCompletionParseError";
  }
}

export function parseAgentCompletion(output: string): AgentCompletion {
  const jsonText = extractCompletionJson(output);
  if (!jsonText) {
    throw new AgentCompletionParseError("Agent completion JSON was not found. PR body was not published.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new AgentCompletionParseError(`Agent completion JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = AgentCompletionSchema.safeParse(parsed);
  if (!result.success) {
    throw new AgentCompletionParseError(`Agent completion JSON failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

function extractCompletionJson(output: string): string | null {
  const fenced = /```ARC_AGENT_COMPLETION_JSON\s*([\s\S]*?)```/i.exec(output);
  if (fenced) return fenced[1].trim();
  const generic = /```json\s*([\s\S]*?)```/i.exec(output);
  if (generic) return generic[1].trim();
  const trimmed = output.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return null;
}
