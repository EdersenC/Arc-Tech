import {
  AttachmentBuilder,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  type MessageReplyOptions,
  type TextBasedChannel,
} from "discord.js";
import { redactSecrets } from "../redact.js";
import { splitDiscordContent } from "./splitDiscordContent.js";

const DISCORD_MESSAGE_LIMIT = 1900;
const MAX_PARTS_BEFORE_ATTACHMENT = 6;

type SendSafeOptions = Omit<MessageCreateOptions, "content">;
type ReplySafeOptions = Omit<MessageReplyOptions, "content" | "withResponse">;
type EditSafeOptions = Omit<MessageEditOptions, "content">;

export class DiscordMessageWriter {
  async sendSafe(target: TextBasedChannel, text: string, options: SendSafeOptions = {}): Promise<Message[]> {
    const sanitized = redactDiscordText(text);
    return this.sendParts(target, sanitized, options);
  }

  async replySafe(target: Message, text: string, options: ReplySafeOptions = {}): Promise<Message[]> {
    const sanitized = redactDiscordText(text);
    const chunks = this.chunkText(sanitized);
    if (!shouldUseAttachment(chunks)) {
      const sent = await target.reply({ ...options, content: chunks[0] || "" } as MessageReplyOptions);
      if (chunks.length === 1) {
        return [sent];
      }
      const extras = await this.sendTextMessages(target.channel as TextBasedChannel, chunks.slice(1), options as SendSafeOptions);
      return [sent, ...extras];
    }

    const attachmentMessage = await target.reply({
      ...options,
      content: "Message content was too long. See attachment for full output.",
      files: buildAttachment(sanitized),
    } as MessageReplyOptions);
    return [attachmentMessage];
  }

  async editSafe(target: Message, text: string, options: EditSafeOptions = {}): Promise<Message[]> {
    const sanitized = redactDiscordText(text);
    const chunks = this.chunkText(sanitized);
    if (!shouldUseAttachment(chunks)) {
      const edited = await target.edit({ ...options, content: chunks[0] || "" } as MessageEditOptions);
      if (chunks.length === 1) {
        return [edited];
      }
      const extras = await this.sendTextMessages(target.channel as TextBasedChannel, chunks.slice(1), options as SendSafeOptions);
      return [edited, ...extras];
    }

    const attachment = await target.edit({
      ...(options as MessageEditOptions),
      content: "Message content was too long. See attachment for full output.",
      files: buildAttachment(sanitized),
    });
    return [attachment];
  }

  private async sendParts(target: TextBasedChannel, text: string, options: SendSafeOptions): Promise<Message[]> {
    const chunks = this.chunkText(text);
    if (!shouldUseAttachment(chunks)) {
      return this.sendTextMessages(target, chunks, options);
    }

    const attachment = await target.send({ ...options, content: "Message content was too long. See attachment for full output.", files: buildAttachment(text) });
    return [attachment];
  }

  private chunkText(text: string): string[] {
    return splitDiscordContent(text, DISCORD_MESSAGE_LIMIT);
  }

  private async sendTextMessages(target: TextBasedChannel, chunks: string[], options: SendSafeOptions): Promise<Message[]> {
    const sent: Message[] = [];
    for (const chunk of chunks) {
      if (!chunk) {
        continue;
      }
      sent.push(await target.send({ ...options, content: chunk }));
    }
    return sent;
  }
}

function shouldUseAttachment(chunks: string[]): boolean {
  return chunks.length > MAX_PARTS_BEFORE_ATTACHMENT;
}

function buildAttachment(text: string): AttachmentBuilder {
  const extension = text.includes("```") ? "md" : "txt";
  const filename = `discord-message.${extension}`;
  return new AttachmentBuilder(Buffer.from(text, "utf8"), { name: filename });
}

function redactDiscordText(value: string): string {
  let redacted = redactSecrets(value);
  redacted = redacted.replace(/\bOPENAI_API_KEY\b\s*[:=]\s*[^\s`]+/gi, "OPENAI_API_KEY=[REDACTED_OPENAI_API_KEY]");
  const openAiEnv = process.env.OPENAI_API_KEY;
  if (openAiEnv) {
    redacted = redacted.split(openAiEnv).join("[REDACTED_OPENAI_API_KEY]");
  }
  return redacted;
}
