import assert from "node:assert/strict";
import { test } from "node:test";
import { stubServer } from "../testing/http-stub.ts";
import { ModelError } from "./http.ts";
import { jsonObject, openaiClassifier, spread } from "./openai.ts";

interface SentBody {
  model: string;
  temperature: number;
  messages: Array<{ role: string; content: unknown }>;
  response_format: { type: string };
}

const config = (baseUrl: string, apiKey?: string) =>
  ({
    provider: "openai",
    baseUrl: `${baseUrl}/v1`,
    apiKey,
    model: "lfm-2.5",
    timeoutMs: 2000,
  }) as const;

const completion = (content: string) => ({
  choices: [{ message: { role: "assistant", content } }],
  usage: { prompt_tokens: 200, completion_tokens: 12 },
});

test("posts a chat completion asking for a JSON verdict and reads it", async () => {
  const stub = await stubServer({ body: completion('{"label":"spam","confidence":0.7}') });
  try {
    const state = { message: { text: "join my server discord.gg/abc" } };
    const verdict = await openaiClassifier(config(stub.url, "sk-test")).classify({
      state,
      images: [],
    });
    assert.equal(verdict.label, "spam");
    assert.equal(verdict.inputTokens, 200);
    assert.equal(verdict.probabilities.spam, 0.7);

    const [request] = stub.received;
    assert.ok(request);
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer sk-test");
    const body = request.body as SentBody;
    assert.equal(body.model, "lfm-2.5");
    assert.equal(body.temperature, 0);
    assert.equal(body.response_format.type, "json_schema");
    assert.deepEqual(
      body.messages.map((m) => m.role),
      ["system", "user"],
    );
    assert.deepEqual(JSON.parse(body.messages[1]?.content as string), state);
  } finally {
    await stub.close();
  }
});

test("sends no authorization header when no key is set", async () => {
  const stub = await stubServer({ body: completion('{"label":"legitimate","confidence":0.9}') });
  try {
    await openaiClassifier(config(stub.url)).classify({ state: {}, images: [] });
    assert.equal(stub.received[0]?.headers.authorization, undefined);
  } finally {
    await stub.close();
  }
});

test("sends images as image_url parts after the text", async () => {
  const stub = await stubServer({ body: completion('{"label":"scam","confidence":0.95}') });
  try {
    const image = "data:image/png;base64,iVBORw0KGgo=";
    await openaiClassifier(config(stub.url)).classify({ state: {}, images: [image] });
    const user = (stub.body(0) as SentBody).messages[1];
    assert.deepEqual(user?.content, [
      { type: "text", text: "{}" },
      { type: "image_url", image_url: { url: image } },
    ]);
  } finally {
    await stub.close();
  }
});

test("a label outside the three is rejected", async () => {
  const stub = await stubServer({ body: completion('{"label":"phishing","confidence":0.9}') });
  try {
    await assert.rejects(
      openaiClassifier(config(stub.url)).classify({ state: {}, images: [] }),
      ModelError,
    );
  } finally {
    await stub.close();
  }
});

test("jsonObject finds the verdict after reasoning and inside code fences", () => {
  assert.deepEqual(jsonObject('<think>is {this} a scam?</think>\n```json\n{"label":"scam"}\n```'), {
    label: "scam",
  });
  assert.throws(() => jsonObject("I think it is spam."), ModelError);
});

test("spread gives the label its confidence and splits the rest", () => {
  assert.deepEqual(spread("legitimate", 0.5), { legitimate: 0.5, spam: 0.25, scam: 0.25 });
});
