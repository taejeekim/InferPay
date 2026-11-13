// The verdict rules both sides run. A shop applies them to its private entry; a buyer applies them again to the
// entry the shop proved, so a verdict never rests on the shop's word.

export type Figure = {
  readonly kind: "figure";
  readonly company: string;
  readonly period: string;
  readonly metric: string;
  readonly value: number;
  readonly unit: string;
  readonly source: string;
};

export type Fact = {
  readonly kind: "fact";
  readonly topic: string;
  readonly value: string;
  readonly source: string;
};

export type Rule = {
  readonly kind: "rule";
  readonly id: string;
  // Regular expression sources, matched without regard to case. The rule hits a clause that matches every one.
  readonly all: readonly string[];
  readonly label: string;
  readonly detail: string;
};

export type Entry = Figure | Fact | Rule;

export type FigureClaim = {
  readonly label: string;
  readonly company: string;
  readonly period: string;
  readonly metric: string;
  readonly claimed: number;
  readonly unit: string;
};

export type FactClaim = {
  readonly label: string;
  readonly topic: string;
  readonly claimed: string;
};

export type ClauseClaim = {
  readonly label: string;
  readonly text: string;
};

/**
 * Percent points, not a fraction. 0.05 means 0.05 percent, which is 5 basis points.
 * A claim 0.12 percent away from the filed figure is a mismatch.
 */
export const TOLERANCE_PCT = 0.05;

const SCALES: Readonly<Record<string, number>> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

export function sameFigure(claim: FigureClaim, entry: Figure): boolean {
  return words(entry.company) === words(claim.company)
    && words(entry.period) === words(claim.period)
    && words(entry.metric) === words(claim.metric);
}

export type FigureVerdict =
  | { readonly verdict: "match" }
  | { readonly verdict: "mismatch"; readonly deltaPct: number }
  // The two units have different bases, so no tolerance applies.
  | { readonly verdict: "unverifiable" };

export function judgeFigure(claim: FigureClaim, entry: Figure): FigureVerdict {
  const claimed = scaled(claim.claimed, claim.unit);
  const reference = scaled(entry.value, entry.unit);
  if (!claimed || !reference || claimed.unit !== reference.unit) return { verdict: "unverifiable" };
  const deltaPct = percentDelta(claimed.value, reference.value);
  if (Math.abs(deltaPct) <= TOLERANCE_PCT) return { verdict: "match" };
  return { verdict: "mismatch", deltaPct };
}

export function sameTopic(claim: FactClaim, entry: Fact): boolean {
  return entry.topic.toLowerCase() === claim.topic.toLowerCase();
}

export function judgeFact(claim: FactClaim, entry: Fact): "match" | "mismatch" {
  return stated(entry.value) === stated(claim.claimed) ? "match" : "mismatch";
}

export function ruleHits(rule: Rule, text: string): boolean {
  if (rule.all.length === 0) return false;
  try {
    return rule.all.every((source) => new RegExp(source, "i").test(text));
  } catch {
    return false;
  }
}

function words(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function stated(value: string): string {
  return value.trim().toLowerCase().replace(/\s*(%|percent)$/, "").replace(/\s+/g, " ");
}

function scaled(value: number, unit: string): { value: number; unit: string } | null {
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
