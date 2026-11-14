import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generate, normalise } from "./walkthrough.ts";

const read = (name: string): Promise<string> => readFile(new URL(`../../${name}`, import.meta.url), "utf8");

test("WALKTHROUGH.md is what the CLI prints today", async () => {
  assert.equal(normalise(await read("WALKTHROUGH.md")), normalise(await generate()), "run node src/docs/walkthrough.ts --write");
});

test("every text excerpt in the README appears in WALKTHROUGH.md", async () => {
  const walkthrough = normalise(await read("WALKTHROUGH.md"));
  const excerpts = [...(await read("README.md")).matchAll(/```text\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
  assert.ok(excerpts.length >= 4, "the README lost its excerpts");
  for (const excerpt of excerpts) {
    assert.ok(walkthrough.includes(normalise(excerpt)), `the README shows output the CLI no longer prints:\n${excerpt.slice(0, 300)}`);
  }
});
