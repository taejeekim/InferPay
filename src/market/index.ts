import {
  compareSameAsset,
  toUnits,
  type CorrelationId,
  type IdempotencyKey,
  type JobId,
  type ProviderId,
  type Stars,
} from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import type { PaymentRail } from "../payment/index.ts";
import type { Answer, JobOrder } from "../providers/types.ts";
import type { AccountId, IsoTime, Price } from "../domain.ts";
import { canonical, type Need, type PinnedCommitment } from "../commitment/index.ts";
import { priceFor, type BoundProvider } from "../providers/index.ts";
import type { ProviderListing } from "../providers/types.ts";
import type { RatingPost, Registry } from "../registry/index.ts";
import { fold, plan, reputationFromStars, reputationOf, type JobEvent, type JobState, type Order, type Payout, type Reputation, type Settlement } from "./job.ts";
import { createFileLedger, isStorableAnswer, LedgerReadError, type Ledger } from "./ledger.ts";

export type { JobEvent, JobState, Order, Payout, Reputation, Settlement } from "./job.ts";
export { createFileLedger };

// A job the buyer verified and settled: paid its payout, or owed nothing.
export type SettledJob = {
  readonly jobId: JobId;
  readonly providerId: ProviderId;
  readonly question: string;
  readonly needs: readonly Need[];
  readonly payFrom: AccountId;
  readonly payTo: AccountId;
  readonly commitment: PinnedCommitment;
  // The price the buyer and the shop agreed when the job opened.
  readonly quote: Price;
  readonly answer: Answer;
  readonly payout: Payout;
  readonly settlement: Settlement;
  readonly rating: Stars | null;
};

export type Listing = Omit<ProviderListing, "declared"> & {
  readonly reputation: Reputation;
  readonly commitment: PinnedCommitment;
};

export type FailReason =
  | { readonly kind: "unknown-provider"; readonly providerId: ProviderId }
  | { readonly kind: "unknown-job"; readonly jobId: JobId }
  | { readonly kind: "over-budget"; readonly offer: Price; readonly budget: Price }
  | { readonly kind: "offer-refused"; readonly providerId: ProviderId; readonly offer: Price }
  | { readonly kind: "stale-commitment"; readonly providerId: ProviderId }
  | { readonly kind: "no-commitment"; readonly providerId: ProviderId }
  | { readonly kind: "no-needs"; readonly providerId: ProviderId }
  | { readonly kind: "order-conflict"; readonly jobId: JobId }
  | { readonly kind: "job-busy"; readonly jobId: JobId }
  | { readonly kind: "corrupt-ledger"; readonly jobId: JobId; readonly detail: string }
  | { readonly kind: "payment-rejected"; readonly reason: string }
  | { readonly kind: "provider-failed"; readonly reason: string }
  | { readonly kind: "inference"; readonly detail: string };

export type HireOutcome =
  | { readonly kind: "settled"; readonly job: SettledJob; readonly transfer: "called" | "skipped" | "none" }
  | {
      readonly kind: "waiting";
      readonly jobId: JobId;
      readonly why: "payment-pending" | "payment-uncertain";
      readonly correlationId: CorrelationId | null;
    }
  | { readonly kind: "failed"; readonly jobId: JobId; readonly reason: FailReason };

export type MarketProgress =
  // resumed is true when this run found the job already open in the ledger.
  | {
      readonly step: "opened";
      readonly jobId: JobId;
      readonly providerId: ProviderId;
      readonly quote: Price;
      readonly payFrom: AccountId;
      readonly payTo: AccountId;
      readonly resumed: boolean;
    }
  | { readonly step: "answer"; readonly answer: Answer }
  | { readonly step: "payout"; readonly payout: Payout; readonly quote: Price; readonly jobId: JobId }
  | {
      readonly step: "pay";
      readonly transfer: "called" | "skipped";
      readonly status: "settled" | "pending" | "uncertain" | "rejected";
      readonly amount: Price;
      // The gas the payer paid on top of the amount, in yoctoNEAR, when the rail reports it.
      readonly feeYocto: string | null;
      readonly payer: AccountId;
      readonly recipient: AccountId;
      readonly correlationId: CorrelationId | null;
      readonly key: IdempotencyKey;
      readonly jobId: JobId;
    }
  | {
      readonly step: "pending";
      readonly jobId: JobId;
      readonly why: "payment-pending" | "payment-uncertain";
      readonly correlationId: CorrelationId | null;
    };

