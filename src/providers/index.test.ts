import assert from "node:assert/strict";
import test from "node:test";
import { parseAssetId, parseDecimalAmount, parseParentAccount, toUnits, type Price } from "../domain.ts";
import { resolveRoster } from "../roster.ts";
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
    disclosure: { scheme: "inferpay-merkle-sha256-v1", root: "a4c9ebe62bca0698da105b2b7cadcd6097a276a236bce104186f01b81423a7dc", leaves: 2 },
    legal: { scheme: "inferpay-merkle-sha256-v1", root: "9af83af60095a9c6126fa6686e8602fdb84c43c2994cb8c77690809ea98fc4d5", leaves: 2 },
    insurance: { scheme: "inferpay-merkle-sha256-v1", root: "99404ff0e1372995542c5791014482b6fdea69eb01bac101ecde19c441404f95", leaves: 3 },
  });
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
