import { compareSameAsset, toUnits, type AccountId, type CorrelationId, type IdempotencyKey, type IsoTime, type JobId, type Price, type ProviderId, type Stars } from "../domain.ts";
import type { Need, PinnedCommitment } from "../commitment/index.ts";
import type { Answer } from "../providers/types.ts";
import type { PaymentReceipt, Transfer } from "../payment/index.ts";

// What the buyer set aside, before the purchase, for what it may cost beyond its price, each an upper bound in
// yoctoNEAR. ratingStorage is also the deposit the rating attaches, so a retried rating signs the same transaction.
export type FeeReserve = {
  readonly paymentGas: string;
  readonly ratingGas: string;
  readonly ratingStorage: string;
  readonly firstRating: boolean;
};

export function reserveTotal(reserve: FeeReserve): bigint {
  return BigInt(reserve.paymentGas) + BigInt(reserve.ratingGas) + BigInt(reserve.ratingStorage);
}

export type Order = {
  readonly jobId: JobId;
  readonly providerId: ProviderId;
  readonly question: string;
  // The keys the buyer requires the shop to open. The payout and the grade count only these.
  readonly needs: readonly Need[];
  // What the buyer offers to pay. The shop charges this, or its list price when the offer is higher.
  readonly offer: Price;
  // The money for this question: the agreed price and every fee must fit in it together.
  readonly budget: Price;
  readonly reserve: FeeReserve;
  readonly payFrom: AccountId;
  // The shop's root as the buyer read it before opening the job. Every check in the answer is verified against it.
  readonly commitment: PinnedCommitment;
};

// What the buyer pays once it has verified the delivery: the agreed price scaled by the needed keys the shop
// proved, or nothing when any check is forged.
export type Payout = {
  readonly amount: Price;
  readonly basis:
    | { readonly kind: "forged"; readonly forged: number }
    | { readonly kind: "share"; readonly proven: number; readonly needed: number };
};

// A job runs in the order the buyer can trust: open at an agreed price, take delivery, verify, then pay. The
// delivery is written before anything is done with it, so a resumed job never asks the shop twice.
export type JobEvent =
  | { readonly type: "opened"; readonly at: IsoTime; readonly order: Order; readonly quote: Price; readonly payTo: AccountId }
  | { readonly type: "fulfil-failed"; readonly at: IsoTime; readonly reason: string; readonly retryable: boolean }
  | { readonly type: "delivered"; readonly at: IsoTime; readonly answer: Answer }
  | { readonly type: "payout-decided"; readonly at: IsoTime; readonly payout: Payout }
  | { readonly type: "payment-intended"; readonly at: IsoTime; readonly key: IdempotencyKey }
  | { readonly type: "payment-pending"; readonly at: IsoTime; readonly correlationId: CorrelationId | null; readonly uncertain: boolean }
  | { readonly type: "payment-settled"; readonly at: IsoTime; readonly receipt: PaymentReceipt }
  | { readonly type: "payment-rejected"; readonly at: IsoTime; readonly reason: string }
  | { readonly type: "rated"; readonly at: IsoTime; readonly rating: Stars }
  // The transaction that wrote the rating on chain. Only a rail with an on-chain registry appends it.
  | { readonly type: "rating-posted"; readonly at: IsoTime; readonly tx: string };

type Opened = { readonly order: Order; readonly quote: Price; readonly payTo: AccountId };
type Delivered = Opened & { readonly answer: Answer };
type Decided = Delivered & { readonly payout: Payout };

// unpaid is a payout of zero: the buyer owes nothing, so no transfer is ever attempted.
export type Settlement = { readonly kind: "paid"; readonly receipt: PaymentReceipt } | { readonly kind: "unpaid" };

export type JobState =
  | ({ readonly phase: "awaiting-delivery"; readonly failures: readonly string[] } & Opened)
  | ({ readonly phase: "abandoned"; readonly reason: string } & Opened)
  | ({ readonly phase: "delivered" } & Delivered)
  | ({ readonly phase: "payable" } & Decided)
  | ({ readonly phase: "paying"; readonly key: IdempotencyKey; readonly correlationId: CorrelationId | null } & Decided)
  | ({ readonly phase: "payment-rejected"; readonly reason: string } & Decided)
  | ({ readonly phase: "settled"; readonly settlement: Settlement } & Decided)
  | ({ readonly phase: "rated"; readonly settlement: Settlement; readonly rating: Stars; readonly postedTx: string | null } & Decided);

export type PlanStop =
  | { readonly kind: "payment-rejected"; readonly reason: string }
  | { readonly kind: "provider-failed"; readonly reason: string };

export type Effect =
  | { readonly kind: "fulfil" }
  | { readonly kind: "decide-payout" }
  | { readonly kind: "intend-payment" }
  | { readonly kind: "settle"; readonly transfer: Transfer }
  | { readonly kind: "done" }
  | { readonly kind: "stop"; readonly reason: PlanStop };

export const MAX_FULFIL_ATTEMPTS = 3;

export type Reputation =
  | { readonly kind: "unrated"; readonly completedJobs: number }
  | { readonly kind: "rated"; readonly completedJobs: number; readonly ratings: number; readonly average: number };