export type JobView = { readonly order: Order; readonly state: JobState; readonly events: readonly JobEvent[] };

// What the buyer concluded: the stars, how many checks opened a needed key, could not be verified, or were
// forged, and how many needed keys the shop withheld.
export type Rating = {
  readonly stars: Stars;
  readonly verified: number;
  readonly unproven: number;
  readonly forged: number;
  readonly withheld: number;
};

// onChain is null on a rail with no registry, where the ledger line is the whole record.
export type RateResult =
  | { readonly kind: "recorded" | "unchanged"; readonly onChain: RatingPost | null }
  | { readonly kind: "rejected"; readonly reason: "different-stars" };

export type CounterReply = "accepted" | "refused";

export interface Marketplace {
  listings(): Promise<readonly Listing[]>;
  counter(providerId: ProviderId, offer: Price): Promise<CounterReply>;
  hire(order: Order, onProgress?: (progress: MarketProgress) => void): Promise<HireOutcome>;
  // Writes the stars to the ledger once, then posts the rating on chain where the rail has a registry. Calling it
  // again with the same stars finishes a post that a crash interrupted.
  rate(job: SettledJob, rating: Rating): Promise<RateResult>;
  job(jobId: JobId): Promise<JobView | null>;
}

const HIRE_STEPS = 10;

