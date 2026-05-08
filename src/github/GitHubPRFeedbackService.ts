import { execa } from "execa";
import type { NormalizedPullRequestFeedback, PullRequestIdentity, TrackedPullRequest } from "./PullRequestFeedbackTypes.js";

type GitHubUser = { login?: string | null };

type PullRequestResponse = {
  state?: string;
  merged_at?: string | null;
};

type IssueCommentResponse = {
  id: number;
  user?: GitHubUser | null;
  body?: string | null;
  html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type ReviewResponse = {
  id: number;
  user?: GitHubUser | null;
  body?: string | null;
  html_url?: string | null;
  state?: string | null;
  submitted_at?: string | null;
};

type ReviewCommentResponse = {
  id: number;
  user?: GitHubUser | null;
  body?: string | null;
  html_url?: string | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export interface PullRequestFeedbackSnapshot {
  state: TrackedPullRequest["state"];
  feedback: NormalizedPullRequestFeedback[];
}

export class GitHubPRFeedbackService {
  parsePrUrl(value: string): PullRequestIdentity | null {
    const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(value.trim());
    if (!match) {
      return null;
    }
    return { owner: match[1], repo: match[2], number: Number(match[3]) };
  }

  async fetchFeedback(tracked: TrackedPullRequest): Promise<PullRequestFeedbackSnapshot> {
    const [pull, issueComments, reviews, reviewComments] = await Promise.all([
      this.ghJson<PullRequestResponse>(`repos/${tracked.owner}/${tracked.repo}/pulls/${tracked.number}`),
      this.ghJson<IssueCommentResponse[]>(`repos/${tracked.owner}/${tracked.repo}/issues/${tracked.number}/comments?per_page=100`),
      this.ghJson<ReviewResponse[]>(`repos/${tracked.owner}/${tracked.repo}/pulls/${tracked.number}/reviews?per_page=100`),
      this.ghJson<ReviewCommentResponse[]>(`repos/${tracked.owner}/${tracked.repo}/pulls/${tracked.number}/comments?per_page=100`),
    ]);

    return {
      state: pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : pull.state === "open" ? "open" : "unknown",
      feedback: [
        ...issueComments.map(normalizeIssueComment),
        ...reviews.map(normalizeReview).filter((feedback): feedback is NormalizedPullRequestFeedback => feedback !== null),
        ...reviewComments.map(normalizeReviewComment),
      ].filter((feedback) => feedback.body.trim().length > 0),
    };
  }

  private async ghJson<T>(endpoint: string): Promise<T> {
    const result = await execa("gh", ["api", endpoint], { reject: false });
    if (result.exitCode !== 0) {
      throw new Error(`gh api ${endpoint} failed: ${String(result.stderr || result.stdout)}`);
    }
    return JSON.parse(String(result.stdout || "null")) as T;
  }
}

function normalizeIssueComment(comment: IssueCommentResponse): NormalizedPullRequestFeedback {
  return {
    externalId: `issue-comment:${comment.id}`,
    kind: "issue_comment",
    author: comment.user?.login ?? null,
    body: comment.body ?? "",
    htmlUrl: comment.html_url ?? null,
    path: null,
    line: null,
    reviewState: null,
    githubCreatedAt: comment.created_at ?? null,
    githubUpdatedAt: comment.updated_at ?? null,
  };
}

function normalizeReview(review: ReviewResponse): NormalizedPullRequestFeedback | null {
  const state = review.state ?? null;
  const body = review.body?.trim() || (state === "CHANGES_REQUESTED" ? "Reviewer requested changes." : "");
  if (!body) {
    return null;
  }
  return {
    externalId: `review:${review.id}`,
    kind: "review",
    author: review.user?.login ?? null,
    body,
    htmlUrl: review.html_url ?? null,
    path: null,
    line: null,
    reviewState: state,
    githubCreatedAt: review.submitted_at ?? null,
    githubUpdatedAt: review.submitted_at ?? null,
  };
}

function normalizeReviewComment(comment: ReviewCommentResponse): NormalizedPullRequestFeedback {
  return {
    externalId: `review-comment:${comment.id}`,
    kind: "review_comment",
    author: comment.user?.login ?? null,
    body: comment.body ?? "",
    htmlUrl: comment.html_url ?? null,
    path: comment.path ?? null,
    line: comment.line ?? comment.original_line ?? null,
    reviewState: null,
    githubCreatedAt: comment.created_at ?? null,
    githubUpdatedAt: comment.updated_at ?? null,
  };
}
