import assert from "node:assert/strict";
import test from "node:test";
import { runDemo } from "./demo.ts";

test("demo refuses to start when a payment variable is set", async () => {
  let err = "";
  const code = await runDemo({ NEAR_INTENTS_AGENT_API_KEY: "present" }, { write() {} }, { write(chunk) { err += chunk; } });
  assert.equal(code, 2);
  assert.match(err, /does not spend/);
  assert.doesNotMatch(err, /present/);
});

test("demo shows the mismatch, one settlement after a crash, and a declined cheap budget", async () => {
  let out = "";
  let err = "";
  const code = await runDemo(
    { PATH: process.env.PATH ?? "" },
    { write(chunk) { out += chunk; } },
    { write(chunk) { err += chunk; } },
  );
  assert.equal(err, "", err);
  assert.equal(code, 0);
  assert.match(out, /payment=mock inference=stub/);
  assert.match(out, /mismatch\s+revenue Q3 2025\s+79\.0T KRW\s+ref 79\.1T KRW \(-0\.13%\)/);
  assert.match(out, /4\/5 \(1 of 2 figures needed correction\)/);
  assert.match(out, /transfer skipped/);
  assert.match(out, /uncertain/);
  assert.match(out, /declined\. Cheapest fitting provider costs 0\.25 USDC, budget is 0\.10 USDC\./);
  assert.match(out, /4\.5 \(2\)/);
  assert.match(out, /judge\s+revenue Q3 2025 is a mismatch/);
  assert.match(out, /rails stayed payment=mock inference=stub/);
  const settled = out.match(/key (\S+?), correlation \S+?\) transfer called/g) ?? [];
  const skipped = out.match(/key (\S+?), correlation \S+?\) transfer skipped/g) ?? [];
  assert.equal(settled.length >= 2, true);
  assert.equal(skipped.length >= 2, true);
});
