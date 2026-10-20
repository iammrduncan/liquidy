import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  type Message,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { errorText, log } from "./log.ts";
import { flagProbability, type Verdict } from "./model/classifier.ts";
import type { ExampleStore, Saved } from "./store.ts";

/** The message commands (right-click a message > Apps) and the label each one saves. */
export const MARK_COMMANDS: Record<string, "spam" | "scam"> = {
  "Mark as spam": "spam",
  "Mark as scam": "scam",
};

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
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .toJSON(),
  );
}

export interface Judged {
  state: Record<string, unknown>;
  model: string;
  verdict: Verdict;
}

/**
 * What the bot saw and said for its most recent messages, so that a mark saves the state the
 * model actually judged rather than one rebuilt later. Kept in memory and capped.
 */
export class RecentJudgements {
  readonly #max: number;
  readonly #byMessage = new Map<string, Judged>();

  constructor(max: number) {
    this.#max = max;
  }

  add(messageId: string, judged: Judged): void {
    // Re-inserting moves an edited message to the newest end.
    this.#byMessage.delete(messageId);
    this.#byMessage.set(messageId, judged);
    if (this.#byMessage.size > this.#max) {
      const oldest = this.#byMessage.keys().next();
      if (!oldest.done) this.#byMessage.delete(oldest.value);
    }
  }

  get(messageId: string): Judged | undefined {
    return this.#byMessage.get(messageId);
  }
}

export interface MarkDeps {
  store: ExampleStore;
  recent: RecentJudgements;
  modRoleId: string | undefined;
  /** The state the bot would judge for this message now. */
  rebuildState(message: Message<true>): Record<string, unknown>;
}

/** Saves the target message as a labelled example and tells the moderator, privately. */
export async function handleMark(
  interaction: MessageContextMenuCommandInteraction,
  label: "spam" | "scam",
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

  const message = interaction.targetMessage;
  if (message.author.id === interaction.client.user.id) {
    await reply("That is one of my own messages.");
    return;
  }

  const judged = deps.recent.get(message.id);
  let saved: Saved;
  try {
    saved = deps.store.save({
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      label,
      state: judged?.state ?? deps.rebuildState(message),
      stateSource: judged ? "judged" : "rebuilt",
      judgement: judged && {
        model: judged.model,
        label: judged.verdict.label,
        probabilities: judged.verdict.probabilities,
      },
      markedBy: interaction.user.id,
      markedAt: new Date().toISOString(),
      messageCreatedAt: message.createdAt.toISOString(),
    });
  } catch (e) {
    log.error("saving a marked message failed", { messageId: message.id, error: errorText(e) });
    await reply(`Saving failed: ${errorText(e)}`);
    return;
  }
  log.info("marked", {
    messageId: message.id,
    label,
    markedBy: interaction.user.id,
    exampleId: saved.id,
    previousLabel: saved.previousLabel,
  });
  await reply(describe(saved, label, judged));
}

function describe(saved: Saved, label: "spam" | "scam", judged: Judged | undefined): string {
  if (saved.previousLabel === label) return `Already saved as ${label} (example #${saved.id}).`;
  const head =
    saved.previousLabel === undefined
      ? `Saved as **${label}** (example #${saved.id}).`
      : `Changed example #${saved.id} from ${saved.previousLabel} to **${label}**.`;
  if (!judged)
    return (
      `${head} The bot had not judged this message (it skips staff and exempt channels, and ` +
      "remembers only its recent messages), so the example holds what it would see now."
    );
  const p = Math.round(flagProbability(judged.verdict) * 100);
  return `${head} ${judged.model} had judged it ${judged.verdict.label} (${p}% spam or scam).`;
}
