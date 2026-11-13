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

test("the root variable does nothing unless the other payment variables are set", () => {
  const result = loadConfig({ INFERPAY_ROOT_ACCOUNT: "team.near" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.payment.kind, "mock");
  assert.equal(result.value.roster.root, "team.near");
});

test("no keys select the mock rail and the default testnet root", () => {
  const result = loadConfig({});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.payment.kind, "mock");
  assert.equal(result.value.inference.kind, "stub");
  assert.equal(result.value.near.symbol, "NEAR");
  assert.equal(result.value.near.asset, "nep141:wrap.near");
  assert.equal(result.value.roster.root, "inferpay.testnet");
  assert.equal(result.value.roster.defaultBuyer.account, "researcher.kyle.inferpay.testnet");
  const insurance = parseProviderId("insurance");
  assert.ok(insurance);
  assert.equal(result.value.roster.shop(insurance)?.account, "insurance.ban.inferpay.testnet");
});

test("a live root derives every person and shop beneath it", () => {
  const result = loadConfig({ ...LIVE, INFERPAY_ROOT_ACCOUNT: "inferpay.near" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.payment.kind, "near-intents");
  assert.equal(result.value.roster.root, "inferpay.near");
  const kyle = result.value.roster.forest().filter((row) => row.personId === "kyle");
  assert.equal(kyle.length, 10);
  assert.deepEqual(kyle.map((row) => row.account), [
    "researcher.kyle.inferpay.near",
    "writer.kyle.inferpay.near",
    "trader.kyle.inferpay.near",
    "analyst.kyle.inferpay.near",
    "clerk.kyle.inferpay.near",
    "scout.kyle.inferpay.near",
    "editor.kyle.inferpay.near",
    "buyer.kyle.inferpay.near",
    "reviewer.kyle.inferpay.near",
    "assistant.kyle.inferpay.near",
  ]);
  assert.deepEqual(
    result.value.roster.forest().filter((row) => row.role === "specialist").map((row) => row.account),
    ["legal.stella.inferpay.near", "insurance.ban.inferpay.near", "disclosure.david.inferpay.near"],
  );
});

test("live payment refuses a missing, undotted, or testnet root", () => {
  const cases: readonly (readonly [NodeJS.ProcessEnv, RegExp])[] = [
    [LIVE, /mainnet root/],
    [{ ...LIVE, INFERPAY_ROOT_ACCOUNT: "alice" }, /contains a dot/],
    [{ ...LIVE, INFERPAY_ROOT_ACCOUNT: "inferpay.testnet" }, /mainnet only/],
  ];
  for (const [env, detail] of cases) {
    const result = loadConfig(env);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.kind, "invalid");
    if (result.error.kind !== "invalid") continue;
    assert.equal(result.error.variable, "INFERPAY_ROOT_ACCOUNT");
    assert.match(result.error.detail, detail);
  }
});

test("both NEAR AI models default to a model the live list serves", () => {
  const result = loadConfig({ NEAR_AI_API_KEY: "key" });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.inference.kind !== "near-ai") return;
  assert.equal(result.value.inference.consumerModel, "z-ai/glm-5.3-flash");
  assert.equal(result.value.inference.providerModel, "z-ai/glm-5.3-flash");
});

test("a root that is not a valid NEAR account id is refused", () => {
  for (const root of ["UPPER.near", "inferpay..near", "-inferpay.near", "inferpay.near."]) {
    const result = loadConfig({ INFERPAY_ROOT_ACCOUNT: root });
    assert.equal(result.ok, false, root);
    if (result.ok || result.error.kind !== "invalid") continue;
    assert.equal(result.error.variable, "INFERPAY_ROOT_ACCOUNT");
    assert.match(result.error.detail, /lowercase NEAR account/, root);
  }
});

test("a root whose longest derived account passes 64 characters is refused with its length", () => {
  const fits = `${"a".repeat(42)}.near`;
  assert.equal(fits.length, 47);
  assert.equal(loadConfig({ INFERPAY_ROOT_ACCOUNT: fits }).ok, true);

  const tooLong = `${"a".repeat(43)}.near`;
  assert.equal(tooLong.length, 48);
  const result = loadConfig({ INFERPAY_ROOT_ACCOUNT: tooLong });
  assert.equal(result.ok, false);
  if (result.ok || result.error.kind !== "invalid") return;
  assert.equal(result.error.variable, "INFERPAY_ROOT_ACCOUNT");
  assert.match(result.error.detail, /is 65 characters and a NEAR account allows at most 64\. Use a shorter root account\./);
});
