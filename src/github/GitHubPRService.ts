import type { GitManager } from "../git.js";
import type { AppConfig } from "../config.js";
import type { Task } from "../types.js";

export class GitHubPRService {
  constructor(
    private readonly git: GitManager,
    private readonly config: Pick<AppConfig, "githubPrEnabled" | "githubBaseBranch" | "githubRemote">,
  ) {}

  isEnabled(): boolean {
    return this.config.githubPrEnabled;
  }

  async createPrForTask(task: Task, title: string, body: string): Promise<string | null> {
    if (!this.isEnabled()) {
      return null;
    }
    return this.git.createTaskPullRequest(task, title, body, {
      baseBranch: this.config.githubBaseBranch,
      remote: this.config.githubRemote,
    });
  }

  getPrUrlForBranch(task: Task): string | null {
    return task.pullRequestUrl ?? task.prUrl ?? null;
  }
}
