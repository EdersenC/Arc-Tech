export type PullRequestType =
  | "implementation"
  | "patch"
  | "chore"
  | "refactor"
  | "docs"
  | "test"
  | "config"
  | "contract"
  | "mixed";

export interface GitDiffFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface GitDiffFacts {
  baseBranch: string;
  headBranch: string;
  stat: string;
  files: GitDiffFile[];
}

export interface StagedPullRequest {
  title: string;
  body: string;
  type: PullRequestType;
}
