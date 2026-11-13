import { compareSameAsset, fromUnits, toUnits, type Brand, type Price, type ProviderId } from "../domain.ts";
import type { CounterReply, Listing, Reputation } from "../market/index.ts";

// A probability in whole percent. Whole numbers keep the money arithmetic exact, and the two digits printed are the two digits used.
export type Percent = Brand<number, "Percent">;

// An unrated shop is trusted like one that averages 3.8 stars. The prior counts as two ratings, so a third real rating outweighs it.
const PRIOR_QUALITY = 0.7;
const PRIOR_RATINGS = 2;

// The buyer answers on its own only when it is more likely right than wrong.
export const LOCAL_FLOOR = 50;

export type SelfAssessment = {
  readonly answer: string;
  readonly confidence: Percent;
  readonly missing: readonly string[];
  readonly coverage: ReadonlyMap<ProviderId, Percent>;
};

// Amounts are in units of 1e-18 of the budget's asset, as toUnits gives them.
export type PricedOption = {
  readonly kind: "priced";
  readonly providerId: ProviderId;
  readonly ask: Price;
  readonly coverage: Percent;
  readonly reputation: Percent;
  readonly quality: Percent;
  readonly net: bigint;
  // The price at which buying is worth exactly as much as answering locally.
  readonly reservation: bigint;
};

export type Option =
  | PricedOption
  | { readonly kind: "unaffordable"; readonly providerId: ProviderId; readonly ask: Price };

export type NoDeal =
  | { readonly kind: "nothing-affordable" }
  | { readonly kind: "no-coverage" }
  | { readonly kind: "no-price-worth-paying"; readonly option: PricedOption }
  | { readonly kind: "counter-refused"; readonly option: PricedOption; readonly offer: Price };

type Analysis = {
  readonly value: Price;
  readonly local: {
    readonly answer: string;
    readonly confidence: Percent;
    readonly worth: bigint;
    readonly missing: readonly string[];
  };
  readonly options: readonly Option[];
};

export type Plan = Analysis & (
  | {
      readonly kind: "buy";
      readonly option: PricedOption;
      readonly agreed: Price;
      readonly negotiation: "list-price" | "counter-accepted";
    }
  | { readonly kind: "counter"; readonly option: PricedOption; readonly offer: Price }
  | { readonly kind: "answer-locally"; readonly because: NoDeal }
  | { readonly kind: "decline"; readonly because: NoDeal }
);

export type CounterPlan = Extract<Plan, { kind: "counter" }>;
export type Decision = Exclude<Plan, { kind: "counter" }>;

export function decide(input: {
  readonly value: Price;
  readonly assessment: SelfAssessment;
  readonly listings: readonly Pick<Listing, "id" | "price" | "reputation">[];
}): Plan {
  const { value, assessment } = input;
  const valueUnits = toUnits(value.amount);
  const worth = portion(assessment.confidence, valueUnits);
  const priced: PricedOption[] = [];
  const unaffordable: Option[] = [];
  for (const listing of input.listings) {
    const fits = compareSameAsset(listing.price, value);
    if (fits === "different-asset" || fits === 1) {
      unaffordable.push({ kind: "unaffordable", providerId: listing.id, ask: listing.price });
      continue;
    }
    const coverage = assessment.coverage.get(listing.id) ?? NO_COVERAGE;
    const reputation = reputationQuality(listing.reputation);
    const quality = percent(Math.round((coverage * reputation) / 100));
    const gross = portion(quality, valueUnits);
    priced.push({
      kind: "priced",
      providerId: listing.id,
      ask: listing.price,
      coverage,
      reputation,
      quality,
      net: gross - toUnits(listing.price.amount),
      reservation: gross - worth,
    });
  }
  // A tie in net goes to the lower ask, which puts less money at risk, and then to listing order.
  const candidates = priced
    .filter((option) => option.coverage > 0)
    .sort((a, b) => order(b.net, a.net) || order(toUnits(a.ask.amount), toUnits(b.ask.amount)));
  const analysis: Analysis = {
    value,
    local: { answer: assessment.answer, confidence: assessment.confidence, worth, missing: assessment.missing },
    options: [...candidates, ...priced.filter((option) => option.coverage === 0), ...unaffordable],
  };

  if (priced.length === 0) return withoutDeal(analysis, { kind: "nothing-affordable" });
  const best = candidates[0];
  if (!best) return withoutDeal(analysis, { kind: "no-coverage" });
  if (best.net >= worth) return { ...analysis, kind: "buy", option: best, agreed: best.ask, negotiation: "list-price" };
  const counter = best.reservation > 0n ? fromUnits(best.reservation) : null;
  if (counter === null) return withoutDeal(analysis, { kind: "no-price-worth-paying", option: best });
  return { ...analysis, kind: "counter", option: best, offer: { ...value, amount: counter } };
}

export function settleCounter(plan: CounterPlan, reply: CounterReply): Decision {
  const analysis: Analysis = { value: plan.value, local: plan.local, options: plan.options };
  if (reply === "accepted") {
    return { ...analysis, kind: "buy", option: plan.option, agreed: plan.offer, negotiation: "counter-accepted" };
  }
  return withoutDeal(analysis, { kind: "counter-refused", option: plan.option, offer: plan.offer });
}

export function percentOf(share: number): Percent | null {
  if (!(share >= 0 && share <= 1)) return null;
  return percent(Math.round(share * 100));
}

function withoutDeal(analysis: Analysis, because: NoDeal): Decision {
  if (analysis.local.confidence >= LOCAL_FLOOR) return { ...analysis, kind: "answer-locally", because };
  return { ...analysis, kind: "decline", because };
}

function reputationQuality(reputation: Reputation): Percent {
  const ratings = reputation.kind === "rated" ? reputation.ratings : 0;
  const starQuality = reputation.kind === "rated" ? (reputation.average - 1) / 4 : 0;
  const smoothed = (PRIOR_RATINGS * PRIOR_QUALITY + ratings * starQuality) / (PRIOR_RATINGS + ratings);
  return percent(Math.round(smoothed * 100));
}

function portion(share: Percent, units: bigint): bigint {
  return (BigInt(share) * units) / 100n;
}

function order(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function percent(value: number): Percent {
  if (!isPercent(value)) throw new Error("a probability left the 0 to 100 range");
  return value;
}

function isPercent(value: number): value is Percent {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

const NO_COVERAGE = percent(0);
