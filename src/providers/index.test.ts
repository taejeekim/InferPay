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
