import { z } from "zod";
import {
  fromUnits,
  newTaskId,
  toUnits,
  type AccountId,
  type JobId,
  type Price,
  type ProviderId,
  type Stars,
  type TaskId,
} from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import type { FailReason, Listing, Marketplace, Payout } from "../market/index.ts";
import type { BuyerSeat } from "../roster.ts";
import { oneLine } from "./assess.ts";
import { percentOf, type Decision, type NoDeal, type Percent } from "./decide.ts";
import { tally } from "./grade.ts";
import type { AskOutcome, ConsumerAgent, Progress } from "./index.ts";
import { verifyChecks } from "./verify.ts";

export const MAX_PARTS = 5;

// One self-contained question and the share of the task budget a right answer to it is worth.
export type Part = { readonly question: string; readonly share: Percent };

export type PartOutcome =
  | {
      readonly kind: "bought";
      readonly shop: ProviderId;
      readonly account: AccountId;
      readonly listPrice: Price;
      readonly negotiation: "list-price" | "counter-accepted";
      // The price agreed when the job opened, and what the buyer paid once it had verified the delivery.
      readonly agreed: Price;
      readonly paid: Price;
      readonly payout: Payout["basis"];
      readonly answer: string;
      readonly verified: number;
      readonly mismatches: number;
      readonly unproven: number;
      readonly forged: number;
      readonly withheld: number;
      readonly stars: Stars;
      // Gas for the payment and the rating and SocialDB storage for the rating, in yoctoNEAR, on top of spent.
      // Null on a rail that reports none.
      readonly feesYocto: string | null;
      readonly jobId: JobId;
      // The payment transaction, on a rail that has one on chain.
      readonly tx: string | null;
    }
  | { readonly kind: "answered-locally"; readonly confidence: Percent; readonly answer: string }
  | { readonly kind: "declined"; readonly because: NoDeal["kind"] }
  | { readonly kind: "pending"; readonly jobId: JobId; readonly why: "payment-pending" | "payment-uncertain" }
  | { readonly kind: "failed"; readonly reason: FailReason };

// spent is what left the buyer's wallet for this part, or is held by a payment not yet settled.
export type ReceiptRow = {
  readonly part: Part;
  readonly allotted: Price;
  readonly spent: Price;
  readonly outcome: PartOutcome;
};

export type Receipt = {
  readonly taskId: TaskId;
  readonly task: string;
  readonly budget: Price;
  readonly parts: readonly ReceiptRow[];
  readonly spent: Price;
  readonly left: Price;
  // The sum of every bought part's network fees, in yoctoNEAR. They are paid on top of spent and outside the budget.
  readonly feesYocto: string | null;
};

export type TaskProgress =
  | { readonly step: "plan"; readonly budget: Price; readonly parts: readonly Part[]; readonly bases: readonly Price[] }
  | {
      readonly step: "part";
      readonly index: number;
      readonly count: number;
      readonly part: Part;
      readonly base: Price;
      readonly carried: Price;
      readonly allotted: Price;
    }
  | { readonly step: "part-done"; readonly index: number; readonly count: number; readonly row: ReceiptRow }
  | Progress;

export type TaskOutcome =
  | { readonly kind: "done"; readonly receipt: Receipt }
  | { readonly kind: "unplanned"; readonly detail: string };

const planSchema = z.object({
  parts: z.array(z.object({
    question: z.string().transform(oneLine).pipe(z.string().min(1)),
    share: z.number().positive().finite(),
  })),
});

export async function runTask(
  deps: { readonly inference: Inference; readonly market: Marketplace; readonly ask: ConsumerAgent["ask"] },
  task: string,
  opts: { readonly budget: Price; readonly buyer: BuyerSeat },
  onProgress?: (progress: TaskProgress) => void,
): Promise<TaskOutcome> {
  const { budget } = opts;
  const planned = await deps.inference.run({
    name: "consumer.plan",
    role: "consumer",
    system: planSystem(await deps.market.listings()),
    input: task,
    tools: [],
    parseOutput: parsePlan,
  });
  if (!planned.ok) return { kind: "unplanned", detail: planned.detail };
  const parts = planned.value;
  const budgetUnits = toUnits(budget.amount);
  const bases = splitBudget(budgetUnits, parts.map((part) => part.share));
  onProgress?.({ step: "plan", budget, parts, bases: bases.map((units) => price(budget, units)) });

  const rows: ReceiptRow[] = [];
  const spends: bigint[] = [];
  for (const [index, part] of parts.entries()) {
    const allotted = nextAllotment(bases, spends);
    const base = bases[index] ?? 0n;
    onProgress?.({
      step: "part",
      index,
      count: parts.length,
      part,
      base: price(budget, base),
      carried: price(budget, allotted - base),
      allotted: price(budget, allotted),
    });
    const seen: { decision: Decision | null; held: bigint; fees: bigint | null } = { decision: null, held: 0n, fees: null };
    const addFee = (yocto: bigint): void => {
      seen.fees = (seen.fees ?? 0n) + yocto;
    };
    const outcome = await deps.ask(part.question, { budget: price(budget, allotted), buyer: opts.buyer }, (progress) => {
      if (progress.step === "decide") seen.decision = progress.decision;
      if (progress.step === "pay") seen.held = progress.status === "rejected" ? 0n : toUnits(progress.amount.amount);
      if (progress.step === "pay" && progress.transfer === "called" && progress.feeYocto !== null) addFee(BigInt(progress.feeYocto));
      if (progress.step === "rate" && progress.onChain?.kind === "posted" && progress.onChain.cost !== null) {
        addFee(progress.onChain.cost.gas + progress.onChain.cost.storage);
      }
      onProgress?.(progress);
    });
    const spent = outcome.kind === "outsourced" ? toUnits(outcome.job.payout.amount.amount) : seen.held;
    if (spent > allotted) throw new Error(`part ${index + 1} spent more than its allotment`);
    spends.push(spent);
    const row: ReceiptRow = {
      part,
      allotted: price(budget, allotted),
      spent: price(budget, spent),
      outcome: partOutcome(outcome, seen.decision, seen.fees),
    };
    rows.push(row);
    onProgress?.({ step: "part-done", index, count: parts.length, row });
  }
  const total = spends.reduce((sum, units) => sum + units, 0n);
  if (total > budgetUnits) throw new Error("the task spent more than its budget");
  const fees = rows.flatMap((row) => (row.outcome.kind === "bought" && row.outcome.feesYocto !== null ? [BigInt(row.outcome.feesYocto)] : []));
  return {
    kind: "done",
    receipt: {
      taskId: newTaskId(),
      task,
      budget,
      parts: rows,
      spent: price(budget, total),
      left: price(budget, budgetUnits - total),
      feesYocto: fees.length === 0 ? null : fees.reduce((sum, fee) => sum + fee, 0n).toString(),
    },
  };
}

