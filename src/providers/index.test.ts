import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newJobId, parseAssetId, parseDecimalAmount, parseParentAccount, toUnits, type Price } from "../domain.ts";
import { resolveRoster } from "../roster.ts";
import type { Need } from "../commitment/index.ts";
import { verifyChecks } from "../consumer/verify.ts";
import { loadConfig } from "../config.ts";
import { createRuntime } from "../runtime.ts";
import { bindProviders, priceFor, PROVIDERS } from "./index.ts";

test("every shop's floor is above zero and at or below its list price", () => {
  for (const provider of PROVIDERS) {
    assert.ok(toUnits(provider.floorNear) > 0n, provider.describe.id);
    assert.ok(toUnits(provider.floorNear) <= toUnits(provider.quoteNear), provider.describe.id);
  }
});

test("a shop refuses below its floor, takes an offer up to its list price, and never charges more", () => {
  const insurance = boundShops().find((bound) => bound.listing.id === "insurance");
  assert.ok(insurance);
  const cases: readonly (readonly [string, string | null])[] = [
    ["0.0119", null],
    ["0.012", "0.012"],
    ["0.015", "0.015"],
    ["0.02", "0.02"],
    ["0.5", "0.02"],
  ];
  for (const [offer, charged] of cases) {
    assert.equal(priceFor(insurance, near(offer))?.amount ?? null, charged, offer);
  }
  const otherAsset = { ...near("0.02"), asset: must(parseAssetId("nep141:other.near")) };
  assert.equal(priceFor(insurance, otherAsset), null);
});

// These are the roots published on testnet. A salt or an entry that changed would no longer open to them, and
// every buyer would call the shop's evidence forged until the shop published again.
test("each shop's dataset and stored salts seal to the root it published", () => {
  const roots = Object.fromEntries(PROVIDERS.map((provider) => [provider.describe.id, provider.commitment()]));
  assert.deepEqual(roots, {
    disclosure: { scheme: "inferpay-keyed-merkle-sha256-v1", root: "4bc59b533ac3b45997fa8cb2af6bac1052a8fa9c88247405fbc8c1087cd2a40a", leaves: 2 },
    legal: { scheme: "inferpay-keyed-merkle-sha256-v1", root: "4a19e743ea7432156c47bfb0a33558b1e1988e1710d6e7e9e05761299c35d9b5", leaves: 2 },
    insurance: { scheme: "inferpay-keyed-merkle-sha256-v1", root: "d26d1609271e8c546648dc3d83990ff7540d60bf40cdf738d693ec655602b68f", leaves: 3 },
  });
});

test("a shop's code opens every needed key its model did not mention, so the buyer finds none withheld", async () => {
  const cases: readonly (readonly [string, string, readonly Need[]])[] = [
    ["insurance", "Does this policy cover an outpatient MRI?", [{ kind: "fact", topic: "outpatient-mri" }, { kind: "fact", topic: "mri-copay" }]],
    ["disclosure", "What was Samsung's Q3 2025 revenue?", [{ kind: "figure", company: "Samsung Electronics", period: "Q3 2025", metric: "operating profit" }]],
    ["legal", "Does this NDA's unlimited indemnification clause fail our playbook?", [{ kind: "rule", id: "perpetual-nda", clause: "unlimited indemnification clause" }]],
  ];
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    const config = loadConfig({ INFERPAY_DATA_DIR: root });
    assert.ok(config.ok);
    const { market } = await createRuntime(config.value);
    for (const [id, question, needs] of cases) {
      const listing = (await market.listings()).find((item) => item.id === id);
      assert.ok(listing, id);
      const outcome = await market.hire({
        jobId: newJobId(),
        providerId: listing.id,
        question,
        needs,
        offer: listing.price,
        budget: listing.price,
        payFrom: config.value.roster.defaultBuyer.account,
        commitment: listing.commitment,
      });
      assert.ok(outcome.kind === "settled", id);
      const checks = verifyChecks(outcome.job.answer.checks, outcome.job.commitment, question, needs);
      assert.deepEqual(checks.filter((check) => check.status === "withheld" || check.status === "forged"), [], id);
      assert.ok(checks.some((check) => check.status === "verified"), id);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function boundShops() {
  const roster = resolveRoster(must(parseParentAccount("inferpay.testnet")));
  assert.ok(roster.ok);
  const bound = bindProviders(PROVIDERS, roster.roster, { asset: must(parseAssetId("nep141:wrap.near")), symbol: "NEAR" });
  assert.ok(bound.ok);
  return bound.providers;
}

function near(amount: string): Price {
  return { asset: must(parseAssetId("nep141:wrap.near")), symbol: "NEAR", amount: must(parseDecimalAmount(amount)) };
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture");
  return value;
}
