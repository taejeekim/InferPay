import { formatUnits, fromUnits, newJobId, toUnits, type JobId, type Price, type Stars } from "../domain.ts";
import type { BuyerSeat } from "../roster.ts";
import type { Inference } from "../inference/index.ts";
import { reserveTotal, type FailReason, type FeeReserve, type HireOutcome, type MarketProgress, type Marketplace, type Order, type SettledJob } from "../market/index.ts";
import { yoctoToUnits } from "../payment/units.ts";
import type { RatingPost } from "../registry/index.ts";
import type { Need, PinnedCommitment } from "../commitment/index.ts";
import { assess, type Needs } from "./assess.ts";
import { decide, settleCounter, type Decision } from "./decide.ts";
import { grade, type Grade } from "./grade.ts";
import { verifyChecks, type BuyerCheck } from "./verify.ts";
import { runTask, type TaskOutcome, type TaskProgress } from "./task.ts";

export { LOCAL_FLOOR } from "./decide.ts";
export type { Decision, Option, PricedOption } from "./decide.ts";
export type { Dropped, Needs } from "./assess.ts";

export type Progress =
  | { readonly step: "reserve"; readonly budget: Price; readonly reserve: FeeReserve; readonly left: Price }
  // reserved is true when a fee reserve came out of the budget before the decision.
  | { readonly step: "decide"; readonly decision: Decision; readonly needs: Needs; readonly reserved: boolean }
  | { readonly step: "verify"; readonly checks: readonly BuyerCheck[]; readonly needs: readonly Need[]; readonly commitment: PinnedCommitment }
  | {
      readonly step: "rate";
      readonly grade: Grade;
      readonly jobId: JobId;
      // Where the rating went on chain, or null on a rail that keeps it only in the local ledger.
      readonly onChain: RatingPost | null;
    }
  | MarketProgress;

// Everything the question took from the bot's wallet, or holds in a payment not yet settled. fees is measured from
// the chain where it could be, and is the reserved bound where it could not, so it never understates.
export type Spend = {
  readonly budget: Price;
  readonly price: Price;
  readonly fees: Price;
  readonly total: Price;
  readonly reserve: Price;
  // True when some fee was not measured and its reserved bound stands in for it.
  readonly bounded: boolean;
};

export type AskOutcome =
  | { readonly kind: "local"; readonly text: string; readonly spend: Spend }
  | { readonly kind: "outsourced"; readonly job: SettledJob; readonly rating: Stars; readonly spend: Spend }
  | { readonly kind: "declined"; readonly spend: Spend }
  | { readonly kind: "pending"; readonly jobId: JobId; readonly why: "payment-pending" | "payment-uncertain"; readonly spend: Spend }
  // spend is null only when resume found no job, so there is no budget to count against.
  | { readonly kind: "failed"; readonly reason: FailReason; readonly spend: Spend | null };

export interface ConsumerAgent {
  ask(
    question: string,
    opts: { readonly budget: Price; readonly buyer: BuyerSeat },
    onProgress?: (progress: Progress) => void,
  ): Promise<AskOutcome>;
  resume(jobId: JobId, onProgress?: (progress: Progress) => void): Promise<AskOutcome>;
  task(
    task: string,
    opts: { readonly budget: Price; readonly buyer: BuyerSeat },
    onProgress?: (progress: TaskProgress) => void,
  ): Promise<TaskOutcome>;
}

export function createConsumerAgent(deps: { readonly market: Marketplace; readonly inference: Inference }): ConsumerAgent {
  const { market, inference } = deps;
  const agent: ConsumerAgent = {
    task: (task, opts, onProgress) => runTask({ inference, market, ask: agent.ask }, task, opts, onProgress),
    async ask(question, { budget, buyer }, onProgress) {
      const nothing = spent(budget, null, { price: 0n, fees: 0n, bounded: false });
      const listings = await market.listings();
      const assessed = await assess(inference, question, listings);
      if (!assessed.ok) return { kind: "failed", reason: { kind: "inference", detail: assessed.detail }, spend: nothing };
      const reserve = await market.feeReserve(buyer.account);
      const reserveUnits = yoctoToUnits(reserveTotal(reserve));
      const budgetUnits = toUnits(budget.amount);
      const left = reserveUnits === 0n ? budget : priced(budget, reserveUnits < budgetUnits ? budgetUnits - reserveUnits : 0n);
      onProgress?.({ step: "reserve", budget, reserve, left });
      const plan = decide({ value: left, assessment: assessed.assessment, listings });
      const decision = plan.kind === "counter"
        ? settleCounter(plan, await market.counter(plan.option.providerId, plan.offer))
        : plan;
      onProgress?.({ step: "decide", decision, needs: assessed.needs, reserved: reserveUnits > 0n });
      if (decision.kind === "answer-locally") return { kind: "local", text: decision.local.answer, spend: nothing };
      if (decision.kind === "decline") return { kind: "declined", spend: nothing };
      const providerId = decision.option.providerId;
      const listing = listings.find((item) => item.id === providerId);
      if (!listing) return { kind: "failed", reason: { kind: "unknown-provider", providerId }, spend: nothing };
      const order: Order = {
        jobId: newJobId(),
        providerId,
        question,
        needs: assessed.needs.byShop.get(providerId) ?? [],
        offer: decision.agreed,
        budget,
        reserve,
        payFrom: buyer.account,
        commitment: listing.commitment,
      };
      return finish(market, order, await market.hire(order, withVerification(order, onProgress)), onProgress);
    },
    async resume(jobId, onProgress) {
      const view = await market.job(jobId);
      if (view === null) {
        return { kind: "failed", reason: { kind: "unknown-job", jobId }, spend: null };
      }
      return finish(market, view.order, await market.hire(view.order, withVerification(view.order, onProgress)), onProgress);
    },
  };
  return agent;
}

