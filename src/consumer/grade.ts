import { isStars, type Stars } from "../domain.ts";
import type { Answer, Check } from "../providers/types.ts";

export function grade(answer: Answer): Stars {
  const score = answer.checks.length === 0
    ? 3
    : Math.max(1, 5 - answer.checks.filter(penalizes).length);
  if (!isStars(score)) throw new Error("grade left the 1..5 range");
  return score;
}

// A raised flag is a specialist doing its job, so only a mismatch counts against the answer.
function penalizes(check: Check): boolean {
  return check.verdict === "mismatch";
}
