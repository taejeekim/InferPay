import {
  compareSameAsset,
  type Brand,
  type CorrelationId,
  type IdempotencyKey,
  type JobId,
  type ProviderId,
  type Stars,
} from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import type { PaymentRail, PaymentReceipt } from "../payment/index.ts";
import type { Answer, PaidOrder } from "../providers/types.ts";
import type { AccountId, IsoTime, Price } from "../domain.ts";
import { canonical, type PinnedCommitment } from "../commitment/index.ts";
import { priceFor, type BoundProvider } from "../providers/index.ts";
import type { ProviderListing } from "../providers/types.ts";
import type { Registry } from "../registry/index.ts";
import { fold, plan, reputationOf, type JobEvent, type JobState, type Order, type Reputation } from "./job.ts";
import { createFileLedger, LedgerReadError, type Ledger } from "./ledger.ts";

export type { JobEvent, JobState, Order, Reputation } from "./job.ts";
export { createFileLedger };

export type CompletedJob = Brand<
  {
    readonly jobId: JobId;
    readonly providerId: ProviderId;
    readonly question: string;
    readonly payFrom: AccountId;
    readonly commitment: PinnedCommitment;
    readonly paid: PaymentReceipt;
    readonly answer: Answer;
    readonly rating: Stars | null;
  },
  "CompletedJob"
>;

export type Listing = Omit<ProviderListing, "declared"> & {
  readonly reputation: Reputation;
  readonly commitment: PinnedCommitment;
};

export type FailReason =
  | { readonly kind: "unknown-provider"; readonly providerId: ProviderId }
  | { readonly kind: "unknown-job"; readonly jobId: JobId }
  | { readonly kind: "over-budget"; readonly offer: Price; readonly budget: Price }
  | { readonly kind: "offer-refused"; readonly providerId: ProviderId; readonly offer: Price }
  | { readonly kind: "order-conflict"; readonly jobId: JobId }
  | { readonly kind: "job-busy"; readonly jobId: JobId }
  | { readonly kind: "corrupt-ledger"; readonly jobId: JobId; readonly detail: string }
  | { readonly kind: "payment-rejected"; readonly reason: string }
  | { readonly kind: "provider-failed"; readonly reason: string }
  | { readonly kind: "inference"; readonly detail: string };

export type HireOutcome =
  | { readonly kind: "completed"; readonly job: CompletedJob; readonly transfer: "called" | "skipped" }
  | {
      readonly kind: "waiting";
      readonly jobId: JobId;
      readonly why: "payment-pending" | "payment-uncertain";
      readonly correlationId: CorrelationId | null;
    }
  | { readonly kind: "failed"; readonly jobId: JobId; readonly reason: FailReason };

export type MarketProgress =
  | {
      readonly step: "pay";
      readonly transfer: "called" | "skipped";
      readonly status: "settled" | "pending" | "uncertain" | "rejected";
      readonly amount: Price;
      readonly payer: AccountId;
      readonly recipient: AccountId;
      readonly correlationId: CorrelationId | null;
      readonly key: IdempotencyKey;
      readonly jobId: JobId;
    }
  | { readonly step: "answer"; readonly answer: Answer }
  | {
      readonly step: "pending";
      readonly jobId: JobId;
      readonly why: "payment-pending" | "payment-uncertain";
      readonly correlationId: CorrelationId | null;
    };

export type JobView = { readonly order: Order; readonly state: JobState; readonly events: readonly JobEvent[] };

export type RateResult =
  | { readonly kind: "recorded"; readonly reputation: Reputation }
  | { readonly kind: "unchanged"; readonly reputation: Reputation }
  | { readonly kind: "rejected"; readonly reason: "different-stars"; readonly reputation: Reputation };

export type CounterReply = "accepted" | "refused";

export interface Marketplace {
  listings(): Promise<readonly Listing[]>;
  counter(providerId: ProviderId, offer: Price): Promise<CounterReply>;
  hire(order: Order, onProgress?: (progress: MarketProgress) => void): Promise<HireOutcome>;
  rate(job: CompletedJob, rating: Stars): Promise<RateResult>;
  job(jobId: JobId): Promise<JobView | null>;
}

