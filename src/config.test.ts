import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderId } from "./domain.ts";
import { loadConfig } from "./config.ts";

test("a partial payment environment is refused", () => {
  const result = loadConfig({ NEAR_INTENTS_AGENT_API_KEY: "naa_test" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "partial-payment-env");
});

test("no keys select the mock rail and the stub", () => {
  const result = loadConfig({});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.payment.kind, "mock");
  assert.equal(result.value.inference.kind, "stub");
  const providerId = parseProviderId("disclosure");
  assert.ok(providerId);
  const price = result.value.pricing.get(providerId);
  assert.equal(price?.price.amount, "0.25");
  assert.equal(price?.payTo, "disclosure.mock");
});