export function createMarketplace(deps: {
  readonly ledger: Ledger;
  readonly rail: PaymentRail;
  readonly inference: Inference;
  readonly providers: readonly BoundProvider[];
  readonly registry: Registry | null;
  readonly clock: () => IsoTime;
  // The buyer's rule for what a verified delivery is worth, applied once and written to the ledger.
  readonly payout: (opened: { readonly order: Order; readonly quote: Price }, answer: Answer) => Payout;
  // A test hook: called once the delivery is in the ledger, before anything is done with it.
  readonly afterDelivery?: (jobId: JobId) => void;
}): Marketplace {
  const { ledger, rail, inference, providers, registry, clock } = deps;

  return {
    async listings() {
      const read = registry === null ? await fromLedger(ledger) : await fromRegistry(registry, providers);
      return providers.map(({ listing }) => {
        const { id, name, specialty, routingHint, price, owner, payTo, catalog } = listing;
        return { id, name, specialty, routingHint, price, owner, payTo, catalog, ...read(listing) };
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
        const folded = fold(await readOrThrow(ledger, job.jobId));
        if (!folded.ok) throw new LedgerReadError(folded.corrupt);
        if (folded.state.phase === "rated") {
          if (folded.state.rating !== rating.stars) return { kind: "rejected", reason: "different-stars" };
          return { kind: "unchanged", onChain: await post(job, rating) };
        }
        if (folded.state.phase !== "settled") throw new Error("job is not settled");
        await ledger.append(job.jobId, { type: "rated", at: clock(), rating: rating.stars });
        return { kind: "recorded", onChain: await post(job, rating) };
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
      if (order.commitment.status === "missing") return fail(order.jobId, { kind: "no-commitment", providerId: order.providerId });
      if (order.needs.length === 0) return fail(order.jobId, { kind: "no-needs", providerId: order.providerId });
      // A shop whose data no longer seals to the root the buyer pinned could not prove anything against it, so it
      // turns the order down before it delivers. Its own root is used only to refuse, never to verify.
      if (order.commitment.commitment.root !== bound.listing.declared.root) {
        return fail(order.jobId, { kind: "stale-commitment", providerId: order.providerId });
      }
      await ledger.append(order.jobId, { type: "opened", at: clock(), order, quote, payTo: bound.listing.payTo });
      events = await ledger.read(order.jobId);
      onProgress?.(openedProgress(order, quote, bound.listing.payTo, false));
    } else {
      const existing = fold(events);
      if (!existing.ok) return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: existing.corrupt });
      if (!sameOrder(existing.state.order, order)) return fail(order.jobId, { kind: "order-conflict", jobId: order.jobId });
      onProgress?.(openedProgress(order, existing.state.quote, existing.state.payTo, true));
      replay(existing.state, onProgress);
    }

    let transfer: "called" | "skipped" | "none" = "skipped";
    for (let step = 0; step < HIRE_STEPS; step += 1) {
      const folded = fold(events);
      if (!folded.ok) return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: folded.corrupt });
      const state = folded.state;
      const effect = plan(state);
      switch (effect.kind) {
        case "fulfil": {
          const bound = providers.find((item) => item.listing.id === state.order.providerId);
          if (!bound) return fail(order.jobId, { kind: "unknown-provider", providerId: state.order.providerId });
          const toShop = jobOrder(state.order, state.quote);
          if (!toShop) return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: "the open order failed its check" });
          const result = await fulfilQuiet(bound, toShop, inference);
          events = await commit(
            order.jobId,
            result.ok
              ? { type: "delivered", at: clock(), answer: result.answer }
              : { type: "fulfil-failed", at: clock(), reason: result.reason, retryable: result.retryable },
          );
          if (result.ok) {
            deps.afterDelivery?.(order.jobId);
            onProgress?.({ step: "answer", answer: result.answer });
          }
          break;
        }
        case "decide-payout": {
          if (state.phase !== "delivered") return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: "payout before delivery" });
          const payout = deps.payout(state, state.answer);
          events = await commit(order.jobId, { type: "payout-decided", at: clock(), payout });
          onProgress?.({ step: "payout", payout, quote: state.quote, jobId: order.jobId });
          if (toUnits(payout.amount.amount) === 0n) transfer = "none";
          break;
        }
        case "intend-payment": {
          const key = rail.mintKey();
          events = await commit(order.jobId, { type: "payment-intended", at: clock(), key });
          break;
        }
        case "settle": {
          transfer = "called";
          const status = await rail.settle(effect.transfer);
          const paying = { amount: effect.transfer.amount, payer: effect.transfer.payer, recipient: effect.transfer.recipient, jobId: order.jobId };
          if (status.kind === "settled") {
            events = await commit(order.jobId, { type: "payment-settled", at: clock(), receipt: status.receipt });
            onProgress?.({
              step: "pay",
              transfer: "called",
              status: "settled",
              feeYocto: status.receipt.feeYocto,
              correlationId: status.receipt.correlationId,
              key: status.receipt.key,
              ...paying,
            });
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
            onProgress?.({ step: "pay", transfer: "called", status: status.kind, feeYocto: null, correlationId: status.correlationId, key: effect.transfer.key, ...paying });
            onProgress?.({ step: "pending", jobId: order.jobId, why, correlationId: status.correlationId });
            return { kind: "waiting", jobId: order.jobId, why, correlationId: status.correlationId };
          }
          events = await commit(order.jobId, { type: "payment-rejected", at: clock(), reason: status.reason });
          onProgress?.({ step: "pay", transfer: "called", status: "rejected", feeYocto: null, correlationId: null, key: effect.transfer.key, ...paying });
          break;
        }
        case "done": {
          if (state.phase !== "settled" && state.phase !== "rated") {
            return fail(order.jobId, { kind: "corrupt-ledger", jobId: order.jobId, detail: "done before the job settled" });
          }
          return { kind: "settled", job: settledJob(state), transfer: state.settlement.kind === "unpaid" ? "none" : transfer };
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

  // The ledger line comes first, so a crash here loses nothing: the next call finds the job rated and posts again,
  // and the registry answers with the transaction it already signed.
  async function post(job: SettledJob, rating: Rating): Promise<RatingPost | null> {
    if (registry === null) return null;
    let posted: RatingPost;
    try {
      posted = await registry.postRating({
        jobId: job.jobId,
        rater: job.payFrom,
        shop: job.payTo,
        stars: rating.stars,
        payment: job.settlement.kind === "paid" ? job.settlement.receipt.correlationId : null,
        root: job.commitment.status === "published" ? job.commitment.commitment.root : null,
        verified: rating.verified,
        unproven: rating.unproven,
        forged: rating.forged,
        withheld: rating.withheld,
      });
    } catch (error) {
      posted = { kind: "pending", tx: null, detail: error instanceof Error ? error.message : String(error) };
    }
    if (posted.kind === "posted") await ledger.appendIfAbsent(job.jobId, { type: "rating-posted", at: clock(), tx: posted.tx });
    return posted;
  }

  async function commit(jobId: JobId, event: JobEvent): Promise<readonly JobEvent[]> {
    await ledger.append(jobId, event);
    return readOrThrow(ledger, jobId);
  }
}

