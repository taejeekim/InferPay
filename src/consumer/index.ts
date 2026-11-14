import { newJobId, type JobId, type Price, type Stars } from "../domain.ts";
import type { BuyerSeat } from "../roster.ts";
import type { Inference } from "../inference/index.ts";
import type { FailReason, HireOutcome, MarketProgress, Marketplace, Order, SettledJob } from "../market/index.ts";
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
  | { readonly step: "decide"; readonly decision: Decision; readonly needs: Needs }
  | { readonly step: "verify"; readonly checks: readonly BuyerCheck[]; readonly needs: readonly Need[]; readonly commitment: PinnedCommitment }
  | {
      readonly step: "rate";
      readonly grade: Grade;
      readonly jobId: JobId;
      // Where the rating went on chain, or null on a rail that keeps it only in the local ledger.
      readonly onChain: RatingPost | null;
    }
  | MarketProgress;

export type AskOutcome =
  | { readonly kind: "local"; readonly text: string }
  | { readonly kind: "outsourced"; readonly job: SettledJob; readonly rating: Stars }
  | { readonly kind: "declined" }
  | { readonly kind: "pending"; readonly jobId: JobId; readonly why: "payment-pending" | "payment-uncertain" }
  | { readonly kind: "failed"; readonly reason: FailReason };

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
      const listings = await market.listings();
      const assessed = await assess(inference, question, listings);
      if (!assessed.ok) return { kind: "failed", reason: { kind: "inference", detail: assessed.detail } };
      const plan = decide({ value: budget, assessment: assessed.assessment, listings });
      const decision = plan.kind === "counter"
        ? settleCounter(plan, await market.counter(plan.option.providerId, plan.offer))
        : plan;
      onProgress?.({ step: "decide", decision, needs: assessed.needs });
      if (decision.kind === "answer-locally") return { kind: "local", text: decision.local.answer };
      if (decision.kind === "decline") return { kind: "declined" };
      const providerId = decision.option.providerId;
      const listing = listings.find((item) => item.id === providerId);
      if (!listing) return { kind: "failed", reason: { kind: "unknown-provider", providerId } };
      const order: Order = {
        jobId: newJobId(),
        providerId,
        question,
        needs: assessed.needs.byShop.get(providerId) ?? [],
        offer: decision.agreed,
        budget,
        payFrom: buyer.account,
        commitment: listing.commitment,
      };
      const outcome = await market.hire(order, withVerification(order, onProgress));
      if (outcome.kind !== "settled") return fromUnfinished(outcome);
      const rating = await publishRating(market, outcome.job, onProgress);
      return { kind: "outsourced", job: outcome.job, rating };
    },
    async resume(jobId, onProgress) {
      const view = await market.job(jobId);
      if (view === null) return { kind: "failed", reason: { kind: "unknown-job", jobId } };
      const outcome = await market.hire(view.order, withVerification(view.order, onProgress));
      if (outcome.kind !== "settled") return fromUnfinished(outcome);
      const rating = await publishRating(market, outcome.job, onProgress);
      return { kind: "outsourced", job: outcome.job, rating };
    },
  };
  return agent;
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

export function fromUnfinished(outcome: Exclude<HireOutcome, { kind: "settled" }>): AskOutcome {
  switch (outcome.kind) {
    case "waiting":
      return { kind: "pending", jobId: outcome.jobId, why: outcome.why };
    case "failed":
      return { kind: "failed", reason: outcome.reason };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

async function publishRating(
  market: Marketplace,
  job: SettledJob,
  onProgress?: (progress: Progress) => void,
): Promise<Stars> {
  const graded = grade(verifyChecks(job.answer.checks, job.commitment, job.question, job.needs));
  const rating = job.rating ?? graded.stars;
  const { verified, unproven, forged, withheld } = graded.tally;
  // Rating again is how a resumed job finishes an on-chain post that a crash interrupted.
  const rated = await market.rate(job, { stars: rating, verified, unproven, forged, withheld });
  onProgress?.({ step: "rate", grade: graded, jobId: job.jobId, onChain: rated.kind === "rejected" ? null : rated.onChain });
  return rating;
}
