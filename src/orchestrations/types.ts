import type { Effort } from "../types.js";

export const ORCHESTRATION_STATUSES = [
  "PLANNING",
  "WAITING_USER",
  "READY_TO_ORCHESTRATE",
  "LAUNCHING_AGENTS",
  "RUNNING_AGENTS",
  "WAITING_REVIEW",
  "COMPLETED",
  "FAILED",
  "CANCELED",
] as const;

export type OrchestrationStatus = (typeof ORCHESTRATION_STATUSES)[number];

export const ORCHESTRATION_AGENT_STATUSES = ["planned", "created", "queued", "running", "done", "failed", "canceled"] as const;
export type OrchestrationAgentStatus = (typeof ORCHESTRATION_AGENT_STATUSES)[number];

export const AGENT_FLEET_ROLES = ["planner", "implementer", "tester", "reviewer", "refactor", "docs"] as const;
export type AgentFleetRole = (typeof AGENT_FLEET_ROLES)[number];

export interface Orchestration {
  id: number;
  projectId: number;
  discordThreadId: string | null;
  discordThreadUrl: string | null;
  controlPanelMessageId: string | null;
  authorUserId: string;
  status: OrchestrationStatus;
  goal: string;
  plannerTaskId: number | null;
  plannerModel: string | null;
  plannerEffort: Effort | null;
  minAgents: number;
  maxAgents: number;
  autoStartChildren: boolean;
  finalPlanJson: string | null;
  finalSummary: string | null;
  createdAt: string;
  updatedAt: string;
  launchedAt: string | null;
  completedAt: string | null;
}

export interface OrchestrationAgent {
  id: number;
  orchestrationId: number;
  childTaskId: number | null;
  agentIndex: number;
  agentName: string;
  role: AgentFleetRole | string;
  prompt: string;
  model: string | null;
  effort: Effort | null;
  status: OrchestrationAgentStatus;
  branchName: string | null;
  worktreePath: string | null;
  discordThreadId: string | null;
  discordThreadUrl: string | null;
  prUrl: string | null;
  completionSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OrchestrationMessage {
  id: number;
  orchestrationId: number;
  discordMessageId: string | null;
  authorUserId: string | null;
  role: "user" | "planner" | "system";
  content: string;
  metadataJson: string | null;
  createdAt: string;
}

export interface AgentFleetPlanAgent {
  name: string;
  role: AgentFleetRole;
  objective: string;
  prompt: string;
  model?: string;
  effort?: Effort;
  prTitle?: string;
  dependsOn?: string[];
  expectedFiles?: string[];
  acceptanceCriteria: string[];
}

export interface AgentFleetPlan {
  orchestrationGoal: string;
  architectureSummary: string;
  agentCount: number;
  sharedContext: string;
  integrationStrategy: string;
  agents: AgentFleetPlanAgent[];
}

export interface OrchestrationView {
  orchestration: Orchestration;
  agents: OrchestrationAgent[];
  messages: OrchestrationMessage[];
}
