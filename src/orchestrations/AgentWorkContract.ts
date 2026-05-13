import type { AgentFleetPlan, AgentFleetPlanAgent, AgentInterfaceContract, AgentWorkContract, Orchestration } from "./types.js";

export function agentWorkContract(
  orchestration: Orchestration,
  plan: AgentFleetPlan,
  agent: AgentFleetPlanAgent,
  index: number,
): AgentWorkContract {
  return agent.workContract ?? {
    contractVersion: "arc-agent-contract-v1",
    orchestrationId: orchestration.id,
    agentIndex: index,
    agentName: agent.name,
    role: agent.role,
    objective: agent.objective,
    userGoal: orchestration.goal,
    sharedContext: plan.sharedContext,
    ownedScope: {
      files: agent.expectedFiles,
      responsibilities: [agent.objective],
    },
    forbiddenScope: {
      rules: [
        "Do not change sibling-agent owned modules unless the assigned objective cannot be completed without it.",
        "Do not directly mutate WorkflowGraph or canvas prompt artifacts unless explicitly assigned.",
        "Do not run git add, git commit, git push, gh pr create, or branch-changing commands.",
      ],
    },
    interfacesToConsume: plan.interfaceContracts ?? [],
    interfacesToProvide: [],
    dataContracts: [],
    integrationNotes: [plan.integrationStrategy],
    conflictAvoidanceRules: [
      "Keep edits inside the owned scope where practical.",
      "Preserve public interfaces described in shared contracts.",
      "Report any required contract deviation in the completion JSON.",
    ],
    acceptanceCriteria: agent.acceptanceCriteria,
    validationCommands: inferValidationCommands(agent),
    completionReportRequired: {
      changedFiles: true,
      contractDeviations: true,
      newInterfaces: true,
      validationResults: true,
      risks: true,
    },
  };
}

export function formatAgentWorkContract(contract: AgentWorkContract): string {
  return JSON.stringify(contract, null, 2);
}

export function sharedInterfaceContractText(contracts: readonly AgentInterfaceContract[] | undefined): string {
  if (!contracts?.length) return "No shared interface contracts were provided by the planner.";
  return contracts.map((contract) => `- ${contract.kind} ${contract.name}: ${contract.contract}`).join("\n");
}

function inferValidationCommands(agent: AgentFleetPlanAgent): string[] {
  const files = agent.expectedFiles ?? [];
  if (files.some((file) => /package\.json|\.tsx?$|web\//i.test(file))) {
    return ["npm run build"];
  }
  if (files.some((file) => /\.py$|pyproject\.toml|requirements\.txt/i.test(file))) {
    return ["python -m pytest"];
  }
  return [];
}
