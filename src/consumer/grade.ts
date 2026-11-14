import { isStars, type Stars } from "../domain.ts";
import type { BuyerCheck } from "./verify.ts";

// The grading rule, in the one place that applies it. Only the keys the buyer named before paying count.
// A withheld key costs more than a proven mismatch, so hiding an entry always rates below showing it. A rule
// that raises or clears the clause is the legal shop doing its job, so both back the answer.
export const RULE = {
  start: 5,
  perMismatch: 1,
  perEmpty: 1,
  perWithheld: 2,
  // An answer that no needed key backs is worth little whatever else the shop sent.
  withoutBacking: 2,
  forged: 1,
} as const;

export type Tally = {
  // Checks that opened a needed key, in or against the answer's favour.
  readonly verified: number;
  // Needed keys opened in the answer's favour: a match, or a rule raised or cleared on the needed clause.
  readonly backing: number;
  readonly mismatches: number;
  // Needed keys the shop listed in its catalog and then proved it holds nothing for.
  readonly empty: number;
  readonly withheld: number;
  readonly unrequested: number;
  readonly unproven: number;
  readonly forged: number;
};

export type Grade = {
  readonly stars: Stars;
  readonly tally: Tally;
  // The score before the cap, the floor, and forgery, as start minus the costs.
  readonly score: number;
  readonly capped: boolean;
};

export function tally(checks: readonly BuyerCheck[]): Tally {
  const verified = checks.filter((check) => check.status === "verified");
  const count = (status: BuyerCheck["status"]): number => checks.filter((check) => check.status === status).length;
  return {
    verified: verified.length,
    backing: verified.filter((check) => check.verdict === "match" || check.verdict === "raised" || check.verdict === "clear").length,
    mismatches: verified.filter((check) => check.verdict === "mismatch").length,
    empty: verified.filter((check) => check.verdict === "absent").length,
    withheld: count("withheld"),
    unrequested: count("unrequested"),
    unproven: count("unproven"),
    forged: count("forged"),
  };
}

export function grade(checks: readonly BuyerCheck[]): Grade {
  const counts = tally(checks);
  const score = RULE.start
    - RULE.perMismatch * counts.mismatches
    - RULE.perEmpty * counts.empty
    - RULE.perWithheld * counts.withheld;
  const capped = counts.backing === 0 && score > RULE.withoutBacking;
  const stars = counts.forged > 0 ? RULE.forged : Math.max(1, capped ? RULE.withoutBacking : score);
  if (!isStars(stars)) throw new Error("grade left the 1..5 range");
  return { stars, tally: counts, score, capped };
}
