import assert from "node:assert/strict";
import { test } from "node:test";
import { stubServer } from "../testing/http-stub.ts";
import { LABELS } from "./classifier.ts";
import { ModelError } from "./http.ts";
import { liquidClassifier } from "./liquid.ts";

interface SentBody {
  model: string;
  state: string;
  questions: Record<string, { type: string; criteria: Record<string, string> }>;
  images?: string[];
}

const PROBABILITIES = { legitimate: 0.02, spam: 0.08, scam: 0.9 };
const REPLY = {
  model: "d1",
  answers: {
    verdict: { type: "choice", choice: "scam", probabilities: PROBABILITIES, confidence: 0.85 },
  },
  usage: { input_tokens: 321, output_tokens: 0 },
};

const config = (baseUrl: string) => ({
  baseUrl,
  apiKey: "liquid_test",
  model: "d1",
  timeoutMs: 2000,
});

test("asks d1 one Choice question over the three labels and returns its probabilities", async () => {
  const stub = await stubServer({ body: REPLY });
  try {
    const state = { message: { text: "free nitro https://dlscord.gift" } };
    const verdict = await liquidClassifier(config(stub.url)).classify({ state, images: [] });
    assert.deepEqual(verdict, { label: "scam", probabilities: PROBABILITIES, inputTokens: 321 });

    const [request] = stub.received;
    assert.ok(request);
    assert.equal(request.url, "/decisions/v1/systemone");
    assert.equal(request.headers.authorization, "Bearer liquid_test");
    const body = request.body as SentBody;
    assert.equal(body.model, "d1");
    assert.deepEqual(JSON.parse(body.state), state);
    assert.deepEqual(Object.keys(body.questions), ["verdict"]);
    assert.equal(body.questions.verdict?.type, "choice");
    assert.deepEqual(
      Object.keys(body.questions.verdict?.criteria ?? {}).sort(),
      [...LABELS].sort(),
    );
    assert.equal(body.images, undefined);
  } finally {
    await stub.close();
  }
});

test("sends images alongside the state", async () => {
  const stub = await stubServer({ body: REPLY });
  try {
    const images = ["data:image/png;base64,iVBORw0KGgo="];
    await liquidClassifier(config(stub.url)).classify({ state: {}, images });
    assert.deepEqual((stub.body(0) as SentBody).images, images);
  } finally {
    await stub.close();
  }
});

test("an error status is a ModelError carrying the status", async () => {
  const stub = await stubServer({ status: 429, body: { error: "rate limited" } });
  try {
    await assert.rejects(
      liquidClassifier(config(stub.url)).classify({ state: {}, images: [] }),
      (e) => e instanceof ModelError && e.status === 429,
    );
  } finally {
    await stub.close();
  }
});

test("a reply without the verdict answer is rejected, not read as legitimate", async () => {
  const stub = await stubServer({ body: { model: "d1", answers: {} } });
  try {
    await assert.rejects(
      liquidClassifier(config(stub.url)).classify({ state: {}, images: [] }),
      ModelError,
    );
  } finally {
    await stub.close();
  }
});
