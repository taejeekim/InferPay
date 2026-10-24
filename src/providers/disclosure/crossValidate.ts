import { z } from "zod";
import type { NumberCheck } from "../types.ts";

export type DisclosureFact = {
  readonly company: string;
  readonly period: string;
  readonly metric: string;
  readonly value: number;
  readonly unit: string;
  readonly source: string;
};

type ClaimedFigure = {
  readonly label: string;
  readonly company: string;
  readonly period: string;
  readonly metric: string;
  readonly claimed: number;
  readonly unit: string;
};

/**
 * Percent points, not a fraction. 0.05 means 0.05 percent, which is 5 basis points.
 * A claim 0.13 percent away from the filed figure is a mismatch.
 */
export const TOLERANCE_PCT = 0.05;

const SCALES: Readonly<Record<string, number>> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

const claimSchema = z.object({
  label: z.string(),
  company: z.string(),
  period: z.string(),
  metric: z.string(),
  claimed: z.number(),
  unit: z.string(),
});

const checkSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("match"), label: z.string(), claimed: z.number(), unit: z.string(), source: z.string() }),
  z.object({
    verdict: z.literal("mismatch"),
    label: z.string(),
    claimed: z.number(),
    unit: z.string(),
    reference: z.number(),
    deltaPct: z.number(),
    source: z.string(),
  }),
  z.object({ verdict: z.literal("unverifiable"), label: z.string(), claimed: z.number(), unit: z.string() }),
]);

export function parseClaims(raw: unknown): readonly ClaimedFigure[] | null {
  const parsed = z.object({ claims: z.array(claimSchema) }).safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.claims;
}

export function parseChecks(raw: unknown): readonly NumberCheck[] | null {
  const parsed = z.array(checkSchema).safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

export function crossValidate(
  claims: readonly ClaimedFigure[],
  facts: readonly DisclosureFact[],
  tolerancePct: number,
): readonly NumberCheck[] {
  return claims.map((claim) => checkOne(claim, facts, tolerancePct));
}

function checkOne(
  claim: ClaimedFigure,
  facts: readonly DisclosureFact[],
  tolerancePct: number,
): NumberCheck {
  const fact = facts.find((item) => sameKey(item, claim));
  if (!fact) {
    return { verdict: "unverifiable", label: claim.label, claimed: claim.claimed, unit: claim.unit };
  }
  const claimed = normalize(claim.claimed, claim.unit);
  const reference = normalize(fact.value, fact.unit);
  if (!claimed || !reference || claimed.unit !== reference.unit) {
    return { verdict: "unverifiable", label: claim.label, claimed: claim.claimed, unit: claim.unit };
  }
  const delta = percentDelta(claimed.value, reference.value);
  if (Math.abs(delta) <= tolerancePct) {
    return {
      verdict: "match",
      label: claim.label,
      claimed: claim.claimed,
      unit: claim.unit,
      source: fact.source,
    };
  }
  return {
    verdict: "mismatch",
    label: claim.label,
    claimed: claim.claimed,
    unit: claim.unit,
    reference: fact.value,
    deltaPct: delta,
    source: fact.source,
  };
}

function sameKey(fact: DisclosureFact, claim: ClaimedFigure): boolean {
  return norm(fact.company) === norm(claim.company)
    && norm(fact.period) === norm(claim.period)
    && norm(fact.metric) === norm(claim.metric);
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalize(value: number, unit: string): { value: number; unit: string } | null {
  if (!Number.isFinite(value)) return null;
  const tokens = unit.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  let scale = 1;
  const base: string[] = [];
  for (const token of tokens) {
    const factor = SCALES[token];
    if (factor === undefined) base.push(token);
    else scale *= factor;
  }
  return { value: value * scale, unit: base.join(" ") };
}

function percentDelta(claimed: number, reference: number): number {
  if (reference === 0) return claimed === 0 ? 0 : Number.POSITIVE_INFINITY;
  return ((claimed - reference) / reference) * 100;
}
