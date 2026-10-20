import assert from "node:assert/strict";
import { test } from "node:test";
import { leaveOtherServers } from "./private.ts";

const server = (id: string, left: string[], fails = false) => ({
  id,
  name: `server ${id}`,
  leave: async () => {
    if (fails) throw new Error("Missing Access");
    left.push(id);
  },
});

test("leaves every server except the watched one", async () => {
  const left: string[] = [];
  const result = await leaveOtherServers(
    [server("1", left), server("2", left), server("3", left)],
    "2",
  );
  assert.deepEqual(left, ["1", "3"]);
  assert.deepEqual(result, ["1", "3"]);
});

test("a server it cannot leave does not stop it leaving the rest", async () => {
  const left: string[] = [];
  const result = await leaveOtherServers([server("1", left, true), server("3", left)], "2");
  assert.deepEqual(result, ["3"]);
});
