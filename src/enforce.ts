import {
  channelMention,
  codeBlock,
  DiscordAPIError,
  EmbedBuilder,
  type GuildTextBasedChannel,
  hyperlink,
  type Message,
  RESTJSONErrorCodes,
  roleMention,
  userMention,
} from "discord.js";
import type { Mode } from "./config.ts";
import { clip } from "./context.ts";
import { errorText, log } from "./log.ts";
import { flaggedLabel, type Verdict } from "./model/classifier.ts";

/** Kick and ban delete the author's messages from the last 24 hours. */
const PURGE_SECONDS = 24 * 60 * 60;
/** How long a removed author's later messages are ignored, and how often one author pings mods. */
const COOLDOWN_MS = 10 * 60_000;

export interface EnforcerOptions {
  mode: Mode;
  modChannel: GuildTextBasedChannel | undefined;
  modRoleId: string | undefined;
  modelName: string;
}

interface Outcome {
  /** What happened, for the alert. */
  text: string;
  /** Moderators should look: nothing was done (shadow mode) or the action failed. */
  attention: boolean;
  /** The message is gone, so the alert cannot link to it. */
  messageRemoved: boolean;
  /** The author is out of the server, so their queued messages need no action. */
  authorRemoved: boolean;
}

/** Carries out the configured mode on flagged messages and tells moderators what it did. */
export class Enforcer {
  readonly #opts: EnforcerOptions;
  readonly #removed = new Cooldown(COOLDOWN_MS);
  readonly #pinged = new Cooldown(COOLDOWN_MS);

  constructor(opts: EnforcerOptions) {
    this.#opts = opts;
  }

  /**
   * True for an author this bot just kicked or banned. A raid posts many messages before the
   * first removal lands, and the removal already deleted them.
   */
  recentlyRemoved(userId: string): boolean {
    return this.#removed.has(userId, Date.now());
  }

