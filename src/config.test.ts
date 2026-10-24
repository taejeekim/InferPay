import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderId } from "./domain.ts";
import { loadConfig } from "./config.ts";

const LIVE = {
  NEAR_INTENTS_AGENT_API_KEY: "naa_test",
  INFERPAY_AGENT_ID: "agent",
  INFERPAY_GRANT_TOKEN: "grant",
};

test("a partial payment environment is refused", () => {
  const result = loadConfig({ NEAR_INTENTS_AGENT_API_KEY: "naa_test" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "partial-payment-env");
});

test("the parent variable does nothing unless the other payment variables are set", () => {
  const result = loadConfig({ INFERPAY_PARENT_ACCOUNT: "kylebot.near" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "partial-payment-env");
});

test("no keys select the mock rail and Kyle's default parent", () => {
  const result = loadConfig({});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.payment.kind, "mock");
  assert.equal(result.value.inference.kind, "stub");
  assert.equal(result.value.near.symbol, "NEAR");
  assert.equal(result.value.near.asset, "nep141:wrap.near");
  assert.equal(result.value.roster.kyleParent, "kyle.near");
  assert.equal(result.value.roster.defaultBuyer.account, "researcher.kyle.near");
  const insurance = parseProviderId("insurance");
  assert.ok(insurance);
  assert.equal(result.value.roster.shop(insurance)?.account, "insurance.ban.near");
});

test("a live parent rewrites only Kyle", () => {
  const result = loadConfig({ ...LIVE, INFERPAY_PARENT_ACCOUNT: "kylebot.near" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.payment.kind, "near-intents");
  assert.equal(result.value.roster.kyleParent, "kylebot.near");
  const kyle = result.value.roster.forest().filter((row) => row.personId === "kyle");
  assert.equal(kyle.length, 10);
  assert.deepEqual(kyle.map((row) => row.account), [
    "researcher.kylebot.near",
    "writer.kylebot.near",
    "trader.kylebot.near",
    "analyst.kylebot.near",
    "clerk.kylebot.near",
    "scout.kylebot.near",
    "editor.kylebot.near",
    "buyer.kylebot.near",
    "reviewer.kylebot.near",
    "assistant.kylebot.near",
  ]);
  assert.deepEqual(
    result.value.roster.forest().filter((row) => row.role === "specialist").map((row) => row.account),
    ["legal.stella.near", "insurance.ban.near", "disclosure.david.near"],
  );
});

test("a parent without a dot is refused on the live rail", () => {
  const result = loadConfig({ ...LIVE, INFERPAY_PARENT_ACCOUNT: "alice" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "invalid");
  if (result.error.kind !== "invalid") return;
  assert.equal(result.error.variable, "INFERPAY_PARENT_ACCOUNT");
});

test("a live parent that matches a specialist parent is refused", () => {
  const result = loadConfig({ ...LIVE, INFERPAY_PARENT_ACCOUNT: "stella.near" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "invalid");
  if (result.error.kind !== "invalid") return;
  assert.equal(result.error.variable, "INFERPAY_PARENT_ACCOUNT");
});
