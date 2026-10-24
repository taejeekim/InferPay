import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountId, parseAssetId, parseDecimalAmount, parseIdempotencyKey } from "../domain.ts";
import { decimalToAtomic, mapThrown, mapWireStatus, type WireStatus } from "./near-intents.ts";

test("0.02 NEAR is 2e22 yoctoNEAR", () => {
  assert.equal(decimalToAtomic("NEAR", "0.02"), "20000000000000000000000");
  assert.equal(decimalToAtomic("NEAR", "1"), "1000000000000000000000000");
  assert.equal(decimalToAtomic("NEAR", "0.0200000000000000000000001"), null);
  assert.equal(decimalToAtomic("USDC", "0.25"), null);
});

test("transfer statuses stay inside PaymentStatus", () => {
  const transfer = {
    key: must(parseIdempotencyKey("11111111-1111-1111-1111-111111111111")),
    amount: {
      asset: must(parseAssetId("nep141:wrap.near")),
      symbol: "NEAR",
      amount: must(parseDecimalAmount("0.02")),
    },
    recipient: must(parseAccountId("provider.near")),
  };
  const body = (status: string, failure_code: string | null = null): WireStatus => ({
    status,
    correlation_id: "corr-1",
    failure_code,
  });
  assert.equal(mapWireStatus(body("SUCCESS"), transfer).kind, "settled");
  assert.equal(mapWireStatus(body("PROCESSING"), transfer).kind, "pending");
  assert.equal(mapWireStatus(body("UNCERTAIN"), transfer).kind, "uncertain");
  assert.equal(mapWireStatus(body("FAILED", "insufficient_balance"), transfer).kind, "rejected");
  const rejected = mapThrown({ name: "AgentApiError", status: 400, code: "policy_denied", retryable: false });
  assert.equal(rejected.kind, "rejected");
  if (rejected.kind === "rejected") assert.equal(rejected.reason, "policy_denied");
  assert.equal(mapThrown({ name: "AgentApiError", status: 503, code: "unavailable", retryable: true }).kind, "uncertain");
  assert.equal(mapThrown({ name: "AgentApiRequestError" }).kind, "uncertain");
});

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture");
  return value;
}