const HIRE_STEPS = 8;

export function createMarketplace(deps: {
  readonly ledger: Ledger;
  readonly rail: PaymentRail;
  readonly inference: Inference;
  readonly providers: readonly BoundProvider[];
  readonly registry: Registry | null;
  readonly clock: () => IsoTime;
}): Marketplace {
  const { ledger, rail, inference, providers, registry, clock } = deps;

  return {
    async listings() {
      const rows = await ledger.all();
      const states = new Map<ProviderId, JobState[]>();
      for (const row of rows) {
        const folded = fold(row.events);
        if (!folded.ok) continue;
        const id = folded.state.order.providerId;
        const bucket = states.get(id) ?? [];
        bucket.push(folded.state);
        states.set(id, bucket);
      }
      const onChain = registry === null ? null : await registry.commitments(providers.map((bound) => bound.listing.payTo));
      return providers.map((bound) => {
        const { declared, ...listing } = bound.listing;
        const commitment: PinnedCommitment | undefined = onChain === null
          ? { status: "published", commitment: declared, source: { kind: "listing" } }
          : onChain.get(listing.payTo);
        if (commitment === undefined) throw new Error(`the registry returned nothing for ${listing.payTo}`);
        return { ...listing, reputation: reputationOf(states.get(listing.id) ?? []), commitment };
      });
    },

    async counter(providerId, offer) {
      const bound = providers.find((item) => item.listing.id === providerId);
      if (!bound || priceFor(bound, offer) === null) return "refused";
      return "accepted";
    },

    async hire(order, onProgress) {
      const held = await ledger.lock(order.jobId);
      if (!held) return fail(order.jobId, { kind: "job-busy", jobId: order.jobId });
      try {
        return await drive(order, onProgress);
      } catch (error) {
        if (error instanceof LedgerReadError) {
          return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: error.message });
        }
        throw error;
      } finally {
        await held.release();
      }
    },

    async rate(job, rating) {
      const held = await ledger.lock(job.jobId);
      if (!held) throw new Error("job-busy");
      try {
        const events = await readOrThrow(ledger, job.jobId);
        const folded = fold(events);
        if (!folded.ok) throw new LedgerReadError(folded.corrupt);
        const providerId = folded.state.order.providerId;
        if (folded.state.phase === "rated") {
          const reputation = await reputationFor(ledger, providerId);
          if (folded.state.rating === rating) return { kind: "unchanged", reputation };
          return { kind: "rejected", reason: "different-stars", reputation };
        }
        if (folded.state.phase !== "completed") throw new Error("job is not complete");
        const wrote = await ledger.appendIfAbsent(job.jobId, { type: "rated", at: clock(), rating });
        const reputation = await reputationFor(ledger, providerId);
        if (wrote) return { kind: "recorded", reputation };
        const after = fold(await readOrThrow(ledger, job.jobId));
        if (after.ok && after.state.phase === "rated" && after.state.rating === rating) {
          return { kind: "unchanged", reputation };
        }
        return { kind: "rejected", reason: "different-stars", reputation };
      } finally {
        await held.release();
      }
    },

    async job(jobId) {
      const events = await readOrThrow(ledger, jobId);
      if (events.length === 0) return null;
      const folded = fold(events);
      if (!folded.ok) throw new LedgerReadError(folded.corrupt);
      return { order: folded.state.order, state: folded.state, events };
    },
  };

  async function drive(order: Order, onProgress?: (progress: MarketProgress) => void): Promise<HireOutcome> {
    let events: readonly JobEvent[];
    try {
      events = await ledger.read(order.jobId);
    } catch (error) {
      if (error instanceof LedgerReadError) return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: error.message });
      throw error;
    }
    if (events.length === 0) {
      const bound = providers.find((item) => item.listing.id === order.providerId);
      if (!bound) return fail(order.jobId, { kind: "unknown-provider", providerId: order.providerId });
      const cmp = compareSameAsset(order.offer, order.budget);
      if (cmp === "different-asset" || cmp > 0) {
        return fail(order.jobId, { kind: "over-budget", offer: order.offer, budget: order.budget });
      }
      const quote = priceFor(bound, order.offer);
      if (quote === null) {
        return fail(order.jobId, { kind: "offer-refused", providerId: order.providerId, offer: order.offer });
      }
      await ledger.append(order.jobId, { type: "opened", at: clock(), order, quote, payTo: bound.listing.payTo });
      events = await ledger.read(order.jobId);
    } else {
      const existing = fold(events);
      if (!existing.ok) return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: existing.corrupt });
      if (!sameOrder(existing.state.order, order)) return fail(order.jobId, { kind: "order-conflict", jobId: order.jobId });
    }

    let transfer: "called" | "skipped" = "skipped";
    for (let step = 0; step < HIRE_STEPS; step += 1) {
      const folded = fold(events);
      if (!folded.ok) return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: folded.corrupt });
      const effect = plan(folded.state);
      switch (effect.kind) {
        case "intend-payment": {
          const key = rail.mintKey();
          events = await commit(order.jobId, { type: "payment-intended", at: clock(), key });
          break;
        }
        case "settle": {
          transfer = "called";
          const status = await rail.settle(effect.transfer);
          if (status.kind === "settled") {
            events = await commit(order.jobId, { type: "payment-settled", at: clock(), receipt: status.receipt });
            onProgress?.(payProgress(folded.state, {
              transfer: "called",
              status: "settled",
              correlationId: status.receipt.correlationId,
              key: status.receipt.key,
              jobId: order.jobId,
            }));
            break;
          }
          if (status.kind === "pending" || status.kind === "uncertain") {
            const why = status.kind === "uncertain" ? "payment-uncertain" : "payment-pending";
            events = await commit(order.jobId, {
              type: "payment-pending",
              at: clock(),
              correlationId: status.correlationId,
              uncertain: status.kind === "uncertain",
            });
            onProgress?.(payProgress(folded.state, {
              transfer: "called",
              status: status.kind,
              correlationId: status.correlationId,
              key: effect.transfer.key,
              jobId: order.jobId,
            }));
            onProgress?.({ step: "pending", jobId: order.jobId, why, correlationId: status.correlationId });
            return { kind: "waiting", jobId: order.jobId, why, correlationId: status.correlationId };
          }
          events = await commit(order.jobId, { type: "payment-rejected", at: clock(), reason: status.reason });
          onProgress?.(payProgress(folded.state, {
            transfer: "called",
            status: "rejected",
            correlationId: null,
            key: effect.transfer.key,
            jobId: order.jobId,
          }));
          break;
        }
        case "fulfil": {
          if (folded.state.phase !== "paid") {
            return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: "fulfil without a paid job" });
          }
          const paid = paidOrder(folded.state);
          if (!paid) return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: "paid order failed its check" });
          const bound = providers.find((item) => item.listing.id === folded.state.order.providerId);
          if (!bound) return fail(order.jobId, { kind: "unknown-provider", providerId: folded.state.order.providerId });
          const result = await fulfilQuiet(bound, paid, inference);
          events = await commit(
            order.jobId,
            result.ok
              ? { type: "fulfilled", at: clock(), answer: result.answer }
              : { type: "fulfil-failed", at: clock(), reason: result.reason, retryable: result.retryable },
          );
          if (result.ok) onProgress?.({ step: "answer", answer: result.answer });
          break;
        }
        case "done": {
          const job = completedJob(folded.state);
          if (!job) return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: "completed job failed its check" });
          if (transfer === "skipped" && (folded.state.phase === "completed" || folded.state.phase === "rated")) {
            onProgress?.(payProgress(folded.state, {
              transfer: "skipped",
              status: "settled",
              correlationId: folded.state.receipt.correlationId,
              key: folded.state.receipt.key,
              jobId: order.jobId,
            }));
            onProgress?.({ step: "answer", answer: folded.state.answer });
          }
          return { kind: "completed", job, transfer };
        }
        case "stop":
          if (effect.reason.kind === "payment-rejected") {
            return fail(order.jobId, { kind: "payment-rejected", reason: effect.reason.reason });
          }
          return fail(order.jobId, { kind: "provider-failed", reason: effect.reason.reason });
        default: {
          const unreachable: never = effect;
          return unreachable;
        }
      }
    }
    return fail(order.jobId, { kind: "provider-failed", reason: "the job did not finish" });
  }

  async function commit(jobId: JobId, event: JobEvent): Promise<readonly JobEvent[]> {
    await ledger.append(jobId, event);
    return readOrThrow(ledger, jobId);
  }
}

