import { z } from "zod";

export const MODES = ["shadow", "delete", "kick", "ban"] as const;
export type Mode = (typeof MODES)[number];

const LIQUID_API = "https://api.liquid.ai";
const DEFAULT_DATABASE_PATH = "data/liquidy.db";

export type ModelConfig =
  | {
      /** Liquid AI's System One decision API, or anything that serves the same route. */
      provider: "liquid";
      baseUrl: string;
      apiKey: string | undefined;
      model: string;
      timeoutMs: number;
    }
  | {
      /** An OpenAI-compatible chat completions endpoint (LiteLLM, vLLM, llama-server, ...). */
      provider: "openai";
      baseUrl: string;
      apiKey: string | undefined;
      model: string;
      timeoutMs: number;
    };

export interface BotConfig {
  discordToken: string;
  guildId: string;
  mode: Mode;
  modChannelId: string | undefined;
  modRoleId: string | undefined;
  /** Act when P(spam) + P(scam) is at least this. */
  threshold: number;
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  /** Skip members who can already moderate (Manage Messages, Kick, Ban, Timeout, Administrator). */
  exemptStaff: boolean;
  /** Free text about the server that the model reads with every message, such as what is on-topic. */
  serverContext: string | undefined;
  /** How many earlier messages in the channel to include as context. */
  channelContextMessages: number;
  classifyImages: boolean;
  maxConcurrency: number;
  /** SQLite file for messages moderators mark. */
  databasePath: string;
  model: ModelConfig;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord ID (17 to 20 digits)");
const idList = z
  .string()
  .optional()
  .transform((s) =>
    (s ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  )
  .pipe(z.array(snowflake));

const ModelEnv = z.object({
  MODEL_PROVIDER: z.enum(["liquid", "openai"]).default("liquid"),
  MODEL: z.string().optional(),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  LIQUID_API_KEY: z.string().optional(),
  LIQUID_BASE_URL: z.url().default(LIQUID_API),
  OPENAI_BASE_URL: z.url().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

const BotEnv = ModelEnv.extend({
  DISCORD_TOKEN: z.string(),
  GUILD_ID: snowflake,
  MODE: z.enum(MODES).default("shadow"),
  MOD_CHANNEL_ID: snowflake.optional(),
  MOD_ROLE_ID: snowflake.optional(),
  FLAG_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  EXEMPT_ROLE_IDS: idList,
  EXEMPT_CHANNEL_IDS: idList,
  EXEMPT_STAFF: z.stringbool().default(true),
  SERVER_CONTEXT: z.string().optional(),
  CHANNEL_CONTEXT_MESSAGES: z.coerce.number().int().min(0).max(20).default(5),
  CLASSIFY_IMAGES: z.stringbool().default(false),
  MAX_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  DATABASE_PATH: z.string().default(DEFAULT_DATABASE_PATH),
});

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.output<T> {
  // A blank value means unset, as when a line in .env is left empty.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v?.trim()));
  const result = schema.safeParse(set);
  if (!result.success)
    throw new ConfigError(`invalid configuration:\n${z.prettifyError(result.error)}`);
  return result.data;
}

function modelConfig(e: z.output<typeof ModelEnv>): ModelConfig {
  const timeoutMs = e.MODEL_TIMEOUT_MS;
  if (e.MODEL_PROVIDER === "liquid") {
    const baseUrl = e.LIQUID_BASE_URL.replace(/\/+$/, "");
    if (!e.LIQUID_API_KEY && baseUrl === LIQUID_API)
      throw new ConfigError(`LIQUID_API_KEY is required for ${LIQUID_API}`);
    return {
      provider: "liquid",
      baseUrl,
      apiKey: e.LIQUID_API_KEY,
      model: e.MODEL ?? "d1",
      timeoutMs,
    };
  }
  if (!e.OPENAI_BASE_URL)
    throw new ConfigError("OPENAI_BASE_URL is required when MODEL_PROVIDER=openai");
  if (!e.MODEL)
    throw new ConfigError(
      "MODEL is required when MODEL_PROVIDER=openai: the name your endpoint serves",
    );
  return {
    provider: "openai",
    baseUrl: e.OPENAI_BASE_URL.replace(/\/+$/, ""),
    apiKey: e.OPENAI_API_KEY,
    model: e.MODEL,
    timeoutMs,
  };
}

/** The model settings alone, for tools that call the model without Discord. */
export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return modelConfig(parse(ModelEnv, env));
}

/** The database path alone, for the export. */
export function loadDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const e = parse(BotEnv, env);
  if (e.MODE === "shadow" && !e.MOD_CHANNEL_ID)
    throw new ConfigError(
      "MOD_CHANNEL_ID is required in shadow mode: alerts are all that mode does",
    );
  return {
    discordToken: e.DISCORD_TOKEN,
    guildId: e.GUILD_ID,
    mode: e.MODE,
    modChannelId: e.MOD_CHANNEL_ID,
    modRoleId: e.MOD_ROLE_ID,
    threshold: e.FLAG_THRESHOLD,
    exemptRoleIds: e.EXEMPT_ROLE_IDS,
    exemptChannelIds: e.EXEMPT_CHANNEL_IDS,
    exemptStaff: e.EXEMPT_STAFF,
    serverContext: e.SERVER_CONTEXT,
    channelContextMessages: e.CHANNEL_CONTEXT_MESSAGES,
    classifyImages: e.CLASSIFY_IMAGES,
    maxConcurrency: e.MAX_CONCURRENCY,
    databasePath: e.DATABASE_PATH,
    model: modelConfig(e),
  };
}
