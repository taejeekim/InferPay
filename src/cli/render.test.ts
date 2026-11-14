import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountId, parseAssetId, parseCorrelationId, parseDecimalAmount, parseIdempotencyKey, parseJobId, parseParentAccount, parseModelId, parseProviderId, type Price } from "../domain.ts";
import { sealDataset, type AssertedCheck, type Entry, type Figure, type Need, type PinnedCommitment } from "../commitment/index.ts";
import { grade } from "../consumer/grade.ts";
import { parseHash } from "../commitment/merkle.ts";
import { decide, percentOf } from "../consumer/decide.ts";
import { verifyChecks } from "../consumer/verify.ts";
import type { CallAttestation } from "../inference/attest.ts";
import { resolveRoster } from "../roster.ts";
import { attestLines, progressLine, railsLine, walletsTable } from "./render.ts";

const NO_NEEDS = { byShop: new Map(), dropped: [] };

test("when the shop is no better than the buyer, the decide block shows a reservation at or below zero", () => {
  const insurance = must(parseProviderId("insurance"));
  const plan = decide({
    value: near("0.10"),
    assessment: {
      answer: "Covered.",
      confidence: must(percentOf(0.9)),
      missing: ["the policy schedule", "the copay table"],
      coverage: new Map([[insurance, must(percentOf(1))]]),
    },
    listings: [{ id: insurance, price: near("0.02"), reputation: { kind: "unrated", completedJobs: 0 } }],
  });
  assert.ok(plan.kind !== "counter");
  assert.equal(
    progressLine({ step: "decide", decision: plan, needs: { byShop: new Map([[insurance, [{ kind: "fact", topic: "mri-copay" }]]]), dropped: [] } }, "mock"),
    [
      "decide    answer locally, pay nothing",
      "          value   0.10 NEAR, the budget: the most a right answer is worth",
      "          local   confidence 0.90 x value = worth 0.090 NEAR",
      "          missing the policy schedule; the copay table",
      "          needs   insurance  mri-copay",
      "          option  insurance  ask 0.02  cover 1.00 x rep 0.70 = quality 0.70  net +0.050",
      "          rule    net = quality x value - ask; buy when net >= local worth: 0.050 < 0.090",
      "          rule    counter only when the reservation is above zero: (0.70 - 0.90) x 0.10 = -0.020 NEAR",
      "          rule    answer locally when confidence >= 0.50: 0.90 >= 0.50",
    ].join("\n"),
  );
});

test("an amount finer than a thousandth prints up to six decimals", () => {
  const insurance = must(parseProviderId("insurance"));
  const plan = decide({
    value: near("0.0433"),
    assessment: {
      answer: "Covered.",
      confidence: must(percentOf(0.2)),
      missing: [],
      coverage: new Map([[insurance, must(percentOf(1))]]),
    },
    listings: [{ id: insurance, price: near("0.02"), reputation: { kind: "unrated", completedJobs: 0 } }],
  });
  assert.ok(plan.kind !== "counter");
  const block = progressLine({ step: "decide", decision: plan, needs: NO_NEEDS }, "mock");
  assert.match(block, /^ {10}local {3}confidence 0\.20 x value = worth 0\.00866 NEAR$/m);
  assert.match(block, /^ {10}missing nothing$/m);
  assert.match(block, /net \+0\.01031$/m);
});

const HASH = "CYvHqXWvDNtEaQnfuoNyMP7LBUkAZLxwbyunhT2Qs5Mp";

function pay(correlation: string | null) {
  return {
    step: "pay" as const,
    transfer: "called" as const,
    status: "settled" as const,
    feeYocto: "44600000000000000000",
    amount: { asset: must(parseAssetId("nep141:wrap.near")), symbol: "NEAR", amount: must(parseDecimalAmount("0.02")) },
    payer: must(parseAccountId("clerk.kyle.inferpay.testnet")),
    recipient: must(parseAccountId("insurance.ban.inferpay.testnet")),
    correlationId: correlation === null ? null : must(parseCorrelationId(correlation)),
    key: must(parseIdempotencyKey("nt_key")),
    jobId: must(parseJobId("job_01M7BGGX58BF3B8VB4ADYKXYZA")),
  };
}

test("a testnet payment names the rail and links the transaction", () => {
  assert.equal(railsLine({ payment: "near-testnet", inference: "stub" }), "rails: payment=near-testnet inference=stub");
  const block = progressLine(pay(HASH), "near-testnet");
  assert.match(block, /via +NEAR testnet transfer/);
  assert.match(block, new RegExp(`tx +https://testnet\\.nearblocks\\.io/txns/${HASH}`));
  assert.match(block, /^ {10}fee {5}0\.0000446 NEAR gas on top of the price, from the transaction outcome$/m);
  assert.doesNotMatch(progressLine(pay("mock-ab12"), "mock"), /tx +http/);
});

