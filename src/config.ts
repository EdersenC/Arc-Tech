import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

export const config = {
  discordToken: requiredEnv("DISCORD_TOKEN"),
  discordClientId: requiredEnv("DISCORD_CLIENT_ID"),
  discordGuildId: requiredEnv("DISCORD_GUILD_ID"),
  databasePath: path.resolve(process.env.DATABASE_PATH || "./data/app.sqlite"),
  workspacesDir: path.resolve(process.env.WORKSPACES_DIR || "./workspaces"),
  codexBin: process.env.CODEX_BIN || "codex",
  enableMessageContentIntent: booleanEnv("ENABLE_MESSAGE_CONTENT_INTENT", false),
  githubPrEnabled: booleanEnv("GITHUB_PR_ENABLED", false),
  githubBaseBranch: process.env.GITHUB_BASE_BRANCH || "main",
  githubRemote: process.env.GITHUB_REMOTE || "origin",
};

export type AppConfig = typeof config;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Add it to .env.`);
  }
  return value;
}

function booleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
