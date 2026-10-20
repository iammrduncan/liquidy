import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Label, Probabilities } from "./model/classifier.ts";

/** Schema changes, each run once and in order; the database's user_version counts those done. */
const MIGRATIONS = [
  `create table example (
     id integer primary key,
     message_id text not null unique,
     guild_id text not null,
     channel_id text not null,
     author_id text not null,
     label text not null check (label in ('legitimate', 'spam', 'scam')),
     -- What the model judges, as JSON: the input a training or evaluation run needs.
     state text not null,
     -- 'judged': the state the bot judged when the message arrived.
     -- 'rebuilt': built when the message was marked, because the bot had not judged it.
     state_source text not null check (state_source in ('judged', 'rebuilt')),
     -- The bot's own verdict, when it had judged the message: null otherwise.
     model text,
     model_label text,
     model_probabilities text,
     marked_by text not null,
     marked_at text not null,
     message_created_at text not null
   )`,
];

export interface Judgement {
  model: string;
  label: Label;
  probabilities: Probabilities;
}

/** A message a moderator labelled, with what the model saw. */
export interface Example {
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  label: Label;
  state: Record<string, unknown>;
  stateSource: "judged" | "rebuilt";
  judgement: Judgement | undefined;
  markedBy: string;
  markedAt: string;
  messageCreatedAt: string;
}

export interface StoredExample extends Example {
  id: number;
}

export interface Saved {
  id: number;
  /** The label the message had before, when it was marked already. */
  previousLabel: Label | undefined;
}

interface Row {
  id: number;
  message_id: string;
  guild_id: string;
  channel_id: string;
  author_id: string;
  label: Label;
  state: string;
  state_source: "judged" | "rebuilt";
  model: string | null;
  model_label: Label | null;
  model_probabilities: string | null;
  marked_by: string;
  marked_at: string;
  message_created_at: string;
}

/** Labelled messages in SQLite, for training and evaluating the bot later. */
export class ExampleStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    // The export reads while the bot writes; WAL lets them both proceed.
    if (path !== ":memory:") this.#db.exec("pragma journal_mode = wal");
    migrate(this.#db);
  }

  /**
   * Saves a moderator's label. Marking a message again changes only the label and who marked it:
   * the state saved first is the one closest to what the bot saw.
   */
  save(example: Example): Saved {
    const before = this.#db
      .prepare("select label from example where message_id = ?")
      .get(example.messageId) as { label: Label } | undefined;
    const { judgement } = example;
    const row = this.#db
      .prepare(
        `insert into example (message_id, guild_id, channel_id, author_id, label, state,
           state_source, model, model_label, model_probabilities, marked_by, marked_at,
           message_created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (message_id) do update set
           label = excluded.label, marked_by = excluded.marked_by, marked_at = excluded.marked_at
         returning id`,
      )
      .get(
        example.messageId,
        example.guildId,
        example.channelId,
        example.authorId,
        example.label,
        JSON.stringify(example.state),
        example.stateSource,
        judgement?.model ?? null,
        judgement?.label ?? null,
        judgement ? JSON.stringify(judgement.probabilities) : null,
        example.markedBy,
        example.markedAt,
        example.messageCreatedAt,
      ) as { id: number };
    return { id: row.id, previousLabel: before?.label };
  }

  /** Every example, oldest first. */
  examples(): StoredExample[] {
    const rows = this.#db.prepare("select * from example order by id").all() as unknown as Row[];
    return rows.map(fromRow);
  }

  close(): void {
    this.#db.close();
  }
}

function migrate(db: DatabaseSync): void {
  const { user_version: done } = db.prepare("pragma user_version").get() as {
    user_version: number;
  };
  for (const [i, sql] of MIGRATIONS.entries()) {
    if (i < done) continue;
    db.exec("begin");
    try {
      db.exec(sql);
      db.exec(`pragma user_version = ${i + 1}`);
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  }
}

function fromRow(row: Row): StoredExample {
  const judgement =
    row.model && row.model_label && row.model_probabilities
      ? {
          model: row.model,
          label: row.model_label,
          probabilities: JSON.parse(row.model_probabilities) as Probabilities,
        }
      : undefined;
  return {
    id: row.id,
    messageId: row.message_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    authorId: row.author_id,
    label: row.label,
    state: JSON.parse(row.state) as Record<string, unknown>,
    stateSource: row.state_source,
    judgement,
    markedBy: row.marked_by,
    markedAt: row.marked_at,
    messageCreatedAt: row.message_created_at,
  };
}