test("on the testnet rail the wallets table shows each live balance", () => {
  const resolved = resolveRoster(must(parseParentAccount("inferpay.testnet")));
  assert.ok(resolved.ok);
  const clerk = must(parseAccountId("clerk.kyle.inferpay.testnet"));
  const text = walletsTable(resolved.roster, new Map([[clerk, 579_955_000_000_000_000_000_000n]]));
  assert.match(text, /clerk\.kyle\.inferpay\.testnet +payer +0\.5799 NEAR/);
  assert.match(text, /writer\.kyle\.inferpay\.testnet +payer +not created/);
  assert.match(text, /spend cap/);
  assert.doesNotMatch(walletsTable(resolved.roster, null), /BALANCE/);
});

const model = parseModelId("z-ai/glm-5.3-flash");
if (!model) throw new Error("model");
const signer = "0x3b753b4406613c5e70ae640508632b600424fa0c";

test("a fully verified role names its signer and what was not checked", () => {
  const calls: CallAttestation[] = [
    { verdict: "verified", model, completionId: "a", signer },
    { verdict: "verified", model, completionId: "b", signer },
  ];
  assert.deepEqual(attestLines("specialist", calls), [
    "attest    specialist 2/2 calls verified",
    `          signed by ${signer}, a key in NEAR AI's attestation report for z-ai/glm-5.3-flash`,
    "          request and response hashes match; report echoed our nonce; TDX and GPU quotes not re-verified locally",
  ]);
});

test("an unverified call prints its reason and claims no match", () => {
  const calls: CallAttestation[] = [
    { verdict: "unverified", model, completionId: "a", reason: "hash-mismatch", detail: "signed text differs from what we hashed: response hash" },
  ];
  assert.deepEqual(attestLines("buyer", calls), [
    "attest    buyer 0/1 calls verified",
    "          unverified hash-mismatch: signed text differs from what we hashed: response hash",
  ]);
});

test("a role with no live calls prints nothing", () => {
  assert.deepEqual(attestLines("buyer", []), []);
});

const PROFIT: Figure = {
  kind: "figure",
  company: "Samsung Electronics",
  period: "Q3 2025",
  metric: "operating profit",
  value: 12.2,
  unit: "KRW T",
  source: "Samsung Electronics Q3 2025 earnings release",
};
const REVENUE: Figure = { ...PROFIT, metric: "revenue", value: 86.1 };
const SHOP = sealDataset<Entry>([PROFIT, REVENUE].map((entry, index) => ({ entry, salt: must(parseHash(`0${index + 1}`.repeat(32))) })));
const LISTED: PinnedCommitment = { status: "published", commitment: SHOP.commitment, source: { kind: "listing" } };

function figure(entry: Figure, claimed: number, verdict: "match" | "mismatch" | "unverifiable", evidence = SHOP.prove(entry)): AssertedCheck {
  const claim = { label: `${entry.metric} Q3 2025`, company: entry.company, period: entry.period, metric: entry.metric, claimed, unit: "KRW T" };
  return { kind: "number", claim, verdict, evidence: verdict === "unverifiable" ? null : evidence };
}

const NEEDS: readonly Need[] = [PROFIT, REVENUE].map(({ company, period, metric }) => ({ kind: "figure", company, period, metric }));

function verifyBlock(checks: readonly AssertedCheck[], pinned: PinnedCommitment, rail: "mock" | "near-testnet", needs = NEEDS): string[] {
  const verified = verifyChecks(checks, pinned, "What was Samsung's Q3 2025 revenue?", needs);
  return progressLine({ step: "verify", checks: verified, needs, commitment: pinned }, rail).split("\n");
}

test("the checks block marks each verified check, shows the entry it rests on, and says the root came from the listing", () => {
  const root = SHOP.commitment.root;
  assert.deepEqual(verifyBlock([figure(PROFIT, 12.2, "match"), figure(REVENUE, 86, "mismatch")], LISTED, "mock"), [
    "checks    2 of 2 needed keys opened and verified against the shop's committed root",
    "          verified    match         operating profit Q3 2025  12.2T KRW",
    "                      Samsung Electronics Q3 2025 earnings release",
    "          verified    mismatch      revenue Q3 2025           86.0T KRW   ref 86.1T KRW (-0.12%)",
    "                      Samsung Electronics Q3 2025 earnings release",
    `          root      ${root.slice(0, 12)}…${root.slice(-4)}  2 leaves  inferpay-keyed-merkle-sha256-v1`,
    "          from      the shop's listing, because the mock rail has no chain",
  ]);
});