function fail(jobId: JobId, reason: FailReason): HireOutcome {
  return { kind: "failed", jobId, reason };
}

function openedProgress(order: Order, quote: Price, payTo: AccountId, resumed: boolean): MarketProgress {
  return { step: "opened", jobId: order.jobId, providerId: order.providerId, quote, payFrom: order.payFrom, payTo, resumed };
}

// A resumed job shows what its ledger already holds, in the order it happened, before the next step runs.
function replay(state: JobState, onProgress?: (progress: MarketProgress) => void): void {
  if (!onProgress || state.phase === "awaiting-delivery" || state.phase === "abandoned") return;
  onProgress({ step: "answer", answer: state.answer });
  if (state.phase === "delivered") return;
  onProgress({ step: "payout", payout: state.payout, quote: state.quote, jobId: state.order.jobId });
  if ((state.phase === "settled" || state.phase === "rated") && state.settlement.kind === "paid") {
    const { receipt } = state.settlement;
    onProgress({
      step: "pay",
      transfer: "skipped",
      status: "settled",
      amount: receipt.amount,
      feeYocto: receipt.feeYocto,
      payer: state.order.payFrom,
      recipient: receipt.recipient,
      correlationId: receipt.correlationId,
      key: receipt.key,
      jobId: state.order.jobId,
    });
  }
}

function sameOrder(a: Order, b: Order): boolean {
  return a.jobId === b.jobId
    && a.providerId === b.providerId
    && a.question === b.question
    && canonical(a.needs) === canonical(b.needs)
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

type Standing = Pick<Listing, "reputation" | "commitment">;

// A rail with no chain has only the shop's own statement of its root and this machine's ledger.
async function fromLedger(ledger: Ledger): Promise<(listing: ProviderListing) => Standing> {
  const states = new Map<ProviderId, JobState[]>();
  for (const row of await ledger.all()) {
    const folded = fold(row.events);
    if (!folded.ok) continue;
    const id = folded.state.order.providerId;
    states.set(id, [...states.get(id) ?? [], folded.state]);
  }
  return (listing) => ({
    reputation: reputationOf(states.get(listing.id) ?? []),
    commitment: { status: "published", commitment: listing.declared, source: { kind: "listing" } },
  });
}

async function fromRegistry(
  registry: Registry,
  providers: readonly BoundProvider[],
): Promise<(listing: ProviderListing) => Standing> {
  const [commitments, ratings] = await Promise.all([
    registry.commitments(providers.map((bound) => bound.listing.payTo)),
    registry.ratings(),
  ]);
  return (listing) => {
    const commitment = commitments.get(listing.payTo);
    if (commitment === undefined) throw new Error(`the registry returned nothing for ${listing.payTo}`);
    const stars = ratings.filter((rating) => rating.shop === listing.payTo).map((rating) => rating.stars);
    return { reputation: reputationFromStars(stars, stars.length), commitment };
  };
}

async function fulfilQuiet(
  bound: BoundProvider,
  order: JobOrder,
  inference: Inference,
): Promise<{ ok: true; answer: Answer } | { ok: false; reason: string; retryable: boolean }> {
  try {
    const result = await bound.provider.fulfil(order, { inference });
    if (result.ok && !isStorableAnswer(result.answer)) return { ok: false, reason: "the shop's answer was malformed", retryable: false };
    return result;
  } catch {
    return { ok: false, reason: "provider threw", retryable: true };
  }
}

function jobOrder(order: Order, quote: Price): JobOrder | null {
  const value = { jobId: order.jobId, question: order.question, needs: order.needs, quote };
  return isJobOrder(value) ? value : null;
}

function isJobOrder(value: { question: string; needs: readonly Need[] }): value is JobOrder {
  return value.question.length > 0 && value.needs.length > 0;
}

function settledJob(state: Extract<JobState, { phase: "settled" | "rated" }>): SettledJob {
  return {
    jobId: state.order.jobId,
    providerId: state.order.providerId,
    question: state.order.question,
    needs: state.order.needs,
    payFrom: state.order.payFrom,
    payTo: state.payTo,
    commitment: state.order.commitment,
    quote: state.quote,
    answer: state.answer,
    payout: state.payout,
    settlement: state.settlement,
    rating: state.phase === "rated" ? state.rating : null,
  };
}
