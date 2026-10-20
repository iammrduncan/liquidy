import {
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { BotConfig, Mode } from "./config.ts";
import { buildState, fingerprint } from "./context.ts";
import { Enforcer } from "./enforce.ts";
import { AuthorHistory } from "./history.ts";
import { collectImages } from "./images.ts";
import { limiter } from "./limiter.ts";
import { errorText, log } from "./log.ts";
import { handleMark, MARK_COMMANDS, markCommands, RecentJudgements } from "./mark.ts";
import { type Classifier, flagProbability } from "./model/classifier.ts";
import type { ExampleStore } from "./store.ts";

const HISTORY_WINDOW_MS = 10 * 60_000;
/** Judged messages remembered for the mark commands; a few KB each. */
const RECENT_JUDGEMENTS = 2000;

/** Members with any of these can already moderate, so their messages are not judged. */
const STAFF = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
];

/** What each mode needs in the server. Kick needs Ban Members: it is a ban lifted at once. */
const MODE_PERMISSIONS: Record<Mode, bigint[]> = {
  shadow: [],
  delete: [PermissionFlagsBits.ManageMessages],
  kick: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.BanMembers],
  ban: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.BanMembers],
};

const ALERT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

/**
 * Logs in, checks the server and moderator channel, registers the mark commands, then judges
 * every new or edited message.
 */
export async function startBot(
  config: BotConfig,
  classifier: Classifier,
  store: ExampleStore,
): Promise<Client<true>> {
  // MessageContent is a privileged intent: enable it for the bot in the Developer Portal.
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  try {
    const ready = new Promise<Client<true>>((resolve) => client.once(Events.ClientReady, resolve));
    await client.login(config.discordToken);
    const bot = await ready;
    const guild = bot.guilds.cache.get(config.guildId);
    if (!guild) throw new Error(`the bot is not in the server GUILD_ID names (${config.guildId})`);
    const modChannel = await resolveModChannel(bot, config);
    checkPermissions(guild, modChannel, config.mode);
    // Server commands, not global ones: they update at once and exist only where the bot watches.
    await guild.commands.set(markCommands()).catch((e: unknown) =>
      log.warn(
        "could not register the mark commands; was the bot invited with applications.commands?",
        {
          error: errorText(e),
        },
      ),
    );
    listen(
      bot,
      config,
      classifier,
      new Enforcer({
        mode: config.mode,
        modChannel,
        modRoleId: config.modRoleId,
        modelName: classifier.name,
      }),
      store,
    );
    log.info("watching", { guild: guild.name, mode: config.mode, model: classifier.name });
    return bot;
  } catch (e) {
    await client.destroy();
    throw e;
  }
}

