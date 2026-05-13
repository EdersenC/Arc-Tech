import type { Effort } from "../types.js";

export const ORCHESTRATION_STATUSES = [
  "draft_created",
  "asking_questions",
  "waiting_for_user_choice",
  "refining_plan",
  "ready_for_approval",
  "approved_for_spawn",
  "spawning_agents",
  "agents_spawned",
  "complete",
  "canceled",
  "failed",
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
  parentCardId: string | null;
  borderCardId: string | null;
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

export interface PlannerOption {
  id: string;
  label: string;
  description?: string;
}

export interface PlannerQuestion {
  id: string;
  text: string;
  allowMultiSelect: boolean;
  options: PlannerOption[];
}

export interface PlannerQuestionAnswer {
  questionId: string;
  selectedOptionIds: string[];
  customText?: string;
}

export type PlannerQuestionSource = "planner" | "workflow";
export type PlannerQuestionStatus = "open" | "answered" | "resolved" | "deprecated";

export interface PlannerQuestionAnswerView {
  selectedOptionIds: string[];
  selectedLabels: string[];
  customText?: string;
  content: string;
  createdAt: string;
  source?: string;
}

export interface PlannerQuestionMessageView {
  id: number;
  role: OrchestrationMessage["role"];
  content: string;
  createdAt: string;
}

export interface PlannerQuestionView extends PlannerQuestion {
  source: PlannerQuestionSource;
  status: PlannerQuestionStatus;
  answer: PlannerQuestionAnswerView | null;
  workflowNodeId?: string;
  detail?: string;
  recommendedOptionIds?: string[];
  recommendationRationale?: string;
  messages: PlannerQuestionMessageView[];
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
  workContract?: AgentWorkContract;
}

export interface AgentFleetPlan {
  orchestrationGoal: string;
  architectureSummary: string;
  agentCount: number;
  sharedContext: string;
  integrationStrategy: string;
  interfaceContracts?: AgentInterfaceContract[];
  agents: AgentFleetPlanAgent[];
}

export type AgentInterfaceKind = "api" | "type" | "db" | "event" | "component" | "service" | "workflow" | "prompt-artifact";

export interface AgentInterfaceContract {
  name: string;
  kind: AgentInterfaceKind;
  contract: string;
}

export interface AgentDataContract {
  name: string;
  ownerAgent?: string;
  schema: string;
  compatibilityRules: string[];
}

export interface AgentScopeContract {
  files?: string[];
  directories?: string[];
  modules?: string[];
  responsibilities: string[];
}

export interface AgentForbiddenScopeContract {
  files?: string[];
  directories?: string[];
  modules?: string[];
  rules: string[];
}

export interface AgentWorkContract {
  contractVersion: "arc-agent-contract-v1";
  orchestrationId: number;
  agentIndex: number;
  agentName: string;
  role: string;
  objective: string;
  userGoal: string;
  sharedContext: string;
  ownedScope: AgentScopeContract;
  forbiddenScope: AgentForbiddenScopeContract;
  interfacesToConsume: AgentInterfaceContract[];
  interfacesToProvide: AgentInterfaceContract[];
  dataContracts: AgentDataContract[];
  integrationNotes: string[];
  conflictAvoidanceRules: string[];
  acceptanceCriteria: string[];
  validationCommands: string[];
  completionReportRequired: {
    changedFiles: true;
    contractDeviations: true;
    newInterfaces: true;
    validationResults: true;
    risks: true;
  };
}

export interface OrchestrationView {
  orchestration: Orchestration;
  agents: OrchestrationAgent[];
  messages: OrchestrationMessage[];
  questions?: PlannerQuestionView[];
  safety?: OrchestrationSafetyRecord[];
  contractRevisions?: OrchestrationContractRevision[];
}

export type OrchestrationSafetyKind =
  | "query_contract"
  | "query_project_context"
  | "query_plan_history"
  | "query_user_decisions"
  | "query_prompt_artifacts"
  | "request_scope_change"
  | "request_interface_change"
  | "report_contract_deviation"
  | "declare_assumption"
  | "risk_register_update"
  | "sync_with_orchestrator"
  | "request_peer_coordination"
  | "notify_dependency_ready"
  | "request_dependency_status"
  | "report_validation_result"
  | "request_test_help"
  | "handoff_to_integration"
  | "request_retry"
  | "request_reassignment"
  | "abort_with_reason";

export type OrchestrationSafetyStatus = "open" | "approved" | "denied" | "resolved" | "superseded";

export interface OrchestrationSafetyRecord {
  id: number;
  orchestrationId: number;
  agentId: number | null;
  taskId: number | null;
  kind: OrchestrationSafetyKind;
  status: OrchestrationSafetyStatus;
  title: string;
  body: string;
  severity: string | null;
  needsOrchestratorAction: boolean;
  needsUserAction: boolean;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface OrchestrationContractRevision {
  id: number;
  orchestrationId: number;
  safetyRecordId: number | null;
  revisionKind: "scope" | "interface" | "contract";
  summary: string;
  payload: unknown;
  createdAt: string;
}
