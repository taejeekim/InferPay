import { fromUnits, toUnits, type Price } from "../domain.ts";
import { answersNeed } from "../commitment/index.ts";
import type { Order, Payout } from "../market/index.ts";
import type { Answer } from "../providers/types.ts";
import { verifyChecks } from "./verify.ts";

// The payout rule, in the one place that applies it. Nothing is paid when any check is forged. Otherwise the buyer
// pays the agreed price times the share of needed keys the shop opened to an entry the buyer verified, rounded
// down to the smallest unit. A mismatch counts as opened, because the buyer learned the true value. An empty slot
// does not: a shop could list keys it holds nothing for and be paid for proving so.
export function payoutFor(job: { readonly order: Order; readonly quote: Price }, answer: Answer): Payout {
  const { order, quote } = job;
  const results = verifyChecks(answer.checks, order.commitment, order.question, order.needs);
  const forged = results.filter((result) => result.status === "forged").length;
  if (forged > 0) return { amount: priced(quote, 0n), basis: { kind: "forged", forged } };
  const needed = order.needs.length;
  if (needed === 0) throw new Error("a job with no needed key has nothing to pay for");
  // verifyChecks returns the shop's checks first, in the order sent, so results[index] is the verdict on checks[index].
  const proven = order.needs.filter((need) => answer.checks.some((check, index) => {
    const result = results[index];
    return result?.status === "verified" && result.verdict !== "absent" && answersNeed(check, need);
  })).length;
  return { amount: priced(quote, (toUnits(quote.amount) * BigInt(proven)) / BigInt(needed)), basis: { kind: "share", proven, needed } };
}

function priced(like: Price, units: bigint): Price {
  const amount = fromUnits(units);
  if (amount === null) throw new Error("a payout went below zero");
  return { ...like, amount };
}