export function fold(
  events: readonly JobEvent[],
): { readonly ok: true; readonly state: JobState } | { readonly ok: false; readonly corrupt: string } {
  const first = events[0];
  if (!first) return { ok: false, corrupt: "empty ledger" };
  if (first.type !== "opened") return { ok: false, corrupt: "ledger does not start with opened" };
  let state: JobState = { phase: "awaiting-delivery", order: first.order, quote: first.quote, payTo: first.payTo, failures: [] };
  for (const event of events.slice(1)) {
    const next = apply(state, event);
    if (next === null) return { ok: false, corrupt: `${event.type} does not follow ${state.phase}` };
    state = next;
  }
  return { ok: true, state };
}

export function plan(state: JobState): Effect {
  switch (state.phase) {
    case "awaiting-delivery":
      if (state.failures.length >= MAX_FULFIL_ATTEMPTS) {
        return { kind: "stop", reason: { kind: "provider-failed", reason: state.failures.at(-1) ?? "provider failed" } };
      }
      return { kind: "fulfil" };
    case "abandoned":
      return { kind: "stop", reason: { kind: "provider-failed", reason: state.reason } };
    case "delivered":
      return { kind: "decide-payout" };
    case "payable":
      return { kind: "intend-payment" };
    case "paying":
      return {
        kind: "settle",
        transfer: { jobId: state.order.jobId, key: state.key, payer: state.order.payFrom, amount: state.payout.amount, recipient: state.payTo },
      };
    case "payment-rejected":
      return { kind: "stop", reason: { kind: "payment-rejected", reason: state.reason } };
    case "settled":
    case "rated":
      return { kind: "done" };
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function reputationOf(states: readonly JobState[]): Reputation {
  const completedJobs = states.filter((state) => state.phase === "settled" || state.phase === "rated").length;
  return reputationFromStars(states.flatMap((state) => (state.phase === "rated" ? [state.rating] : [])), completedJobs);
}

export function reputationFromStars(stars: readonly Stars[], completedJobs: number): Reputation {
  if (stars.length === 0) return { kind: "unrated", completedJobs };
  const sum = stars.reduce((total, rating) => total + rating, 0);
  return { kind: "rated", completedJobs, ratings: stars.length, average: sum / stars.length };
}

// A payout can only scale the agreed price down, in the same asset, and a forged delivery is paid nothing.
function payoutFits(quote: Price, payout: Payout): boolean {
  if (payout.amount.symbol !== quote.symbol) return false;
  const cmp = compareSameAsset(payout.amount, quote);
  if (cmp === "different-asset" || cmp > 0) return false;
  if (payout.basis.kind === "forged") return toUnits(payout.amount.amount) === 0n;
  return payout.basis.proven <= payout.basis.needed;
}

function receiptMatches(state: Extract<JobState, { phase: "paying" }>, receipt: PaymentReceipt): boolean {
  return receipt.key === state.key
    && receipt.recipient === state.payTo
    && receipt.amount.symbol === state.payout.amount.symbol
    && compareSameAsset(receipt.amount, state.payout.amount) === 0;
}

function opened(state: Opened): Opened {
  return { order: state.order, quote: state.quote, payTo: state.payTo };
}

function decided(state: Decided): Decided {
  return { ...opened(state), answer: state.answer, payout: state.payout };
}

function apply(state: JobState, event: JobEvent): JobState | null {
  switch (event.type) {
    case "opened":
      return null;
    case "fulfil-failed":
      if (state.phase !== "awaiting-delivery") return null;
      if (!event.retryable) return { phase: "abandoned", ...opened(state), reason: event.reason };
      return { ...state, failures: [...state.failures, event.reason] };
    case "delivered":
      if (state.phase !== "awaiting-delivery") return null;
      return { phase: "delivered", ...opened(state), answer: event.answer };
    case "payout-decided": {
      if (state.phase !== "delivered" || !payoutFits(state.quote, event.payout)) return null;
      const next: Decided = { ...opened(state), answer: state.answer, payout: event.payout };
      if (toUnits(event.payout.amount.amount) === 0n) return { phase: "settled", ...next, settlement: { kind: "unpaid" } };
      return { phase: "payable", ...next };
    }
    case "payment-intended":
      if (state.phase !== "payable") return null;
      return { phase: "paying", ...decided(state), key: event.key, correlationId: null };
    case "payment-pending":
      if (state.phase !== "paying") return null;
      return { ...state, correlationId: event.correlationId };
    case "payment-settled":
      if (state.phase !== "paying" || !receiptMatches(state, event.receipt)) return null;
      return { phase: "settled", ...decided(state), settlement: { kind: "paid", receipt: event.receipt } };
    case "payment-rejected":
      if (state.phase !== "paying") return null;
      return { phase: "payment-rejected", ...decided(state), reason: event.reason };
    case "rated":
      if (state.phase !== "settled") return null;
      return { phase: "rated", ...decided(state), settlement: state.settlement, rating: event.rating, postedTx: null };
    case "rating-posted":
      if (state.phase !== "rated" || state.postedTx !== null) return null;
      return { ...state, postedTx: event.tx };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