function listen(
  client: Client<true>,
  config: BotConfig,
  classifier: Classifier,
  enforcer: Enforcer,
  store: ExampleStore,
) {
  const history = new AuthorHistory(HISTORY_WINDOW_MS);
  setInterval(() => history.sweep(Date.now()), 60_000).unref();
  const recent = new RecentJudgements(RECENT_JUDGEMENTS);
  const run = limiter(config.maxConcurrency);

  const stateFor = (message: Message<true>, edited: boolean) => {
    const fp = fingerprint(message.content, message.attachments.values());
    return buildState(message, history.activity(message.author.id, fp, message.createdTimestamp), {
      edited,
      serverContext: config.serverContext,
      channelContextMessages: config.channelContextMessages,
    });
  };

  const screen = async (message: Message, edited: boolean): Promise<void> => {
    if (!message.inGuild() || message.guildId !== config.guildId) return;
    if (message.author.bot || message.webhookId || message.system) return;
    if (isExempt(message, config) || enforcer.recentlyRemoved(message.author.id)) return;

    // The state is built before the message joins the history, which it must not count.
    const state = stateFor(message, edited);
    if (!edited) {
      const fp = fingerprint(message.content, message.attachments.values());
      history.record(message.author.id, message.channelId, fp, message.createdTimestamp);
    }
    if (!message.content.trim() && message.attachments.size === 0) return;

    const started = performance.now();
    const verdict = await run(async () => {
      // In a raid, the author may have been removed while this message waited in the queue.
      if (enforcer.recentlyRemoved(message.author.id)) return undefined;
      const images = config.classifyImages
        ? await collectImages(message, config.model.timeoutMs)
        : [];
      return classifier.classify({ state, images });
    });
    if (!verdict) return;
    recent.add(message.id, { state, model: classifier.name, verdict });
    const probability = flagProbability(verdict);
    log.info("judged", {
      messageId: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      edited,
      label: verdict.label,
      flagProbability: Math.round(probability * 1000) / 1000,
      inputTokens: verdict.inputTokens,
      ms: Math.round(performance.now() - started),
    });
    if (probability >= config.threshold) await enforcer.enforce(message, verdict, probability);
  };

  const handle = (message: Message, edited: boolean) => {
    screen(message, edited).catch((e) =>
      log.error("judging a message failed; no action taken", {
        messageId: message.id,
        error: errorText(e),
      }),
    );
  };

  client.on(Events.MessageCreate, (message) => handle(message, false));
  // Only cached messages report edits, which covers recent ones. A changed text is judged again
  // (a harmless message can be edited into a scam); link previews arriving are not.
  client.on(Events.MessageUpdate, (before, after) => {
    if (!after.partial && before.content !== after.content) handle(after, true);
  });

  const markDeps = {
    store,
    recent,
    modRoleId: config.modRoleId,
    rebuildState: (message: Message<true>) => stateFor(message, message.editedTimestamp !== null),
  };
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isMessageContextMenuCommand()) return;
    const label = MARK_COMMANDS[interaction.commandName];
    if (!label) return;
    handleMark(interaction, label, markDeps).catch((e) =>
      log.error("the mark command failed", {
        messageId: interaction.targetId,
        error: errorText(e),
      }),
    );
  });
}

function isExempt(message: Message<true>, config: BotConfig): boolean {
  const { channel, member } = message;
  const parentId = channel.isThread() ? channel.parentId : null;
  if (config.exemptChannelIds.includes(message.channelId)) return true;
  if (parentId && config.exemptChannelIds.includes(parentId)) return true;
  if (!member) return false;
  if (config.exemptRoleIds.some((id) => member.roles.cache.has(id))) return true;
  return config.exemptStaff && member.permissions.any(STAFF);
}

async function resolveModChannel(
  client: Client<true>,
  config: BotConfig,
): Promise<GuildTextBasedChannel | undefined> {
  if (!config.modChannelId) return undefined;
  const channel = await client.channels.fetch(config.modChannelId).catch((e: unknown) => {
    throw new Error(`cannot open MOD_CHANNEL_ID ${config.modChannelId}: ${errorText(e)}`);
  });
  if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== config.guildId)
    throw new Error(`MOD_CHANNEL_ID ${config.modChannelId} is not a text channel in GUILD_ID`);
  return channel;
}

/** Warns at startup about permissions the mode will need, rather than failing on the first scam. */
function checkPermissions(guild: Guild, modChannel: GuildTextBasedChannel | undefined, mode: Mode) {
  const me = guild.members.me;
  if (!me) return;
  const missing = MODE_PERMISSIONS[mode].filter((p) => !me.permissions.has(p));
  if (missing.length > 0)
    log.warn("the bot lacks permissions this mode needs", { mode, missing: names(missing) });
  const inChannel = modChannel?.permissionsFor(me);
  const missingAlert = inChannel ? ALERT_PERMISSIONS.filter((p) => !inChannel.has(p)) : [];
  if (missingAlert.length > 0)
    log.warn("the bot cannot post alerts in the moderator channel", {
      missing: names(missingAlert),
    });
}

function names(permissions: bigint[]): string[] {
  return new PermissionsBitField(permissions).toArray();
}
