import { z } from "zod";
import type { FactCheck } from "../types.ts";
import type { CoverageFact } from "./schedule.ts";

type ClaimedFact = {
  readonly label: string;
  readonly topic: string;
  readonly claimed: string;
};

const claimSchema = z.object({
  label: z.string(),
  topic: z.string(),
  claimed: z.string(),
});

export function parseFactClaims(raw: unknown): readonly ClaimedFact[] | null {
  const parsed = z.object({ claims: z.array(claimSchema) }).safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.claims;
}

export function parseFactChecks(raw: unknown): readonly FactCheck[] | null {
  const parsed = z.array(z.object({
    kind: z.literal("fact"),
    verdict: z.enum(["match", "mismatch", "unverifiable"]),
    label: z.string(),
    claimed: z.string(),
    reference: z.string().optional(),
    source: z.string().optional(),
  })).safeParse(raw);
  if (!parsed.success) return null;
  const checks: FactCheck[] = [];
  for (const check of parsed.data) {
    if (check.verdict === "unverifiable") {
      checks.push({ kind: "fact", verdict: "unverifiable", label: check.label, claimed: check.claimed });
      continue;
    }
    if (check.verdict === "match" && check.source !== undefined) {
      checks.push({
        kind: "fact",
        verdict: "match",
        label: check.label,
        claimed: check.claimed,
        source: check.source,
      });
      continue;
    }
    if (check.verdict === "mismatch" && check.reference !== undefined && check.source !== undefined) {
      checks.push({
        kind: "fact",
        verdict: "mismatch",
        label: check.label,
        claimed: check.claimed,
        reference: check.reference,
        source: check.source,
      });
      continue;
    }
    return null;
  }
  return checks;
}

export function lookupCoverage(
  claims: readonly ClaimedFact[],
  facts: readonly CoverageFact[],
): readonly FactCheck[] {
  return claims.map((claim) => {
    const fact = facts.find((item) => item.topic.toLowerCase() === claim.topic.toLowerCase());
    if (!fact) {
      return { kind: "fact", verdict: "unverifiable", label: claim.label, claimed: claim.claimed };
    }
    if (norm(fact.value) === norm(claim.claimed)) {
      return {
        kind: "fact",
        verdict: "match",
        label: claim.label,
        claimed: claim.claimed,
        source: fact.source,
      };
    }
    return {
      kind: "fact",
      verdict: "mismatch",
      label: claim.label,
      claimed: claim.claimed,
      reference: fact.value,
      source: fact.source,
    };
  });
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s*(%|percent)$/, "").replace(/\s+/g, " ");
}
