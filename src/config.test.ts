import assert from "node:assert/strict";
import { test } from "node:test";
import { loadBotConfig, loadModelConfig } from "./config.ts";

const BASE = {
  DISCORD_TOKEN: "token",
  GUILD_ID: "123456789012345678",
  MOD_CHANNEL_ID: "223456789012345678",
  LIQUID_API_KEY: "liquid_test",
};

test("defaults to shadow mode, an 0.8 threshold and d1 on Liquid's API", () => {
  const config = loadBotConfig(BASE);
  assert.equal(config.mode, "shadow");
  assert.equal(config.threshold, 0.8);
  assert.equal(config.exemptStaff, true);
  assert.equal(config.classifyImages, false);
  assert.equal(config.databasePath, "data/liquidy.db");
  assert.deepEqual(config.model, {
    provider: "liquid",
    baseUrl: "https://api.liquid.ai",
    apiKey: "liquid_test",
    model: "d1",
    timeoutMs: 10_000,
  });
});

test("shadow mode needs a moderator channel; the other modes do not", () => {
  const { MOD_CHANNEL_ID: _, ...noChannel } = BASE;
  assert.throws(() => loadBotConfig(noChannel), /MOD_CHANNEL_ID/);
  assert.equal(loadBotConfig({ ...noChannel, MODE: "ban" }).mode, "ban");
});

test("a blank value counts as unset", () => {
  assert.equal(loadBotConfig({ ...BASE, MODE: "", FLAG_THRESHOLD: " " }).threshold, 0.8);
});

test("rejects an unknown mode and a threshold above 1", () => {
  assert.throws(() => loadBotConfig({ ...BASE, MODE: "mute" }), /MODE/);
  assert.throws(() => loadBotConfig({ ...BASE, FLAG_THRESHOLD: "1.5" }), /FLAG_THRESHOLD/);
});

test("ID lists are split on commas and each ID is checked", () => {
  const ids = "123456789012345678, 223456789012345678";
  assert.deepEqual(loadBotConfig({ ...BASE, EXEMPT_ROLE_IDS: ids }).exemptRoleIds, [
    "123456789012345678",
    "223456789012345678",
  ]);
  assert.throws(() => loadBotConfig({ ...BASE, EXEMPT_ROLE_IDS: "mods" }), /EXEMPT_ROLE_IDS/);
});

test("the hosted Liquid API needs a key; another System One URL may not", () => {
  assert.throws(() => loadModelConfig({}), /LIQUID_API_KEY/);
  const local = loadModelConfig({ LIQUID_BASE_URL: "http://localhost:8000/" });
  assert.equal(local.baseUrl, "http://localhost:8000");
  assert.equal(local.apiKey, undefined);
});

test("the OpenAI-compatible provider needs a base URL and a model name", () => {
  assert.throws(() => loadModelConfig({ MODEL_PROVIDER: "openai", MODEL: "x" }), /OPENAI_BASE_URL/);
  assert.throws(
    () => loadModelConfig({ MODEL_PROVIDER: "openai", OPENAI_BASE_URL: "http://litellm:4000/v1" }),
    /MODEL/,
  );
  assert.deepEqual(
    loadModelConfig({
      MODEL_PROVIDER: "openai",
      OPENAI_BASE_URL: "http://litellm:4000/v1",
      MODEL: "lfm-2.5",
    }),
    {
      provider: "openai",
      baseUrl: "http://litellm:4000/v1",
      apiKey: undefined,
      model: "lfm-2.5",
      timeoutMs: 10_000,
    },
  );
});
