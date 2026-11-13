import { newJobId, type JobId, type Price, type Stars } from "../domain.ts";
import type { BuyerSeat } from "../roster.ts";
import type { Inference } from "../inference/index.ts";
import type { CompletedJob, FailReason, HireOutcome, MarketProgress, Marketplace } from "../market/index.ts";
import type { PinnedCommitment } from "../commitment/index.ts";
import { assess } from "./assess.ts";
import { decide, settleCounter, type Decision } from "./decide.ts";
import { grade } from "./grade.ts";
import { verifyChecks, type BuyerCheck } from "./verify.ts";

export { LOCAL_FLOOR } from "./decide.ts";
export type { Decision, Option, PricedOption } from "./decide.ts";

export type Progress =
  | { readonly step: "decide"; readonly decision: Decision }
  | { readonly step: "verify"; readonly checks: readonly BuyerCheck[]; readonly commitment: PinnedCommitment }
  | { readonly step: "rate"; readonly rating: Stars; readonly checks: readonly BuyerCheck[] }
  | MarketProgress;

export type AskOutcome =
  | { readonly kind: "local"; readonly text: string }
  | { readonly kind: "outsourced"; readonly job: CompletedJob; readonly rating: Stars }
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
}

export function createConsumerAgent(deps: { readonly market: Marketplace; readonly inference: Inference }): ConsumerAgent {
  const { market, inference } = deps;
  return {
    async ask(question, { budget, buyer }, onProgress) {
      const listings = await market.listings();
      const assessed = await assess(inference, question, listings);
      if (!assessed.ok) return { kind: "failed", reason: { kind: "inference", detail: assessed.detail } };
      const plan = decide({ value: budget, assessment: assessed.assessment, listings });
      const decision = plan.kind === "counter"
        ? settleCounter(plan, await market.counter(plan.option.providerId, plan.offer))
        : plan;
      onProgress?.({ step: "decide", decision });
      if (decision.kind === "answer-locally") return { kind: "local", text: decision.local.answer };
      if (decision.kind === "decline") return { kind: "declined" };
      const providerId = decision.option.providerId;
      const listing = listings.find((item) => item.id === providerId);
      if (!listing) return { kind: "failed", reason: { kind: "unknown-provider", providerId } };
      const outcome = await market.hire(
        {
          jobId: newJobId(),
          providerId,
          question,
          offer: decision.agreed,
          budget,
          payFrom: buyer.account,
          commitment: listing.commitment,
        },
        (progress) => onProgress?.(progress),
      );
      if (outcome.kind !== "completed") return fromUnfinished(outcome);
      const rating = await publishRating(market, outcome.job, onProgress);
      return { kind: "outsourced", job: outcome.job, rating };
    },
    async resume(jobId, onProgress) {
      const view = await market.job(jobId);
      if (view === null) return { kind: "failed", reason: { kind: "unknown-job", jobId } };
      const outcome = await market.hire(view.order, (progress) => onProgress?.(progress));
      if (outcome.kind !== "completed") return fromUnfinished(outcome);
      const rating = await publishRating(market, outcome.job, onProgress);
      return { kind: "outsourced", job: outcome.job, rating };
    },
  };
}

export function fromUnfinished(outcome: Exclude<HireOutcome, { kind: "completed" }>): AskOutcome {
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
  job: CompletedJob,
  onProgress?: (progress: Progress) => void,
): Promise<Stars> {
  const checks = verifyChecks(job.answer.checks, job.commitment);
  onProgress?.({ step: "verify", checks, commitment: job.commitment });
  const rating = job.rating ?? grade(checks);
  if (job.rating === null) await market.rate(job, rating);
  onProgress?.({ step: "rate", rating, checks });
  return rating;
}
