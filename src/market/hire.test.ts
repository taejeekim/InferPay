import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  newJobId,
  parseAccountId,
  parseAssetId,
  parseParentAccount,
  parseDecimalAmount,
  parseIsoTime,
  parseModelId,
  parseProviderId,
  parseStars,
  type Price,
} from "../domain.ts";
import { parseCommitment, SCHEME, type Commitment } from "../commitment/index.ts";
import type { Inference } from "../inference/index.ts";
import { createMockRail } from "../payment/mock.ts";
import type { Answer, Provider } from "../providers/types.ts";
import { createMarketplace, type Marketplace } from "./index.ts";
import { createFileLedger } from "./ledger.ts";

function fixedClock() {
  const now = parseIsoTime("2026-10-24T14:02:11.000Z");
  if (!now) throw new Error("clock");
  return now;
}

test("hire pays once, then a second hire skips the transfer", async () => {
  const { market, order, root } = await harness("none");
  try {
    const first = await market.hire(order);
    assert.equal(first.kind, "completed");
    if (first.kind !== "completed") return;
    assert.equal(first.transfer, "called");
    const view = await market.job(order.jobId);
    assert.deepEqual(view?.events.map((event) => event.type), [
      "opened",
      "payment-intended",
      "payment-settled",
      "fulfilled",
    ]);
    const again = await market.hire(order);
    assert.equal(again.kind, "completed");
    if (again.kind !== "completed") return;
    assert.equal(again.transfer, "skipped");
    assert.equal(again.job.paid.key, first.job.paid.key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an uncertain transfer settles on resume with the same key", async () => {
  const { market, order, root } = await harness("uncertain-once");
  try {
    const waiting = await market.hire(order);
    assert.equal(waiting.kind, "waiting");
    if (waiting.kind !== "waiting") return;
    assert.equal(waiting.why, "payment-uncertain");
    const mid = await market.job(order.jobId);
    const intended = mid?.events.find((event) => event.type === "payment-intended");
    assert.equal(intended?.type, "payment-intended");
    const resumed = await market.hire(order);
    assert.equal(resumed.kind, "completed");
    if (resumed.kind !== "completed" || intended?.type !== "payment-intended") return;
    assert.equal(resumed.transfer, "called");
    assert.equal(resumed.job.paid.key, intended.key);
    assert.equal(resumed.job.paid.correlationId, waiting.correlationId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an offer above the budget writes no job file", async () => {
  const { market, order, root } = await harness("none");
  try {
    const tight = { ...order, budget: price("0.01") };
    const outcome = await market.hire(tight);
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    assert.equal(outcome.reason.kind, "over-budget");
    const names = await readdir(join(root, "jobs")).catch(() => []);
    assert.deepEqual(names, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an order pinned to no commitment is refused and writes no job file", async () => {
  const { market, order, root } = await harness("none");
  try {
    const account = must(parseAccountId("disclosure.david.inferpay.near"));
    const outcome = await market.hire({ ...order, commitment: { status: "missing", contract: account, account } });
    assert.deepEqual(outcome, { kind: "failed", jobId: order.jobId, reason: { kind: "no-commitment", providerId: order.providerId } });
    assert.deepEqual(await readdir(join(root, "jobs")).catch(() => []), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a counter-offer at the shop's floor is accepted, and the job pays the agreed price", async () => {
  const { market, order, root } = await harness("none");
  try {
    const offer = price("0.015");
    assert.equal(await market.counter(order.providerId, offer), "accepted");
    const done = await market.hire({ ...order, offer });
    assert.equal(done.kind, "completed");
    if (done.kind !== "completed") return;
    assert.equal(done.job.paid.amount.amount, "0.015");
    const view = await market.job(order.jobId);
    const opened = view?.events[0];
    assert.equal(opened?.type, "opened");
    if (opened?.type !== "opened") return;
    assert.equal(opened.quote.amount, "0.015");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an offer below the shop's floor is refused and writes no job file", async () => {
  const { market, order, root } = await harness("none");
  try {
    const offer = price("0.0149");
    assert.equal(await market.counter(order.providerId, offer), "refused");
    const outcome = await market.hire({ ...order, offer });
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    assert.equal(outcome.reason.kind, "offer-refused");
    const names = await readdir(join(root, "jobs")).catch(() => []);
    assert.deepEqual(names, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an offer above the list price pays the list price", async () => {
  const { market, order, root } = await harness("none");
  try {
    const done = await market.hire({ ...order, offer: price("0.05") });
    assert.equal(done.kind, "completed");
    if (done.kind !== "completed") return;
    assert.equal(done.job.paid.amount.amount, "0.02");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second hire with a different offer conflicts", async () => {
  const { market, order, root } = await harness("none");
  try {
    const done = await market.hire(order);
    assert.equal(done.kind, "completed");
    const again = await market.hire({ ...order, offer: price("0.015") });
    assert.equal(again.kind, "failed");
    if (again.kind !== "failed") return;
    assert.equal(again.reason.kind, "order-conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same stars stay recorded and different stars are rejected", async () => {
  const { market, order, root } = await harness("none");
  try {
    const done = await market.hire(order);
    assert.equal(done.kind, "completed");
    if (done.kind !== "completed") return;
    const stars = parseStars(4);
    const other = parseStars(5);
    assert.ok(stars && other);
    const counts = { verified: 1, unproven: 0, forged: 0, withheld: 0 };
    assert.deepEqual(await market.rate(done.job, { stars, ...counts }), { kind: "recorded", onChain: null });
    assert.deepEqual((await market.listings())[0]?.reputation, { kind: "rated", completedJobs: 1, ratings: 1, average: 4 });
    assert.deepEqual(await market.rate(done.job, { stars, ...counts }), { kind: "unchanged", onChain: null });
    const rejected = await market.rate(done.job, { stars: other, ...counts });
    assert.equal(rejected.kind, "rejected");
    if (rejected.kind !== "rejected") return;
    assert.equal(rejected.reason, "different-stars");
    const view = await market.job(order.jobId);
    assert.equal(view?.events.filter((event) => event.type === "rated").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second hire waits while the first still holds the job", async () => {
  let release = (): void => {};
  let entered = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { market, order, root } = await harness("none", async () => {
    entered();
    await gate;
    return { ok: true, answer: sampleAnswer() };
  });
  try {
    const first = market.hire(order);
    await started;
    const second = await market.hire(order);
    assert.equal(second.kind, "failed");
    if (second.kind === "failed") assert.equal(second.reason.kind, "job-busy");
    release();
    const done = await first;
    assert.equal(done.kind, "completed");
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("an answer the ledger could not read back is refused, and the job stays readable", async () => {
  const claim = { label: "revenue", company: "Samsung Electronics", period: "Q3 2025", metric: "revenue", claimed: Number.NaN, unit: "KRW T" };
  const malformed: Answer = { ...sampleAnswer(), checks: [{ kind: "number", claim, verdict: "unverifiable", evidence: null }] };
  const { market, order, root } = await harness("none", async () => ({ ok: true, answer: malformed }));
  try {
    const outcome = await market.hire(order);
    assert.deepEqual(outcome, { kind: "failed", jobId: order.jobId, reason: { kind: "provider-failed", reason: "the shop's answer was malformed" } });
    const view = await market.job(order.jobId);
    assert.deepEqual(view?.events.map((event) => event.type), ["opened", "payment-intended", "payment-settled", "fulfil-failed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second hire that pins a different root conflicts", async () => {
  const { market, order, root } = await harness("none");
  try {
    const done = await market.hire(order);
    assert.equal(done.kind, "completed");
    const other = must(parseCommitment({ scheme: SCHEME, root: "cd".repeat(32), leaves: 1 }));
    const again = await market.hire({ ...order, commitment: { ...order.commitment, commitment: other } });
    assert.equal(again.kind, "failed");
    if (again.kind !== "failed") return;
    assert.equal(again.reason.kind, "order-conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second hire with a different payer conflicts", async () => {
  const { market, order, root } = await harness("none");
  try {
    const done = await market.hire(order);
    assert.equal(done.kind, "completed");
    const again = await market.hire({ ...order, payFrom: must(parseAccountId("clerk.kyle.inferpay.near")) });
    assert.equal(again.kind, "failed");
    if (again.kind !== "failed") return;
    assert.equal(again.reason.kind, "order-conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a trailing partial line does not block resume", async () => {
  const { market, order, root } = await harness("none");
  try {
    const done = await market.hire(order);
    assert.equal(done.kind, "completed");
    await appendFile(join(root, "jobs", `${order.jobId}.jsonl`), "{\"type\":\"rated\"");
    const again = await market.hire(order);
    assert.equal(again.kind, "completed");
    if (again.kind !== "completed") return;
    assert.equal(again.transfer, "skipped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function harness(
  chaos: "none" | "uncertain-once",
  fulfil?: Provider["fulfil"],
): Promise<{ market: Marketplace; order: ReturnType<typeof sampleOrder>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  const provider = sampleProvider(fulfil);
  const inference: Inference = {
    kind: "stub",
    attested: () => [],
    async run() {
      return { ok: false, reason: "no-fixture", detail: "unused" };
    },
  };
  const market = createMarketplace({
    ledger: createFileLedger(root),
    rail: createMockRail({ root, chaos }),
    inference,
    providers: [{
      provider,
      listing: {
        ...provider.describe,
        price: price("0.02"),
        owner: must(parseParentAccount("david.inferpay.near")),
        payTo: must(parseAccountId("disclosure.david.inferpay.near")),
        declared: provider.commitment(),
        catalog: provider.catalog(),
      },
      floor: price("0.015"),
    }],
    registry: null,
    clock: fixedClock,
  });
  return { market, order: sampleOrder(), root };
}

function sampleProvider(fulfil?: Provider["fulfil"]): Provider {
  return {
    quoteNear: must(parseDecimalAmount("0.02")),
    floorNear: must(parseDecimalAmount("0.015")),
    describe: {
      id: must(parseProviderId("disclosure")),
      name: "Disclosure analyst",
      specialty: "Disclosure analysis, number cross-check",
      routingHint: "filings",
    },
    commitment: sampleCommitment,
    catalog: () => [],
    fulfil: fulfil ?? (async () => ({ ok: true, answer: sampleAnswer() })),
  };
}

function sampleOrder() {
  return {
    jobId: newJobId(1_700_000_000_000),
    providerId: must(parseProviderId("disclosure")),
    question: "Does the filing match?",
    needs: [],
    offer: price("0.02"),
    budget: price("0.10"),
    payFrom: must(parseAccountId("researcher.kyle.inferpay.near")),
    commitment: { status: "published" as const, commitment: sampleCommitment(), source: { kind: "listing" as const } },
  };
}

function sampleCommitment(): Commitment {
  return must(parseCommitment({ scheme: SCHEME, root: "ab".repeat(32), leaves: 1 }));
}

function sampleAnswer(): Answer {
  return {
    text: "Operating profit matches.",
    checks: [],
    model: must(parseModelId("stub")),
    inference: "stub",
    attestation: [],
  };
}

function price(amount: string): Price {
  return {
    asset: must(parseAssetId("nep141:wrap.near")),
    symbol: "NEAR",
    amount: must(parseDecimalAmount(amount)),
  };
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture");
  return value;
}
