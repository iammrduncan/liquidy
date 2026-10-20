import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  type Message,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import type { Mode } from "./config.ts";
import { errorText, log } from "./log.ts";
import { flagProbability, type Label, type Verdict } from "./model/classifier.ts";
import type { Example, ExampleStore, Saved } from "./store.ts";

/** The message commands (right-click a message > Apps) and the label each one saves. */
export const MARK_COMMANDS: Record<string, Label> = {
  "Mark as spam": "spam",
  "Mark as scam": "scam",
  "Mark as not spam": "legitimate",
};

/** How moderators read each label. */
const LABEL_NAMES: Record<Label, string> = { legitimate: "not spam", spam: "spam", scam: "scam" };

/**
 * Only members with Manage Messages see the commands by default. A server admin can change that
 * under Server Settings > Integrations; the handler still checks.
 */
export function markCommands() {
  return Object.keys(MARK_COMMANDS).map((name) =>
    new ContextMenuCommandBuilder()
      .setName(name)
      .setType(ApplicationCommandType.Message)
      .setContexts(InteractionContextType.Guild)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .toJSON(),
  );
}

/**
 * What the bot saw and said about one message: enough to save it as an example, even after the
 * message itself was deleted.
 */
export interface Judged {
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  createdAt: string;
  state: Record<string, unknown>;
  model: string;
  verdict: Verdict;
}

/** The newest `max` entries by key, in memory: older ones are forgotten, and so is a restart. */
export class Recent<T> {
  readonly #max: number;
  readonly #byKey = new Map<string, T>();

  constructor(max: number) {
    this.#max = max;
  }

  add(key: string, value: T): void {
    // Re-inserting moves the key (an edited message, say) to the newest end.
    this.#byKey.delete(key);
    this.#byKey.set(key, value);
    if (this.#byKey.size > this.#max) {
      const oldest = this.#byKey.keys().next();
      if (!oldest.done) this.#byKey.delete(oldest.value);
    }
  }

  get(key: string): T | undefined {
    return this.#byKey.get(key);
  }
}

export interface MarkDeps {
  store: ExampleStore;
  mode: Mode;
  modRoleId: string | undefined;
  /** Judged messages by message ID, so a mark saves the state the model actually judged. */
  recent: Recent<Judged>;
  /**
   * The same judgements by the ID of the bot's alert about them. In an acting mode the flagged
   * message is gone, and its alert is what a moderator can mark.
   */
  alerts: Recent<Judged>;
  /** The state the bot would judge for this message now. */
  rebuildState(message: Message<true>): Record<string, unknown>;
}

/** Saves the target message as a labelled example and tells the moderator, privately. */
export async function handleMark(
  interaction: MessageContextMenuCommandInteraction,
  label: Label,
  deps: MarkDeps,
): Promise<void> {
  const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!interaction.inCachedGuild()) {
    await reply("This works only in the server.");
    return;
  }
  const isMod =
    interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages) ||
    (deps.modRoleId !== undefined && interaction.member.roles.cache.has(deps.modRoleId));
  if (!isMod) {
    await reply("Only moderators can mark messages.");
    return;
  }

  const target = interaction.targetMessage;
  const isAlert = target.author.id === interaction.client.user.id;
  const judged = isAlert ? deps.alerts.get(target.id) : deps.recent.get(target.id);
  if (isAlert && !judged) {
    await reply(
      "That is one of my messages, but not an alert I remember: I keep only recent alerts, " +
        "and forget them when I restart. Mark the original message instead, if it is still there.",
    );
    return;
  }

  const source: Omit<Example, "label" | "markedBy" | "markedAt"> = judged
    ? {
        messageId: judged.messageId,
        guildId: judged.guildId,
        channelId: judged.channelId,
        authorId: judged.authorId,
        messageCreatedAt: judged.createdAt,
        state: judged.state,
        stateSource: "judged",
        judgement: {
          model: judged.model,
          label: judged.verdict.label,
          probabilities: judged.verdict.probabilities,
        },
      }
    : {
        messageId: target.id,
        guildId: target.guildId,
        channelId: target.channelId,
        authorId: target.author.id,
        messageCreatedAt: target.createdAt.toISOString(),
        state: deps.rebuildState(target),
        stateSource: "rebuilt",
        judgement: undefined,
      };
  let saved: Saved;
  try {
    saved = deps.store.save({
      ...source,
      label,
      markedBy: interaction.user.id,
      markedAt: new Date().toISOString(),
    });
  } catch (e) {
    log.error("saving a marked message failed", {
      messageId: source.messageId,
      error: errorText(e),
    });
    await reply(`Saving failed: ${errorText(e)}`);
    return;
  }
  log.info("marked", {
    messageId: source.messageId,
    label,
    markedBy: interaction.user.id,
    fromAlert: isAlert,
    exampleId: saved.id,
    previousLabel: saved.previousLabel,
  });
  const undo =
    isAlert && label === "legitimate" && deps.mode !== "shadow"
      ? " Marking does not undo what the bot did: restore the message or lift a ban by hand."
      : "";
  await reply(describe(saved, label, judged) + undo);
}

function describe(saved: Saved, label: Label, judged: Judged | undefined): string {
  const name = LABEL_NAMES[label];
  if (saved.previousLabel === label) return `Already saved as ${name} (example #${saved.id}).`;
  const head =
    saved.previousLabel === undefined
      ? `Saved as **${name}** (example #${saved.id}).`
      : `Changed example #${saved.id} from ${LABEL_NAMES[saved.previousLabel]} to **${name}**.`;
  if (!judged)
    return (
      `${head} The bot had not judged this message (it skips staff and exempt channels, and ` +
      "remembers only its recent messages), so the example holds what it would see now."
    );
  const p = Math.round(flagProbability(judged.verdict) * 100);
  return `${head} ${judged.model} had judged it ${judged.verdict.label} (${p}% spam or scam).`;
}
