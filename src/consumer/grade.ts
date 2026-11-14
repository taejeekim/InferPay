import { isStars, type Stars } from "../domain.ts";
import type { BuyerCheck } from "./verify.ts";

// The grading rule, in the one place that applies it. Only the keys the buyer named before paying count.
// A withheld key costs more than a proven mismatch, and an honest delivery never falls to the rating a forgery
// gets, so for any number of needed keys: all proven in the answer's favour > one honest mismatch > one key
// withheld > anything forged. A needed key opened with no claim costs the same as a mismatch, so swapping a wrong
// claim for a bare opening gains nothing.
export const RULE = {
  start: 5,
  perMismatch: 1,
  perEmpty: 1,
  perUnclaimed: 1,
  perWithheld: 2,
  floor: 2,
  forged: 1,
} as const;

export type Tally = {
  // Checks that opened a needed key, in or against the answer's favour.
  readonly verified: number;
  readonly mismatches: number;
  // Needed keys the shop listed in its catalog and then proved it holds nothing for.
  readonly empty: number;
  // Needed keys the shop opened while its answer made no claim about them.
  readonly unclaimed: number;
  readonly withheld: number;
  readonly unrequested: number;
  readonly unproven: number;
  readonly forged: number;
};

export type Grade = {
  readonly stars: Stars;
  readonly tally: Tally;
  // The score before the floor and forgery, as start minus the costs.
  readonly score: number;
};

export function tally(checks: readonly BuyerCheck[]): Tally {
  const verified = checks.filter((check) => check.status === "verified");
  const count = (status: BuyerCheck["status"]): number => checks.filter((check) => check.status === status).length;
  return {
    verified: verified.length,
    mismatches: verified.filter((check) => check.verdict === "mismatch").length,
    empty: verified.filter((check) => check.verdict === "absent").length,
    unclaimed: verified.filter((check) => check.verdict === "opened").length,
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
    - RULE.perUnclaimed * counts.unclaimed
    - RULE.perWithheld * counts.withheld;
  const stars = counts.forged > 0 ? RULE.forged : Math.max(RULE.floor, score);
  if (!isStars(stars)) throw new Error("grade left the 1..5 range");
  return { stars, tally: counts, score };
}