function fail(jobId: JobId, reason: FailReason): HireOutcome {
  return { kind: "failed", jobId, reason };
}

function payProgress(
  opened: { readonly order: Order; readonly quote: Price; readonly payTo: AccountId },
  payment: {
    readonly transfer: "called" | "skipped";
    readonly status: "settled" | "pending" | "uncertain" | "rejected";
    readonly correlationId: CorrelationId | null;
    readonly key: IdempotencyKey;
    readonly jobId: JobId;
  },
): MarketProgress {
  return {
    step: "pay",
    transfer: payment.transfer,
    status: payment.status,
    amount: opened.quote,
    payer: opened.order.payFrom,
    recipient: opened.payTo,
    correlationId: payment.correlationId,
    key: payment.key,
    jobId: payment.jobId,
  };
}

function sameOrder(a: Order, b: Order): boolean {
  return a.jobId === b.jobId
    && a.providerId === b.providerId
    && a.question === b.question
    && a.payFrom === b.payFrom
    && canonical(a.commitment) === canonical(b.commitment)
    && samePrice(a.offer, b.offer)
    && samePrice(a.budget, b.budget);
}

function samePrice(a: Price, b: Price): boolean {
  return a.asset === b.asset && a.symbol === b.symbol && a.amount === b.amount;
}

