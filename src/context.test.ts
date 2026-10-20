import assert from "node:assert/strict";
import { test } from "node:test";
import { extractLinks, fingerprint } from "./context.ts";
import { scaledUrl } from "./images.ts";
import { flaggedLabel, flagProbability } from "./model/classifier.ts";

test("extractLinks shows lookalike Unicode hosts as punycode", () => {
  // і is the Cyrillic "і", which renders like the Latin "i".
  assert.deepEqual(extractLinks("claim at https://dіscord.com/gift (now!)"), [
    { url: "https://dіscord.com/gift", host: "xn--dscord-pvf.com" },
  ]);
});

test("extractLinks takes the target of a masked link", () => {
  const links = extractLinks("[discord.com/nitro](https://steamcommunlty.ru/claim)");
  assert.deepEqual(
    links.map((l) => l.host),
    ["steamcommunlty.ru"],
  );
});

test("fingerprint ignores case and spacing, and leaves short texts out", () => {
  assert.equal(fingerprint("Free  Nitro\nfor all", []), fingerprint("free nitro for all", []));
  assert.equal(fingerprint("lol", []), "");
  assert.notEqual(fingerprint("", [{ size: 52_113 }]), "");
});

test("scaledUrl shrinks large images through the media proxy and leaves small ones", () => {
  const proxyURL = "https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2&hm=3";
  const url = new URL(scaledUrl({ proxyURL, width: 4096, height: 2048 }));
  assert.equal(url.searchParams.get("width"), "1024");
  assert.equal(url.searchParams.get("height"), "512");
  assert.equal(url.searchParams.get("hm"), "3");
  assert.equal(scaledUrl({ proxyURL, width: 800, height: 600 }), proxyURL);
});

test("the flag probability is spam plus scam", () => {
  const verdict = {
    label: "legitimate" as const,
    probabilities: { legitimate: 0.5, spam: 0.25, scam: 0.25 },
  };
  assert.equal(flagProbability(verdict), 0.5);
  assert.equal(
    flaggedLabel({ ...verdict, probabilities: { legitimate: 0, spam: 0.75, scam: 0.25 } }),
    "spam",
  );
});