// Tolerates a fenced or wrapped reply. Fails closed on no parts, too many parts, or a share that is not above zero.
export function parsePlan(raw: string): readonly Part[] | null {
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open === -1 || close < open) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(open, close + 1));
  } catch {
    return null;
  }
  const parsed = planSchema.safeParse(data);
  if (!parsed.success) return null;
  const items = parsed.data.parts;
  if (items.length === 0 || items.length > MAX_PARTS) return null;
  const shares = normaliseShares(items.map((item) => item.share));
  return items.map((item, index) => {
    const share = shares[index];
    if (share === undefined) throw new Error("a part lost its share");
    return { question: item.question, share };
  });
}

// Whole percents that sum to exactly 100, by largest remainder, so the model may answer in fractions or percents.
export function normaliseShares(weights: readonly number[]): Percent[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (weight * 100) / total);
  const whole = exact.map((value) => Math.floor(value));
  const short = 100 - whole.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder.slice(0, short)) whole[index] = (whole[index] ?? 0) + 1;
  return whole.map((value) => {
    const share = percentOf(value / 100);
    if (share === null) throw new Error("a normalised share left the 0 to 100 range");
    return share;
  });
}

// Each part's base is its share of the budget, rounded down; the last part takes the rounding dust so the bases sum to the budget.
export function splitBudget(budget: bigint, shares: readonly Percent[]): bigint[] {
  const bases = shares.map((share) => (budget * BigInt(share)) / 100n);
  const dust = budget - bases.reduce((sum, units) => sum + units, 0n);
  if (bases.length > 0) bases[bases.length - 1] = (bases.at(-1) ?? 0n) + dust;
  return bases;
}

// The next part gets every base so far minus everything spent so far: its own base plus what earlier parts left unspent.
export function nextAllotment(bases: readonly bigint[], spends: readonly bigint[]): bigint {
  const funded = bases.slice(0, spends.length + 1).reduce((sum, units) => sum + units, 0n);
  const spent = spends.reduce((sum, units) => sum + units, 0n);
  const allotment = funded - spent;
  if (allotment < 0n) throw new Error("earlier parts spent more than they were allotted");
  return allotment;
}

function partOutcome(outcome: AskOutcome, decision: Decision | null, fees: bigint | null): PartOutcome {
  switch (outcome.kind) {
    case "local":
      if (decision === null) throw new Error("a local answer came without a decision");
      return { kind: "answered-locally", confidence: decision.local.confidence, answer: outcome.text };
    case "declined":
      if (decision === null || decision.kind !== "decline") throw new Error("a decline came without its decision");
      return { kind: "declined", because: decision.because.kind };
    case "outsourced": {
      if (decision === null || decision.kind !== "buy") throw new Error("a purchase came without its decision");
      const { job } = outcome;
      const counts = tally(verifyChecks(job.answer.checks, job.commitment, job.question, job.needs));
      return {
        kind: "bought",
        shop: job.providerId,
        account: job.payTo,
        listPrice: decision.option.ask,
        negotiation: decision.negotiation,
        agreed: job.quote,
        paid: job.payout.amount,
        payout: job.payout.basis,
        answer: job.answer.text,
        verified: counts.verified,
        mismatches: counts.mismatches,
        unproven: counts.unproven,
        forged: counts.forged,
        withheld: counts.withheld,
        stars: outcome.rating,
        feesYocto: fees === null ? null : fees.toString(),
        jobId: job.jobId,
        tx: job.settlement.kind === "paid" && job.settlement.receipt.rail === "near-testnet" ? job.settlement.receipt.correlationId : null,
      };
    }
    case "pending":
      return { kind: "pending", jobId: outcome.jobId, why: outcome.why };
    case "failed":
      return { kind: "failed", reason: outcome.reason };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

function price(like: Price, units: bigint): Price {
  const amount = fromUnits(units);
  if (amount === null) throw new Error("a task amount went below zero");
  return { ...like, amount };
}

function planSystem(shops: readonly Pick<Listing, "id" | "routingHint">[]): string {
  return [
    "You are a buyer agent with one budget for a whole task. Split the task into parts before any money moves.",
    "Reply with one JSON object and no other text:",
    '{"parts":[{"question":"...","share":0.0}]}',
    `parts: two to ${MAX_PARTS} questions, in the order to work them. Each question must stand on its own, because it is answered or bought without the others.`,
    "share: how much a right answer to that part matters, from 0 to 1. The shares should sum to 1. A part's share of the budget is the most the buyer will pay for it.",
    "Shops that sell answers from private data:",
    ...shops.map((shop) => `${shop.id} | ${shop.routingHint}`),
  ].join("\n");
}
