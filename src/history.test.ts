import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthorHistory } from "./history.ts";

const MINUTE = 60_000;

test("counts the same message posted across channels", () => {
  const history = new AuthorHistory(10 * MINUTE);
  history.record("u1", "c1", "free nitro|", 0);
  history.record("u1", "c2", "free nitro|", MINUTE);
  history.record("u1", "c3", "something else|", 2 * MINUTE);
  assert.deepEqual(history.activity("u1", "free nitro|", 3 * MINUTE), {
    windowMinutes: 10,
    messages: 3,
    channels: 3,
    identicalMessages: 2,
  });
});

test("forgets messages older than the window", () => {
  const history = new AuthorHistory(10 * MINUTE);
  history.record("u1", "c1", "free nitro|", 0);
  assert.equal(history.activity("u1", "free nitro|", 10 * MINUTE).messages, 0);
  history.sweep(10 * MINUTE);
  assert.equal(history.activity("u1", "free nitro|", 0).messages, 0);
});

test("an empty fingerprint never counts as identical", () => {
  const history = new AuthorHistory(10 * MINUTE);
  history.record("u1", "c1", "", 0);
  assert.equal(history.activity("u1", "", MINUTE).identicalMessages, 0);
});

test("keeps authors apart", () => {
  const history = new AuthorHistory(10 * MINUTE);
  history.record("u1", "c1", "free nitro|", 0);
  assert.equal(history.activity("u2", "free nitro|", MINUTE).messages, 0);
});

test("only messages before `now` count, so judging a message again does not count itself", () => {
  const history = new AuthorHistory(10 * MINUTE);
  history.record("u1", "c1", "free nitro|", MINUTE);
  history.record("u1", "c2", "free nitro|", 2 * MINUTE);
  assert.equal(history.activity("u1", "free nitro|", MINUTE).identicalMessages, 0);
});