async function readOrThrow(ledger: Ledger, jobId: JobId): Promise<readonly JobEvent[]> {
  try {
    return await ledger.read(jobId);
  } catch (error) {
    if (error instanceof LedgerReadError) throw error;
    throw error;
  }
}

async function reputationFor(ledger: Ledger, providerId: ProviderId): Promise<Reputation> {
  const rows = await ledger.all();
  const states: JobState[] = [];
  for (const row of rows) {
    const folded = fold(row.events);
    if (!folded.ok) continue;
    if (folded.state.order.providerId === providerId) states.push(folded.state);
  }
  return reputationOf(states);
}

async function fulfilQuiet(
  bound: BoundProvider,
  paid: PaidOrder,
  inference: Inference,
): Promise<{ ok: true; answer: Answer } | { ok: false; reason: string; retryable: boolean }> {
  try {
    return await bound.provider.fulfil(paid, { inference });
  } catch {
    return { ok: false, reason: "provider threw", retryable: true };
  }
}

function paidOrder(state: Extract<JobState, { phase: "paid" }>): PaidOrder | null {
  const value = { jobId: state.order.jobId, question: state.order.question, receipt: state.receipt };
  if (!isPaidOrder(value)) return null;
  return value;
}

function isPaidOrder(value: { jobId: JobId; question: string; receipt: PaymentReceipt }): value is PaidOrder {
  return value.question.length > 0 && value.receipt.key.length > 0;
}

function completedJob(state: JobState): CompletedJob | null {
  if (state.phase !== "completed" && state.phase !== "rated") return null;
  const value = {
    jobId: state.order.jobId,
    providerId: state.order.providerId,
    question: state.order.question,
    payFrom: state.order.payFrom,
    commitment: state.order.commitment,
    paid: state.receipt,
    answer: state.answer,
    rating: state.phase === "rated" ? state.rating : null,
  };
  if (!isCompletedJob(value)) return null;
  return value;
}

function isCompletedJob(value: {
  jobId: JobId;
  providerId: ProviderId;
  question: string;
  payFrom: AccountId;
  commitment: PinnedCommitment;
  paid: PaymentReceipt;
  answer: Answer;
  rating: Stars | null;
}): value is CompletedJob {
  return value.question.length > 0 && value.answer.text.length > 0 && value.paid.key.length > 0;
}
