import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";
import { config } from "./config.js";

if (!config.discordToken || !config.discordClientId || !config.discordGuildId) {
  throw new Error("Discord command registration requires DISCORD_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID.");
}

const rest = new REST({ version: "10" }).setToken(config.discordToken);

await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body: commands });
console.log(`Registered ${commands.length} guild commands for ${config.discordGuildId}.`);