async function finish(market: Marketplace, order: Order, outcome: HireOutcome, onProgress?: (progress: Progress) => void): Promise<AskOutcome> {
  const reserve = order.reserve;
  switch (outcome.kind) {
    case "settled": {
      const { job } = outcome;
      const { stars, onChain } = await publishRating(market, job, onProgress);
      const paymentFee = job.settlement.kind === "unpaid" ? { yocto: 0n, bounded: false } : feeOr(job.settlement.receipt.feeYocto, reserve.paymentGas, job.settlement.receipt.rail);
      const ratingFee = ratingCost(onChain, reserve);
      const spend = spent(order.budget, order, {
        price: toUnits(job.payout.amount.amount),
        fees: paymentFee.yocto + ratingFee.yocto,
        bounded: paymentFee.bounded || ratingFee.bounded,
      });
      return { kind: "outsourced", job, rating: stars, spend };
    }
    case "waiting": {
      const view = await market.job(outcome.jobId);
      const held = view !== null && "payout" in view.state ? toUnits(view.state.payout.amount.amount) : toUnits(order.offer.amount);
      return { kind: "pending", jobId: outcome.jobId, why: outcome.why, spend: spent(order.budget, order, { price: held, fees: reserveTotal(reserve), bounded: true }) };
    }
    case "failed": {
      // A transfer rejected on chain can still have burnt its gas.
      const fees = outcome.reason.kind === "payment-rejected" ? BigInt(reserve.paymentGas) : 0n;
      return { kind: "failed", reason: outcome.reason, spend: spent(order.budget, order, { price: 0n, fees, bounded: fees > 0n }) };
    }
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

// The receipt's fee where the rail measured one; the reserved bound on a rail that moves NEAR and did not report it.
function feeOr(measured: string | null, bound: string, rail: string): { yocto: bigint; bounded: boolean } {
  if (measured !== null) return { yocto: BigInt(measured), bounded: false };
  return rail === "mock" ? { yocto: 0n, bounded: false } : { yocto: BigInt(bound), bounded: true };
}

function ratingCost(onChain: RatingPost | null, reserve: FeeReserve): { yocto: bigint; bounded: boolean } {
  if (onChain === null) return { yocto: 0n, bounded: false };
  if (onChain.kind === "posted" && onChain.cost !== null) return { yocto: onChain.cost.gas + onChain.cost.storage, bounded: false };
  return { yocto: BigInt(reserve.ratingGas) + BigInt(reserve.ratingStorage), bounded: true };
}

// Every outflow is checked against the budget here, the one place an ask's spending is totalled.
function spent(budget: Price, order: Order | null, amounts: { price: bigint; fees: bigint; bounded: boolean }): Spend {
  const like = budget;
  const fees = yoctoToUnits(amounts.fees);
  const total = amounts.price + fees;
  if (total > toUnits(budget.amount)) {
    throw new Error(`the question spent ${formatUnits(total)} ${budget.symbol}, above its ${budget.amount} ${budget.symbol} budget`);
  }
  return {
    budget: like,
    price: priced(like, amounts.price),
    fees: priced(like, fees),
    total: priced(like, total),
    reserve: priced(like, order === null ? 0n : yoctoToUnits(reserveTotal(order.reserve))),
    bounded: amounts.bounded,
  };
}

function priced(like: Price, units: bigint): Price {
  const amount = fromUnits(units);
  if (amount === null) throw new Error("an amount went below zero");
  return { ...like, amount };
}

// The buyer verifies a delivery as soon as it is in hand, so its checks print before the payout they decide.
function withVerification(order: Order, onProgress?: (progress: Progress) => void): (progress: MarketProgress) => void {
  return (progress) => {
    onProgress?.(progress);
    if (progress.step !== "answer") return;
    const checks = verifyChecks(progress.answer.checks, order.commitment, order.question, order.needs);
    onProgress?.({ step: "verify", checks, needs: order.needs, commitment: order.commitment });
  };
}

async function publishRating(
  market: Marketplace,
  job: SettledJob,
  onProgress?: (progress: Progress) => void,
): Promise<{ stars: Stars; onChain: RatingPost | null }> {
  const graded = grade(verifyChecks(job.answer.checks, job.commitment, job.question, job.needs));
  const rating = job.rating ?? graded.stars;
  const { verified, unproven, forged, withheld } = graded.tally;
  // Rating again is how a resumed job finishes an on-chain post that a crash interrupted.
  const rated = await market.rate(job, { stars: rating, verified, unproven, forged, withheld });
  const onChain = rated.kind === "rejected" ? null : rated.onChain;
  onProgress?.({ step: "rate", grade: graded, jobId: job.jobId, onChain });
  return { stars: rating, onChain };
}
