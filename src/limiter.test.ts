import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { limiter } from "./limiter.ts";

test("never runs more than max tasks at once, and runs them all in order", async () => {
  const run = limiter(2);
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const task = (i: number) => async () => {
    started.push(i);
    active++;
    peak = Math.max(peak, active);
    await sleep(5);
    active--;
    return i;
  };
  const results = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => run(task(i))));
  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
});

test("a failing task frees its slot", async () => {
  const run = limiter(1);
  await assert.rejects(
    run(() => Promise.reject(new Error("boom"))),
    /boom/,
  );
  assert.equal(await run(() => Promise.resolve("next")), "next");
});
