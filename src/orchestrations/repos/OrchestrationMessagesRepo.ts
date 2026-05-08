import type Database from "better-sqlite3";
import type { OrchestrationMessage } from "../types.js";

type OrchestrationMessageRow = {
  id: number;
  orchestration_id: number;
  discord_message_id: string | null;
  author_user_id: string | null;
  role: "user" | "planner" | "system";
  content: string;
  metadata_json: string | null;
  created_at: string;
};

export class OrchestrationMessagesRepo {
  constructor(private readonly db: Database.Database) {}

  create(
    orchestrationId: number,
    role: OrchestrationMessage["role"],
    content: string,
    metadata: { discordMessageId?: string | null; authorUserId?: string | null; metadata?: unknown } = {},
  ): OrchestrationMessage {
    const result = this.db
      .prepare(
        `
        INSERT INTO orchestration_messages (
          orchestration_id,
          discord_message_id,
          author_user_id,
          role,
          content,
          metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        orchestrationId,
        metadata.discordMessageId ?? null,
        metadata.authorUserId ?? null,
        role,
        content,
        metadata.metadata === undefined ? null : JSON.stringify(metadata.metadata),
      );
    const row = this.db
      .prepare("SELECT * FROM orchestration_messages WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as OrchestrationMessageRow | undefined;
    if (!row) {
      throw new Error("Orchestration message could not be loaded after insert.");
    }
    return mapMessage(row);
  }

  listByOrchestrationId(orchestrationId: number): OrchestrationMessage[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM orchestration_messages
        WHERE orchestration_id = ?
        ORDER BY datetime(created_at) ASC, id ASC
      `,
      )
      .all(orchestrationId) as OrchestrationMessageRow[];
    return rows.map(mapMessage);
  }

  listRecent(orchestrationId: number, limit: number): OrchestrationMessage[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM orchestration_messages
        WHERE orchestration_id = ?
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?
      `,
      )
      .all(orchestrationId, limit) as OrchestrationMessageRow[];
    return rows.map(mapMessage).reverse();
  }
}

function mapMessage(row: OrchestrationMessageRow): OrchestrationMessage {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    discordMessageId: row.discord_message_id,
    authorUserId: row.author_user_id,
    role: row.role,
    content: row.content,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
  };
}
