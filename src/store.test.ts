import assert from "node:assert/strict";
import { test } from "node:test";
import { Recent } from "./mark.ts";
import { type Example, ExampleStore } from "./store.ts";

const example = (overrides: Partial<Example> = {}): Example => ({
  messageId: "300000000000000001",
  guildId: "100000000000000001",
  channelId: "200000000000000001",
  authorId: "400000000000000001",
  label: "spam",
  state: { message: { text: "join discord.gg/abc" } },
  stateSource: "judged",
  judgement: {
    model: "liquid:d1",
    label: "legitimate",
    probabilities: { legitimate: 0.75, spam: 0.25, scam: 0 },
  },
  markedBy: "500000000000000001",
  markedAt: "2026-10-19T12:00:00.000Z",
  messageCreatedAt: "2026-10-19T11:59:00.000Z",
  ...overrides,
});

test("saves an example and reads it back as it was saved", () => {
  const store = new ExampleStore(":memory:");
  const saved = store.save(example());
  assert.deepEqual(saved, { id: 1, previousLabel: undefined });
  assert.deepEqual(store.examples(), [{ id: 1, ...example() }]);
});

test("marking again changes the label and marker but keeps the state saved first", () => {
  const store = new ExampleStore(":memory:");
  store.save(example());
  const again = store.save(
    example({
      label: "scam",
      state: { rebuilt: true },
      stateSource: "rebuilt",
      judgement: undefined,
      markedBy: "500000000000000002",
    }),
  );
  assert.deepEqual(again, { id: 1, previousLabel: "spam" });
  const [stored] = store.examples();
  assert.equal(stored?.label, "scam");
  assert.equal(stored?.markedBy, "500000000000000002");
  assert.deepEqual(stored?.state, example().state);
  assert.equal(stored?.stateSource, "judged");
  assert.deepEqual(stored?.judgement, example().judgement);
});

test("an example the bot never judged has no judgement", () => {
  const store = new ExampleStore(":memory:");
  store.save(example({ stateSource: "rebuilt", judgement: undefined }));
  assert.equal(store.examples()[0]?.judgement, undefined);
});

test("the database refuses a label outside the three", () => {
  const store = new ExampleStore(":memory:");
  assert.throws(() => store.save(example({ label: "phishing" as "spam" })), /CHECK constraint/);
});

test("Recent forgets the oldest key past the cap, counting a re-added key as new", () => {
  const recent = new Recent<number>(2);
  recent.add("a", 1);
  recent.add("b", 2);
  recent.add("a", 3);
  recent.add("c", 4);
  assert.equal(recent.get("b"), undefined);
  assert.equal(recent.get("a"), 3);
  assert.equal(recent.get("c"), 4);
});

test("a false positive can be relabelled as legitimate", () => {
  const store = new ExampleStore(":memory:");
  store.save(example({ label: "scam" }));
  assert.deepEqual(store.save(example({ label: "legitimate" })), { id: 1, previousLabel: "scam" });
  assert.equal(store.examples()[0]?.label, "legitimate");
});
