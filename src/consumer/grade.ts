import { isStars, type Stars } from "../domain.ts";
import type { Answer } from "../providers/types.ts";

export function grade(answer: Answer): Stars {
  const score = answer.checks.length === 0
    ? 3
    : Math.max(1, 5 - answer.checks.filter((check) => check.verdict === "mismatch").length);
  if (!isStars(score)) throw new Error("grade left the 1..5 range");
  return score;
}
