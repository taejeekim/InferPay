import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.ts";
import { parseDecimalAmount, parseModelId } from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import { createRuntime } from "../runtime.ts";
import { decide } from "./decide.ts";

test("a routing decision survives a code fence and surrounding prose", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    const config = loadConfig({ INFERPAY_DATA_DIR: root });
    assert.ok(config.ok);
    const { market } = await createRuntime(config.value);
    const listings = await market.listings();
    const first = listings[0];
    assert.ok(first);
    const amount = parseDecimalAmount("0.10");
    assert.ok(amount);
    const raw = [
      "Here is my routing choice.",
      "```json",
      `{"kind":"outsource","providerId":"${first.id}","reason":"holds the private data"}`,
      "```",
    ].join("\n");
    const model = parseModelId("fake");
    assert.ok(model);
    const inference: Inference = {
      kind: "near-ai",
      async run(task) {
        const value = task.parseOutput(raw, []);
        if (value === null) return { ok: false, reason: "unparseable-output", detail: "rejected" };
        return { ok: true, value, model };
      },
    };
    const routed = await decide(inference, "anything", listings, { ...first.price, amount });
    assert.ok(routed.ok);
    assert.deepEqual(routed.decision, { kind: "outsource", providerId: first.id, reason: "holds the private data" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