test("an unproven check and a forged one are labelled, and neither prints as a match", () => {
  const rewritten = { ...SHOP.prove(REVENUE), entry: { ...REVENUE, value: 86 } };
  const block = verifyBlock([figure(PROFIT, 1, "unverifiable"), figure(REVENUE, 86, "match", rewritten)], LISTED, "mock");
  assert.deepEqual(block.slice(0, 9), [
    "checks    0 of 2 needed keys opened and verified against the shop's committed root, 2 WITHHELD, 1 unproven, 1 FORGED",
    "          unproven    unverifiable  operating profit Q3 2025  1.0T KRW",
    "                      the shop's word only: it sent no proof that it holds no entry for this",
    "          FORGED      match         revenue Q3 2025           86.0T KRW",
    "                      the shop said match, but its evidence does not open to the committed root",
    "          WITHHELD                  Samsung Electronics / Q3 2025 / operating profit",
    "                      the buyer needed this key and the shop sent no verified opening of it",
    "          WITHHELD                  Samsung Electronics / Q3 2025 / revenue",
    "                      the buyer needed this key and the shop sent no verified opening of it",
  ]);
  const checks = verifyChecks([figure(REVENUE, 86, "match", rewritten)], LISTED, "What was Samsung's Q3 2025 revenue?", NEEDS);
  assert.equal(
    progressLine({ step: "rate", grade: grade(checks), jobId: must(parseJobId("job_01M7BGGX58BF3B8VB4ADYKXYZA")), onChain: null }, "mock"),
    [
      "rate      1/5  forged evidence sets the rating to 1",
      "          rule    start at 5; for each key the buyer needed, -1 per mismatch, -1 per empty slot,",
      "                  -1 per key opened with no claim, -2 per key withheld;",
      "                  at least 2 unless a check is forged, and 1 if any check is forged;",
      "                  checks the buyer did not ask for never count",
      "          kept      in this machine's ledger, because the mock rail has no chain",
    ].join("\n"),
  );
});

test("a root read from chain names its block, its SocialDB key, and a link to the shop's account", () => {
  const account = must(parseAccountId("disclosure.david.inferpay.testnet"));
  const contract = must(parseAccountId("v1.social08.testnet"));
  const pinned: PinnedCommitment = { status: "published", commitment: SHOP.commitment, source: { kind: "chain", contract, account, block: 277573383 } };
  const profitOnly = NEEDS.slice(0, 1);
  assert.deepEqual(verifyBlock([figure(PROFIT, 12.2, "match")], pinned, "near-testnet", profitOnly).slice(3), [
    `          root      ${SHOP.commitment.root.slice(0, 12)}…${SHOP.commitment.root.slice(-4)}  2 leaves  inferpay-keyed-merkle-sha256-v1`,
    "          from      NEAR testnet, written at block 277573383 and read before paying",
    "          key       disclosure.david.inferpay.testnet/inferpay/commitment in SocialDB v1.social08.testnet",
    "          link      https://testnet.nearblocks.io/address/disclosure.david.inferpay.testnet",
  ]);
  const missing = verifyBlock([figure(PROFIT, 12.2, "match")], { status: "missing", contract, account }, "near-testnet", profitOnly);
  assert.deepEqual(missing, [
    "checks    0 of 1 needed key opened and verified against the shop's committed root, 1 WITHHELD, 1 unproven",
    "          unproven    match         operating profit Q3 2025  12.2T KRW",
    "                      the shop's word only: it has published no root to check this against",
    "          WITHHELD                  Samsung Electronics / Q3 2025 / operating profit",
    "                      the buyer needed this key and the shop sent no verified opening of it",
    "          root      none: disclosure.david.inferpay.testnet has published no commitment in SocialDB v1.social08.testnet",
  ]);
});

test("no line of a checks block is wider than 110 columns", () => {
  const blocks = [
    verifyBlock([figure(PROFIT, 12.2, "match"), figure(REVENUE, 86, "mismatch"), figure(PROFIT, 1, "unverifiable")], LISTED, "mock"),
  ];
  for (const row of blocks.flat()) assert.ok(row.length <= 110, row);
});

function near(amount: string): Price {
  return { asset: must(parseAssetId("nep141:wrap.near")), symbol: "NEAR", amount: must(parseDecimalAmount(amount)) };
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture failed its check");
  return value;
}
