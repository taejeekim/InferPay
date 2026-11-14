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
import type { PaymentReceipt } from "../payment/index.ts";
import { createMarketplace, type Marketplace, type SettledJob } from "./index.ts";
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
    assert.equal(first.kind, "settled");
    if (first.kind !== "settled") return;
    assert.equal(first.transfer, "called");
    const view = await market.job(order.jobId);
    assert.deepEqual(view?.events.map((event) => event.type), [
      "opened",
      "delivered",
      "payout-decided",
      "payment-intended",
      "payment-settled",
    ]);
    const again = await market.hire(order);
    assert.equal(again.kind, "settled");
    if (again.kind !== "settled") return;
    assert.equal(again.transfer, "skipped");
    assert.equal(paidOf(again.job).key, paidOf(first.job).key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crash after the delivery is written resumes to payment without asking the shop again", async () => {
  let asked = 0;
  const { market, deps, order, root } = await harness("none", async () => {
    asked += 1;
    return { ok: true, answer: sampleAnswer() };
  });
  try {
    const crashing = createMarketplace({ ...deps, afterDelivery: () => { throw new Error("crash"); } });
    await assert.rejects(crashing.hire(order), /crash/);
    assert.deepEqual((await market.job(order.jobId))?.events.map((event) => event.type), ["opened", "delivered"]);
    const resumed = await market.hire(order);
    assert.equal(resumed.kind, "settled");
    assert.equal(asked, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a forged delivery settles unpaid: no transfer is attempted, and a resume reports it and pays nothing", async () => {
  const { market, order, root } = await harness("none", undefined, (opened) => ({ amount: { ...opened.quote, amount: must(parseDecimalAmount("0")) }, basis: { kind: "forged", forged: 1 } }));
  try {
    const progress: string[] = [];
    const first = await market.hire(order, (step) => progress.push(step.step));
    assert.ok(first.kind === "settled");
    assert.deepEqual([first.transfer, first.job.settlement], ["none", { kind: "unpaid" }]);
    assert.deepEqual(progress, ["opened", "answer", "payout"]);
    assert.deepEqual((await readdir(root)).filter((name) => name !== "jobs"), [], "the rail was never called");
    const again = await market.hire(order);
    assert.ok(again.kind === "settled");
    assert.deepEqual([again.transfer, again.job.settlement], ["none", { kind: "unpaid" }]);
    assert.deepEqual((await market.job(order.jobId))?.events.map((event) => event.type), ["opened", "delivered", "payout-decided"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial payout transfers only its share of the agreed price", async () => {
  const { market, order, root } = await harness("none", undefined, (opened) => ({ amount: { ...opened.quote, amount: must(parseDecimalAmount("0.01")) }, basis: { kind: "share", proven: 1, needed: 2 } }));
  try {
    const done = await market.hire(order);
    assert.ok(done.kind === "settled");
    assert.equal(done.job.quote.amount, "0.02");
    assert.equal(paidOf(done.job).amount.amount, "0.01");
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
    assert.equal(resumed.kind, "settled");
    if (resumed.kind !== "settled" || intended?.type !== "payment-intended") return;
    assert.equal(resumed.transfer, "called");
    assert.equal(paidOf(resumed.job).key, intended.key);
    assert.equal(paidOf(resumed.job).correlationId, waiting.correlationId);
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
    assert.equal(done.kind, "settled");
    if (done.kind !== "settled") return;
    assert.equal(paidOf(done.job).amount.amount, "0.015");
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
    assert.equal(done.kind, "settled");
    if (done.kind !== "settled") return;
    assert.equal(paidOf(done.job).amount.amount, "0.02");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second hire with a different offer conflicts", async () => {
  const { market, order, root } = await harness("none");
  try {
    const done = await market.hire(order);
    assert.equal(done.kind, "settled");
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
    assert.equal(done.kind, "settled");
    if (done.kind !== "settled") return;
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
    assert.equal(done.kind, "settled");
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
    assert.deepEqual(view?.events.map((event) => event.type), ["opened", "fulfil-failed"]);
    assert.deepEqual((await readdir(root)).filter((name) => name !== "jobs"), [], "nothing was paid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second hire that pins a different root conflicts", async () => {
  const { market, order, root } = await harness("none");
  try {
    const done = await market.hire(order);
    assert.equal(done.kind, "settled");
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
    assert.equal(done.kind, "settled");
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
    assert.equal(done.kind, "settled");
    await appendFile(join(root, "jobs", `${order.jobId}.jsonl`), "{\"type\":\"rated\"");
    const again = await market.hire(order);
    assert.equal(again.kind, "settled");
    if (again.kind !== "settled") return;
    assert.equal(again.transfer, "skipped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function harness(
  chaos: "none" | "uncertain-once",
  fulfil?: Provider["fulfil"],
  payout?: Parameters<typeof createMarketplace>[0]["payout"],
): Promise<{ market: Marketplace; deps: Parameters<typeof createMarketplace>[0]; order: ReturnType<typeof sampleOrder>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  const provider = sampleProvider(fulfil);
  const inference: Inference = {
    kind: "stub",
    attested: () => [],
    async run() {
      return { ok: false, reason: "no-fixture", detail: "unused" };
    },
  };
  const deps: Parameters<typeof createMarketplace>[0] = {
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
    payout: payout ?? ((opened) => ({ amount: opened.quote, basis: { kind: "share", proven: 1, needed: 1 } })),
  };
  return { market: createMarketplace(deps), deps, order: sampleOrder(), root };
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
    needs: [{ kind: "fact" as const, topic: "operating-profit" }],
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

function paidOf(job: SettledJob): PaymentReceipt {
  assert.equal(job.settlement.kind, "paid");
  if (job.settlement.kind !== "paid") throw new Error("expected a paid job");
  return job.settlement.receipt;
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture");
  return value;
}
