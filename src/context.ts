import type { Message } from "discord.js";
import type { Activity } from "./history.ts";

const DAY_MS = 86_400_000;
const MAX_TEXT = 2000;
const MAX_CONTEXT_TEXT = 300;
const MAX_LINKS = 10;
/** Shorter texts ("hi", "lol") repeat innocently, so they never count as identical messages. */
const MIN_FINGERPRINT_TEXT = 10;

export interface StateOptions {
  edited: boolean;
  serverContext: string | undefined;
  channelContextMessages: number;
}

/**
 * The state the model judges: the message, who sent it and where. Keys whose value is undefined
 * drop out when the state is serialised, which keeps the prompt short.
 */
export function buildState(
  message: Message<true>,
  activity: Activity,
  opts: StateOptions,
): Record<string, unknown> {
  const { author, member, channel, guild } = message;
  const at = message.createdTimestamp;
  return {
    server: { name: guild.name, notes: opts.serverContext },
    channel: {
      name: channel.name,
      topic: "topic" in channel ? (channel.topic ?? undefined) : undefined,
      parent: channel.isThread() ? channel.parent?.name : undefined,
    },
    message: {
      text: clip(message.content, MAX_TEXT),
      edited: opts.edited || undefined,
      links: nonEmpty(extractLinks(message.content).slice(0, MAX_LINKS)),
      attachments: nonEmpty(
        message.attachments.map((a) => ({
          name: a.name,
          type: a.contentType ?? undefined,
          sizeKB: Math.round(a.size / 1024),
        })),
      ),
      embeds: nonEmpty(
        message.embeds.slice(0, 3).map((e) => ({
          title: e.title ?? undefined,
          description: e.description ? clip(e.description, MAX_CONTEXT_TEXT) : undefined,
          url: e.url ?? undefined,
        })),
      ),
      mentions: {
        everyone: message.mentions.everyone,
        users: message.mentions.users.size,
        roles: message.mentions.roles.size,
      },
    },
    author: {
      username: author.username,
      displayName: member?.displayName ?? author.displayName,
      accountAgeDays: days(at - author.createdTimestamp),
      memberForDays: member?.joinedTimestamp ? days(at - member.joinedTimestamp) : undefined,
      roles: member ? member.roles.cache.size - 1 : undefined,
      hasAvatar: author.avatar !== null,
    },
    recentActivity: activity,
    recentChannelMessages: nonEmpty(earlierMessages(message, opts.channelContextMessages)),
  };
}

/** The last `count` cached messages before this one in its channel; no API calls. */
function earlierMessages(message: Message<true>, count: number) {
  if (count === 0) return [];
  return [...message.channel.messages.cache.values()]
    .filter((m) => m.id !== message.id && m.createdTimestamp <= message.createdTimestamp)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-count)
    .map((m) => ({
      author: m.member?.displayName ?? m.author.displayName,
      sameAuthor: m.author.id === message.author.id || undefined,
      text: clip(m.content, MAX_CONTEXT_TEXT),
    }));
}

/**
 * Links in the text with their parsed host. URL parsing turns Unicode lookalike hosts into
 * punycode ("xn--"), which is a strong phishing signal the raw text hides.
 */
export function extractLinks(text: string): Array<{ url: string; host?: string }> {
  return [...text.matchAll(/https?:\/\/[^\s<>()]+/gi)].map(([raw]) => ({
    url: clip(raw, 200),
    host: URL.parse(raw)?.hostname,
  }));
}

/** A key for "the same message": normalised text plus attachment sizes, or "" for none. */
export function fingerprint(content: string, attachments: Iterable<{ size: number }>): string {
  const text = content.toLowerCase().replace(/\s+/g, " ").trim();
  const files = [...attachments].map((a) => a.size).join(",");
  if (!files && text.length < MIN_FINGERPRINT_TEXT) return "";
  return `${text}|${files}`;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function days(ms: number): number {
  return Math.round((ms / DAY_MS) * 10) / 10;
}

function nonEmpty<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}
