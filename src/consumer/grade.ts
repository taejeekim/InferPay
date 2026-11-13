import { isStars, type Stars } from "../domain.ts";
import type { BuyerCheck } from "./verify.ts";

export type Tally = {
  readonly verified: number;
  readonly mismatches: number;
  readonly unproven: number;
  // Unproven checks that are claims the shop cited and could not back, as opposed to a flag it says stayed clear.
  readonly unbacked: number;
  readonly forged: number;
};

export function tally(checks: readonly BuyerCheck[]): Tally {
  const unproven = checks.filter((check) => check.status === "unproven");
  return {
    verified: checks.filter((check) => check.status === "verified").length,
    mismatches: checks.filter((check) => check.status === "verified" && check.verdict === "mismatch").length,
    unproven: unproven.length,
    unbacked: unproven.filter((check) => check.check.verdict !== "clear").length,
    forged: checks.filter((check) => check.status === "forged").length,
  };
}

// Forged evidence is the one thing a shop cannot do by accident, so it sets the lowest rating whatever else is true.
// A cited claim the shop does not back costs the same star as a proven mismatch, so withholding an entry never
// beats proving it. A raised flag is the shop doing its job and a clear one is unprovable, so neither moves the
// score, and an answer with nothing verified cannot rate above the middle.
export function grade(checks: readonly BuyerCheck[]): Stars {
  const counts = tally(checks);
  let score = 5 - counts.mismatches - counts.unbacked;
  if (counts.verified === 0) score = Math.min(score, 3);
  if (counts.forged > 0) score = 1;
  score = Math.max(1, score);
  if (!isStars(score)) throw new Error("grade left the 1..5 range");
  return score;
}
