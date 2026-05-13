import type { GitManager } from "../git.js";
import type { AppConfig } from "../config.js";
import type { Task } from "../types.js";
import { stagePullRequest } from "../pr-stager/PrStager.js";

export class GitHubPRService {
  constructor(
    private readonly git: GitManager,
    private readonly config: Pick<AppConfig, "githubPrEnabled" | "githubBaseBranch" | "githubRemote">,
  ) {}

  isEnabled(): boolean {
    return this.config.githubPrEnabled;
  }

  async createPrForTask(task: Task, agentOutput: string, fallbackTitle: string): Promise<string | null> {
    if (!this.isEnabled()) {
      return null;
    }
    const diff = await this.git.getTaskPullRequestDiffFacts(task, { baseBranch: this.config.githubBaseBranch });
    const staged = stagePullRequest({ task, agentOutput, diff, fallbackTitle });
    return this.git.createTaskPullRequest(task, staged.title, staged.body, {
      baseBranch: this.config.githubBaseBranch,
      remote: this.config.githubRemote,
    });
  }

  getPrUrlForBranch(task: Task): string | null {
    return task.pullRequestUrl ?? task.prUrl ?? null;
  }
}
