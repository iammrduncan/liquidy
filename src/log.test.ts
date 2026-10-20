import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { log, setLogLevel } from "./log.ts";

test("events below the level are hidden, and debug shows when asked for", () => {
  const printed = mock.method(console, "log", () => {});
  try {
    setLogLevel("info");
    log.debug("skipped");
    log.info("judged");
    setLogLevel("debug");
    log.debug("skipped");
    const lines = printed.mock.calls.map((c) => JSON.parse(String(c.arguments[0])).msg);
    assert.deepEqual(lines, ["judged", "skipped"]);
  } finally {
    printed.mock.restore();
    setLogLevel("info");
  }
});