  async enforce(message: Message<true>, verdict: Verdict, probability: number): Promise<void> {
    const { mode, modChannel, modRoleId } = this.#opts;
    const userId = message.author.id;
    if (this.recentlyRemoved(userId)) return;

    const label = flaggedLabel(verdict);
    const reason = `Liquidy: ${label} (${percent(probability)}) in #${message.channel.name}`;
    const outcome = await act(mode, message, reason);
    if (outcome.authorRemoved) this.#removed.add(userId, Date.now());
    log.info("enforced", {
      mode,
      messageId: message.id,
      authorId: userId,
      label,
      outcome: outcome.text,
    });

    if (!modChannel) return;
    const ping =
      modRoleId !== undefined && outcome.attention && !this.#pinged.has(userId, Date.now());
    if (ping) this.#pinged.add(userId, Date.now());
    try {
      await modChannel.send({
        content: ping ? roleMention(modRoleId) : undefined,
        embeds: [alertEmbed(message, verdict, probability, outcome, this.#opts.modelName)],
        // Only the moderator role may ping; nothing quoted from the message can.
        allowedMentions: { parse: [], roles: ping ? [modRoleId] : [] },
      });
    } catch (e) {
      log.error("moderator alert failed", { messageId: message.id, error: errorText(e) });
    }
  }
}

function act(mode: Mode, message: Message<true>, reason: string): Promise<Outcome> {
  switch (mode) {
    case "shadow":
      return Promise.resolve({
        text: "None (shadow mode).",
        attention: true,
        messageRemoved: false,
        authorRemoved: false,
      });
    case "delete":
      return deleteMessage(message);
    case "kick":
      return removeAuthor(message, reason, false);
    case "ban":
      return removeAuthor(message, reason, true);
  }
}

async function deleteMessage(message: Message<true>): Promise<Outcome> {
  const done = { attention: false, messageRemoved: true, authorRemoved: false };
  try {
    await message.delete();
    return { ...done, text: "Message deleted." };
  } catch (e) {
    if (e instanceof DiscordAPIError && e.code === RESTJSONErrorCodes.UnknownMessage)
      return { ...done, text: "Message was already deleted." };
    return {
      text: `Deleting the message failed: ${errorText(e)}`,
      attention: true,
      messageRemoved: false,
      authorRemoved: false,
    };
  }
}

/**
 * Bans the author, deleting their messages from the last 24 hours. Discord's kick cannot delete
 * messages, so a kick is a ban lifted straight away (a "softban"): the author is out of the
 * server and may rejoin by invite.
 */
async function removeAuthor(
  message: Message<true>,
  reason: string,
  keepBan: boolean,
): Promise<Outcome> {
  const { guild, member, author } = message;
  const action = keepBan ? "ban" : "kick";
  // The member is missing when they left already; banning by ID still deletes their messages.
  if (member && !member.bannable) {
    const deleted = await deleteMessage(message);
    return {
      ...deleted,
      text: `Could not ${action}: their highest role is above the bot's, or the bot lacks Ban Members. ${deleted.text}`,
      attention: true,
    };
  }
  try {
    await guild.members.ban(author.id, { deleteMessageSeconds: PURGE_SECONDS, reason });
  } catch (e) {
    const deleted = await deleteMessage(message);
    return {
      ...deleted,
      text: `The ${action} failed: ${errorText(e)}. ${deleted.text}`,
      attention: true,
    };
  }
  const removed = { messageRemoved: true, authorRemoved: true };
  if (keepBan)
    return {
      ...removed,
      attention: false,
      text: "Banned; their last 24 hours of messages deleted.",
    };
  try {
    await guild.members.unban(
      author.id,
      "Liquidy kick: lifting the ban that deleted their messages",
    );
  } catch (e) {
    return {
      ...removed,
      attention: true,
      text: `Their last 24 hours of messages were deleted, but lifting the ban failed, so they are still banned: ${errorText(e)}`,
    };
  }
  return { ...removed, attention: false, text: "Kicked; their last 24 hours of messages deleted." };
}

function alertEmbed(
  message: Message<true>,
  verdict: Verdict,
  probability: number,
  outcome: Outcome,
  modelName: string,
): EmbedBuilder {
  const label = flaggedLabel(verdict);
  const { author } = message;
  const fields = [
    { name: "Author", value: `${userMention(author.id)} · ${author.username} · ${author.id}` },
    { name: "Channel", value: channelMention(message.channelId), inline: true },
    { name: "Action", value: clip(outcome.text, 1000) },
  ];
  if (!outcome.messageRemoved)
    fields.push({ name: "Message", value: hyperlink("Jump to message", message.url) });
  if (message.attachments.size > 0)
    fields.push({
      name: "Attachments",
      value: clip(message.attachments.map((a) => a.name).join(", "), 1000),
    });
  const { spam, scam } = verdict.probabilities;
  return (
    new EmbedBuilder()
      .setColor(label === "scam" ? 0xd93f3f : 0xe8a33d)
      .setTitle(`Possible ${label} (${percent(probability)})`)
      // In a code block, Discord neither renders the links nor lets them be clicked by accident.
      .setDescription(
        message.content ? codeBlock(clip(defang(message.content), 1500)) : "*No text*",
      )
      .addFields(fields)
      .setFooter({ text: `${modelName} · spam ${percent(spam)} · scam ${percent(scam)}` })
      .setTimestamp(message.createdAt)
  );
}

/** Stops the quoted text from closing the code block it is shown in. */
function defang(text: string): string {
  return text.replaceAll("```", "`​`​`");
}

function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** User IDs remembered for a while. */
class Cooldown {
  readonly #ms: number;
  readonly #until = new Map<string, number>();

  constructor(ms: number) {
    this.#ms = ms;
  }

  has(id: string, now: number): boolean {
    return (this.#until.get(id) ?? 0) > now;
  }

  add(id: string, now: number): void {
    if (this.#until.size > 1000)
      for (const [key, until] of this.#until) if (until <= now) this.#until.delete(key);
    this.#until.set(id, now + this.#ms);
  }
}
