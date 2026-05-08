import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

export interface AppConfig {
  discordToken: string | null;
  discordClientId: string | null;
  discordGuildId: string | null;
  databasePath: string;
  workspacesDir: string;
  codexBin: string;
  enableMessageContentIntent: boolean;
  githubPrEnabled: boolean;
  githubPrFeedbackEnabled: boolean;
  githubPrFeedbackPollMs: number;
  githubBaseBranch: string;
  githubRemote: string;
  excalidrawHost: string;
  excalidrawPort: number;
  excalidrawCorsOrigin: string;
  excalidrawProjectGuildId: string;
  excalidrawProjectChannelId: string;
  excalidrawProjectName: string;
}

export function loadConfig(options: { requireDiscord?: boolean } = {}): AppConfig {
  const requireDiscord = options.requireDiscord ?? true;
  return {
    discordToken: env("DISCORD_TOKEN", requireDiscord),
    discordClientId: env("DISCORD_CLIENT_ID", requireDiscord),
    discordGuildId: env("DISCORD_GUILD_ID", requireDiscord),
    databasePath: path.resolve(process.env.DATABASE_PATH || "./data/app.sqlite"),
    workspacesDir: path.resolve(process.env.WORKSPACES_DIR || "./workspaces"),
    codexBin: process.env.CODEX_BIN || "codex",
    enableMessageContentIntent: booleanEnv("ENABLE_MESSAGE_CONTENT_INTENT", false),
    githubPrEnabled: booleanEnv("GITHUB_PR_ENABLED", false),
    githubPrFeedbackEnabled: booleanEnv("GITHUB_PR_FEEDBACK_ENABLED", booleanEnv("GITHUB_PR_ENABLED", false)),
    githubPrFeedbackPollMs: numberEnv("GITHUB_PR_FEEDBACK_POLL_MS", 60_000),
    githubBaseBranch: process.env.GITHUB_BASE_BRANCH || "main",
    githubRemote: process.env.GITHUB_REMOTE || "origin",
    excalidrawHost: process.env.EXCALIDRAW_HOST || "127.0.0.1",
    excalidrawPort: numberEnv("EXCALIDRAW_PORT", 8787),
    excalidrawCorsOrigin: process.env.EXCALIDRAW_CORS_ORIGIN || "http://127.0.0.1:5173,http://localhost:5173",
    excalidrawProjectGuildId: process.env.EXCALIDRAW_PROJECT_GUILD_ID || "excalidraw",
    excalidrawProjectChannelId: process.env.EXCALIDRAW_PROJECT_CHANNEL_ID || "default",
    excalidrawProjectName: process.env.EXCALIDRAW_PROJECT_NAME || "Excalidraw",
  };
}

export const config = loadConfig({ requireDiscord: true });

function env(name: string, required: boolean): string | null {
  const value = process.env[name];
  if (!value && required) {
    throw new Error(`${name} is required. Add it to .env.`);
  }
  return value ?? null;
}

function booleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function numberEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
