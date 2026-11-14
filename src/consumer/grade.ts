import { isStars, type Stars } from "../domain.ts";
import type { BuyerCheck } from "./verify.ts";

export type Tally = {
  readonly verified: number;
  readonly mismatches: number;
  readonly unproven: number;
  readonly forged: number;
  // Verified checks that back the answer: a match, a mismatch the shop owned up to, or a raised or clear flag.
  readonly supporting: number;
  // Claims the shop cited and did not back: a key it proved it holds nothing for, or a verdict with no proof.
  readonly unbacked: number;
};

export function tally(checks: readonly BuyerCheck[]): Tally {
  const verified = checks.filter((check) => check.status === "verified");
  const unproven = checks.filter((check) => check.status === "unproven");
  const absent = verified.filter((check) => check.verdict === "absent").length;
  return {
    verified: verified.length,
    mismatches: verified.filter((check) => check.verdict === "mismatch").length,
    unproven: unproven.length,
    forged: checks.filter((check) => check.status === "forged").length,
    supporting: verified.length - absent,
    unbacked: absent + unproven.length,
  };
}

// Forged evidence is the one thing a shop cannot do by accident, so it sets the lowest rating whatever else is true.
// A cited claim the shop does not back costs the same star as a proven mismatch, so withholding an entry never
// beats proving it. A raised or clear flag is the shop doing its job, so neither moves the score, and an answer
// with nothing verified in its favour cannot rate above the middle.
export function grade(checks: readonly BuyerCheck[]): Stars {
  const counts = tally(checks);
  let score = 5 - counts.mismatches - counts.unbacked;
  if (counts.supporting === 0) score = Math.min(score, 3);
  if (counts.forged > 0) score = 1;
  score = Math.max(1, score);
  if (!isStars(score)) throw new Error("grade left the 1..5 range");
  return score;
}
