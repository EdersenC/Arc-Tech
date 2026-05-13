# AgentFleetPlan Schema

```json
{
  "orchestrationGoal": "string",
  "architectureSummary": "string",
  "agentCount": 2,
  "sharedContext": "string",
  "integrationStrategy": "string",
  "interfaceContracts": [
    {
      "name": "string",
      "kind": "api|type|db|event|component|service|workflow|prompt-artifact",
      "contract": "string"
    }
  ],
  "agents": [
    {
      "name": "string",
      "role": "planner|implementer|tester|reviewer|refactor|docs",
      "objective": "string",
      "prompt": "string",
      "model": "optional string",
      "effort": "optional low|medium|high",
      "prTitle": "optional short pull request title",
      "dependsOn": ["optional string"],
      "expectedFiles": ["optional string"],
      "acceptanceCriteria": ["string"],
      "workContract": {
        "contractVersion": "arc-agent-contract-v1",
        "orchestrationId": 1,
        "agentIndex": 1,
        "agentName": "string",
        "role": "string",
        "objective": "string",
        "userGoal": "string",
        "sharedContext": "string",
        "ownedScope": {
          "files": ["optional string"],
          "directories": ["optional string"],
          "modules": ["optional string"],
          "responsibilities": ["string"]
        },
        "forbiddenScope": {
          "files": ["optional string"],
          "directories": ["optional string"],
          "modules": ["optional string"],
          "rules": ["string"]
        },
        "interfacesToConsume": [{"name": "string", "kind": "api|type|db|event|component|service|workflow|prompt-artifact", "contract": "string"}],
        "interfacesToProvide": [{"name": "string", "kind": "api|type|db|event|component|service|workflow|prompt-artifact", "contract": "string"}],
        "dataContracts": [{"name": "string", "ownerAgent": "optional string", "schema": "string", "compatibilityRules": ["string"]}],
        "integrationNotes": ["string"],
        "conflictAvoidanceRules": ["string"],
        "acceptanceCriteria": ["string"],
        "validationCommands": ["string"],
        "completionReportRequired": {
          "changedFiles": true,
          "contractDeviations": true,
          "newInterfaces": true,
          "validationResults": true,
          "risks": true
        }
      }
    }
  ]
}
```

Validation:
- `agentCount` is 2-10.
- `agents.length` equals `agentCount`.
- Every agent has `name`, `role`, `objective`, `prompt`, and at least one acceptance criterion.
- `prTitle` is optional. When present, make it specific to that child agent's PR instead of copying the original command.
- `interfaceContracts` is optional for compatibility but should be present for multi-agent implementation work.
- `workContract` is optional for compatibility but should be present for each newly generated child agent. The runner will generate a fallback contract if an older plan omits it.
