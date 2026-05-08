export type PullRequestFeedbackKind = "issue_comment" | "review" | "review_comment";

export interface TrackedPullRequest {
  id: number;
  projectId: number;
  taskId: number;
  parentOrchestrationId: number | null;
  orchestrationAgentId: number | null;
  prUrl: string;
  owner: string;
  repo: string;
  number: number;
  branchName: string | null;
  state: "open" | "closed" | "merged" | "unknown";
  lastPolledAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequestFeedbackEvent {
  id: number;
  trackedPrId: number;
  taskId: number;
  externalId: string;
  kind: PullRequestFeedbackKind;
  author: string | null;
  body: string;
  htmlUrl: string | null;
  path: string | null;
  line: number | null;
  reviewState: string | null;
  githubCreatedAt: string | null;
  githubUpdatedAt: string | null;
  deliveredTaskMessageId: number | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface NormalizedPullRequestFeedback {
  externalId: string;
  kind: PullRequestFeedbackKind;
  author: string | null;
  body: string;
  htmlUrl: string | null;
  path: string | null;
  line: number | null;
  reviewState: string | null;
  githubCreatedAt: string | null;
  githubUpdatedAt: string | null;
}

export interface PullRequestIdentity {
  owner: string;
  repo: string;
  number: number;
}
