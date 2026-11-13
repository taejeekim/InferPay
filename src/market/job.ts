import { compareSameAsset, type AccountId, type CorrelationId, type IdempotencyKey, type IsoTime, type JobId, type Price, type ProviderId, type Stars } from "../domain.ts";
import type { PinnedCommitment } from "../commitment/index.ts";
import type { Answer } from "../providers/types.ts";
import type { PaymentReceipt, Transfer } from "../payment/index.ts";

export type Order = {
  readonly jobId: JobId;
  readonly providerId: ProviderId;
  readonly question: string;
  // What the buyer offers to pay. The shop charges this, or its list price when the offer is higher.
  readonly offer: Price;
  readonly budget: Price;
  readonly payFrom: AccountId;
  // The shop's root as the buyer read it before paying. Every check in the answer is verified against this one.
  readonly commitment: PinnedCommitment;
};

export type JobEvent =
  | { readonly type: "opened"; readonly at: IsoTime; readonly order: Order; readonly quote: Price; readonly payTo: AccountId }
  | { readonly type: "payment-intended"; readonly at: IsoTime; readonly key: IdempotencyKey }
  | { readonly type: "payment-pending"; readonly at: IsoTime; readonly correlationId: CorrelationId | null; readonly uncertain: boolean }
  | { readonly type: "payment-settled"; readonly at: IsoTime; readonly receipt: PaymentReceipt }
  | { readonly type: "payment-rejected"; readonly at: IsoTime; readonly reason: string }
  | { readonly type: "fulfil-failed"; readonly at: IsoTime; readonly reason: string; readonly retryable: boolean }
  | { readonly type: "fulfilled"; readonly at: IsoTime; readonly answer: Answer }
  | { readonly type: "rated"; readonly at: IsoTime; readonly rating: Stars }
  // The transaction that wrote the rating on chain. Only a rail with an on-chain registry appends it.
  | { readonly type: "rating-posted"; readonly at: IsoTime; readonly tx: string };

type Opened = { readonly order: Order; readonly quote: Price; readonly payTo: AccountId };

export type JobState =
  | ({ readonly phase: "open" } & Opened)
  | ({ readonly phase: "paying"; readonly key: IdempotencyKey; readonly correlationId: CorrelationId | null } & Opened)
  | ({ readonly phase: "paid"; readonly receipt: PaymentReceipt; readonly failures: readonly string[] } & Opened)
  | ({ readonly phase: "completed"; readonly receipt: PaymentReceipt; readonly answer: Answer } & Opened)
  | ({ readonly phase: "rated"; readonly receipt: PaymentReceipt; readonly answer: Answer; readonly rating: Stars; readonly postedTx: string | null } & Opened)
  | ({ readonly phase: "payment-rejected"; readonly reason: string } & Opened)
  | ({ readonly phase: "abandoned"; readonly receipt: PaymentReceipt; readonly reason: string } & Opened);

export type PlanStop =
  | { readonly kind: "payment-rejected"; readonly reason: string }
  | { readonly kind: "provider-failed"; readonly reason: string };

export type Effect =
  | { readonly kind: "intend-payment" }
  | { readonly kind: "settle"; readonly transfer: Transfer }
  | { readonly kind: "fulfil" }
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
  let state: JobState = {
    phase: "open",
    order: first.order,
    quote: first.quote,
    payTo: first.payTo,
  };
  for (const event of events.slice(1)) {
    const next = apply(state, event);
    if (next === null) return { ok: false, corrupt: `${event.type} does not follow ${state.phase}` };
    state = next;
  }
  return { ok: true, state };
}

export function plan(state: JobState): Effect {
  switch (state.phase) {
    case "open":
      return { kind: "intend-payment" };
    case "paying":
      return {
        kind: "settle",
        transfer: { key: state.key, payer: state.order.payFrom, amount: state.quote, recipient: state.payTo },
      };
    case "paid":
      if (state.failures.length >= MAX_FULFIL_ATTEMPTS) {
        return {
          kind: "stop",
          reason: { kind: "provider-failed", reason: state.failures.at(-1) ?? "provider failed" },
        };
      }
      return { kind: "fulfil" };
    case "completed":
    case "rated":
      return { kind: "done" };
    case "payment-rejected":
      return { kind: "stop", reason: { kind: "payment-rejected", reason: state.reason } };
    case "abandoned":
      return { kind: "stop", reason: { kind: "provider-failed", reason: state.reason } };
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function reputationOf(states: readonly JobState[]): Reputation {
  const completedJobs = states.filter((state) => state.phase === "completed" || state.phase === "rated").length;
  return reputationFromStars(states.flatMap((state) => (state.phase === "rated" ? [state.rating] : [])), completedJobs);
}

export function reputationFromStars(stars: readonly Stars[], completedJobs: number): Reputation {
  if (stars.length === 0) return { kind: "unrated", completedJobs };
  const sum = stars.reduce((total, rating) => total + rating, 0);
  return { kind: "rated", completedJobs, ratings: stars.length, average: sum / stars.length };
}

function receiptMatches(
  state: { readonly key: IdempotencyKey; readonly quote: Price; readonly payTo: AccountId },
  receipt: PaymentReceipt,
): boolean {
  return receipt.key === state.key
    && receipt.recipient === state.payTo
    && receipt.amount.symbol === state.quote.symbol
    && compareSameAsset(receipt.amount, state.quote) === 0;
}

function apply(state: JobState, event: JobEvent): JobState | null {
  switch (event.type) {
    case "opened":
      return null;
    case "payment-intended":
      if (state.phase !== "open") return null;
      return {
        phase: "paying",
        order: state.order,
        quote: state.quote,
        payTo: state.payTo,
        key: event.key,
        correlationId: null,
      };
    case "payment-pending":
      if (state.phase !== "paying") return null;
      return { ...state, correlationId: event.correlationId };
    case "payment-settled":
      if (state.phase !== "paying") return null;
      if (!receiptMatches(state, event.receipt)) return null;
      return {
        phase: "paid",
        order: state.order,
        quote: state.quote,
        payTo: state.payTo,
        receipt: event.receipt,
        failures: [],
      };
    case "payment-rejected":
      if (state.phase !== "paying") return null;
      return {
        phase: "payment-rejected",
        order: state.order,
        quote: state.quote,
        payTo: state.payTo,
        reason: event.reason,
      };
    case "fulfil-failed":
      if (state.phase !== "paid") return null;
      if (!event.retryable) {
        return {
          phase: "abandoned",
          order: state.order,
          quote: state.quote,
          payTo: state.payTo,
          receipt: state.receipt,
          reason: event.reason,
        };
      }
      return { ...state, failures: [...state.failures, event.reason] };
    case "fulfilled":
      if (state.phase !== "paid") return null;
      return {
        phase: "completed",
        order: state.order,
        quote: state.quote,
        payTo: state.payTo,
        receipt: state.receipt,
        answer: event.answer,
      };
    case "rated":
      if (state.phase !== "completed") return null;
      return {
        phase: "rated",
        order: state.order,
        quote: state.quote,
        payTo: state.payTo,
        receipt: state.receipt,
        answer: state.answer,
        rating: event.rating,
        postedTx: null,
      };
    case "rating-posted":
      if (state.phase !== "rated" || state.postedTx !== null) return null;
      return { ...state, postedTx: event.tx };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
