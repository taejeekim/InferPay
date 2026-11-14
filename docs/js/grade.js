// The grading rule of src/consumer/grade.ts and the lines src/cli/render.ts prints for it, over the results of
// verifyChecks in scheme.js. src/site/scheme.test.ts holds both to the TypeScript.

import { field, line } from "./decide.js";

export const RULE = { start: 5, perMismatch: 1, perEmpty: 1, perUnclaimed: 1, perWithheld: 2, floor: 2, forged: 1 };

export function tally(results) {
  const verified = results.filter((result) => result.status === "verified");
  const count = (status) => results.filter((result) => result.status === status).length;
  return {
    verified: verified.length,
    mismatches: verified.filter((result) => result.verdict === "mismatch").length,
    empty: verified.filter((result) => result.verdict === "absent").length,
    unclaimed: verified.filter((result) => result.verdict === "opened").length,
    withheld: count("withheld"),
    unrequested: count("unrequested"),
    unproven: count("unproven"),
    forged: count("forged"),
  };
}

export function grade(results) {
  const counts = tally(results);
  const score = RULE.start
    - RULE.perMismatch * counts.mismatches
    - RULE.perEmpty * counts.empty
    - RULE.perUnclaimed * counts.unclaimed
    - RULE.perWithheld * counts.withheld;
  const stars = counts.forged > 0 ? RULE.forged : Math.max(RULE.floor, score);
  return { stars, tally: counts, score };
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function rateText({ stars, tally: counts, score }) {
  if (counts.forged > 0) return `${stars}/5  forged evidence sets the rating to ${RULE.forged}`;
  const costs = [
    counts.mismatches > 0 ? `${RULE.perMismatch} x ${plural(counts.mismatches, "mismatch", "mismatches")}` : null,
    counts.empty > 0 ? `${RULE.perEmpty} x ${counts.empty} empty` : null,
    counts.unclaimed > 0 ? `${RULE.perUnclaimed} x ${counts.unclaimed} no claim` : null,
    counts.withheld > 0 ? `${RULE.perWithheld} x ${counts.withheld} withheld` : null,
  ].filter((cost) => cost !== null);
  const sum = costs.length === 0 ? `= ${RULE.start}` : `= ${RULE.start} - ${costs.join(" - ")} = ${score}`;
  if (score < RULE.floor) return `${stars}/5  ${sum}, and an honest delivery rates at least ${RULE.floor}`;
  return `${stars}/5  ${sum}`;
}

// The rate block the CLI prints, up to where it says where the rating went.
export function rateLines(graded) {
  return [
    line("rate", rateText(graded)),
    field("rule", `start at ${RULE.start}; for each key the buyer needed, -${RULE.perMismatch} per mismatch, -${RULE.perEmpty} per empty slot,`),
    field("", `-${RULE.perUnclaimed} per key opened with no claim, -${RULE.perWithheld} per key withheld;`),
    field("", `at least ${RULE.floor} unless a check is forged, and ${RULE.forged} if any check is forged;`),
    field("", "checks the buyer did not ask for never count"),
  ];
}
