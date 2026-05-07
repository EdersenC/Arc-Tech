import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("implement")
    .setDescription("Create a checkpoint task thread.")
    .addStringOption((option) => option.setName("msg").setDescription("Task request").setRequired(true)),
  new SlashCommandBuilder().setName("status").setDescription("Check whether the bot is online."),
].map((command) => command.toJSON());
