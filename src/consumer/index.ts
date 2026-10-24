import { newJobId, type JobId, type Price, type Stars } from "../domain.ts";
import type { BuyerSeat } from "../roster.ts";
import type { Inference } from "../inference/index.ts";
import type { CompletedJob, FailReason, HireOutcome, MarketProgress, Marketplace } from "../market/index.ts";
import type { Answer } from "../providers/types.ts";
import { decide, type Decision } from "./decide.ts";
import { grade } from "./grade.ts";

export type { Decision } from "./decide.ts";

export type Progress =
  | { readonly step: "decide"; readonly decision: Decision }
  | { readonly step: "rate"; readonly rating: Stars; readonly answer: Answer }
  | MarketProgress;

export type AskOutcome =
  | { readonly kind: "local"; readonly text: string; readonly reason: string }
  | { readonly kind: "outsourced"; readonly job: CompletedJob; readonly rating: Stars }
  | { readonly kind: "declined"; readonly reason: string }
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
      const routed = await decide(inference, question, listings, budget);
      if (!routed.ok) return { kind: "failed", reason: { kind: "inference", detail: routed.detail } };
      onProgress?.({ step: "decide", decision: routed.decision });
      if (routed.decision.kind === "answer-locally") return answerLocally(inference, question, routed.decision);
      if (routed.decision.kind === "decline") return { kind: "declined", reason: routed.decision.reason };
      const outcome = await market.hire(
        { jobId: newJobId(), providerId: routed.decision.providerId, question, budget, payFrom: buyer.account },
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

export async function answerLocally(
  inference: Inference,
  question: string,
  decision: { readonly reason: string },
): Promise<AskOutcome> {
  const result = await inference.run({
    name: "consumer.answer",
    role: "consumer",
    system: "Answer from general knowledge. If the question needs a filed figure, say you do not hold it.",
    input: question,
    tools: [],
    parseOutput: (raw) => {
      const text = raw.trim();
      if (text.length === 0) return null;
      return { text };
    },
  });
  if (!result.ok) return { kind: "failed", reason: { kind: "inference", detail: result.detail } };
  return { kind: "local", text: result.value.text, reason: decision.reason };
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
  if (job.rating !== null) {
    onProgress?.({ step: "rate", rating: job.rating, answer: job.answer });
    return job.rating;
  }
  const rating = grade(job.answer);
  await market.rate(job, rating);
  onProgress?.({ step: "rate", rating, answer: job.answer });
  return rating;
}
