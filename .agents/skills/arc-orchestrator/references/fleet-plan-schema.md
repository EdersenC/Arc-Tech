# AgentFleetPlan Schema

```json
{
  "orchestrationGoal": "string",
  "architectureSummary": "string",
  "agentCount": 2,
  "sharedContext": "string",
  "integrationStrategy": "string",
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
      "acceptanceCriteria": ["string"]
    }
  ]
}
```

Validation:
- `agentCount` is 2-10.
- `agents.length` equals `agentCount`.
- Every agent has `name`, `role`, `objective`, `prompt`, and at least one acceptance criterion.
- `prTitle` is optional. When present, make it specific to that child agent's PR instead of copying the original command.
