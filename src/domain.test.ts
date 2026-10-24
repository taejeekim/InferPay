import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSameAsset,
  newJobId,
  parseAssetId,
  parseDecimalAmount,
  secret,
} from "./domain.ts";

test("a secret serializes as redacted and still reveals to its caller", () => {
  const box = secret("naa_live_key");
  assert.equal(JSON.stringify({ key: box }), '{"key":"[redacted]"}');
  assert.equal(String(box), "[redacted]");
  assert.equal(box.reveal(), "naa_live_key");
});

test("prices in one asset compare as decimals", () => {
  const asset = parseAssetId("usdc");
  const low = parseDecimalAmount("0.10");
  const same = parseDecimalAmount("0.100");
  const high = parseDecimalAmount("0.25");
  assert.ok(asset && low && same && high);
  const cheap = { asset, symbol: "USDC", amount: low };
  const equal = { asset, symbol: "USDC", amount: same };
  const dear = { asset, symbol: "USDC", amount: high };
  assert.equal(compareSameAsset(cheap, dear), -1);
  assert.equal(compareSameAsset(dear, cheap), 1);
  assert.equal(compareSameAsset(cheap, equal), 0);
});

test("prices in different assets are not ordered", () => {
  const usdc = parseAssetId("usdc");
  const near = parseAssetId("near");
  const amount = parseDecimalAmount("1");
  assert.ok(usdc && near && amount);
  assert.equal(
    compareSameAsset(
      { asset: usdc, symbol: "USDC", amount },
      { asset: near, symbol: "NEAR", amount },
    ),
    "different-asset",
  );
});

test("a new job id sorts by time and rejects a blank amount", () => {
  const earlier = newJobId(1_700_000_000_000);
  const later = newJobId(1_700_000_000_001);
  assert.ok(earlier < later);
  assert.equal(parseDecimalAmount("0.25"), "0.25");
  assert.equal(parseDecimalAmount("1e2"), null);
  assert.equal(parseDecimalAmount("-1"), null);
});
