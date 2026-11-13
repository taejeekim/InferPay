import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSameAsset,
  newJobId,
  parseAccountId,
  parseAssetId,
  parseDecimalAmount,
  parseParentAccount,
  secret,
} from "./domain.ts";

test("a secret serializes as redacted and still reveals to its caller", () => {
  const box = secret("naa_live_key");
  assert.equal(JSON.stringify({ key: box }), '{"key":"[redacted]"}');
  assert.equal(String(box), "[redacted]");
  assert.equal(box.reveal(), "naa_live_key");
});

test("prices in one asset compare as decimals", () => {
  const asset = parseAssetId("nep141:wrap.near");
  const low = parseDecimalAmount("0.02");
  const same = parseDecimalAmount("0.020");
  const high = parseDecimalAmount("0.03");
  assert.ok(asset && low && same && high);
  const cheap = { asset, symbol: "NEAR", amount: low };
  const equal = { asset, symbol: "NEAR", amount: same };
  const dear = { asset, symbol: "NEAR", amount: high };
  assert.equal(compareSameAsset(cheap, dear), -1);
  assert.equal(compareSameAsset(dear, cheap), 1);
  assert.equal(compareSameAsset(cheap, equal), 0);
});

test("prices in different assets are not ordered", () => {
  const wrap = parseAssetId("nep141:wrap.near");
  const other = parseAssetId("nep141:other.near");
  const amount = parseDecimalAmount("1");
  assert.ok(wrap && other && amount);
  assert.equal(
    compareSameAsset(
      { asset: wrap, symbol: "NEAR", amount },
      { asset: other, symbol: "NEAR", amount },
    ),
    "different-asset",
  );
});

test("a parent account contains a dot", () => {
  assert.equal(parseParentAccount("alice.near"), "alice.near");
  assert.equal(parseParentAccount("alice"), null);
});

test("a new job id sorts by time and rejects a blank amount", () => {
  const earlier = newJobId(1_700_000_000_000);
  const later = newJobId(1_700_000_000_001);
  assert.ok(earlier < later);
  assert.equal(parseDecimalAmount("0.02"), "0.02");
  assert.equal(parseDecimalAmount("1e2"), null);
  assert.equal(parseDecimalAmount("-1"), null);
});

test("account ids follow the NEAR rule of 2 to 64 lowercase characters", () => {
  for (const ok of ["ab", "a.near", "researcher.kyle.inferpay.near", "a-b_c.near", "a".repeat(64)]) {
    assert.notEqual(parseAccountId(ok), null, ok);
  }
  for (const bad of ["a", "UPPER.near", "a..near", ".a.near", "a.near.", "a-.near", "a b.near", "a".repeat(65)]) {
    assert.equal(parseAccountId(bad), null, bad);
  }
});
