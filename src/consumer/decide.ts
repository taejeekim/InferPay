import { z } from "zod";
import { compareSameAsset, isProviderId, type Price, type ProviderId } from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import type { Listing } from "../market/index.ts";

export type Decision =
  | { readonly kind: "answer-locally"; readonly reason: string }
  | { readonly kind: "outsource"; readonly providerId: ProviderId; readonly reason: string }
  | { readonly kind: "decline"; readonly reason: string };

const routeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer-locally"), reason: z.string().min(1) }),
  z.object({ kind: z.literal("decline"), reason: z.string().min(1) }),
  z.object({ kind: z.literal("outsource"), providerId: z.string().min(1), reason: z.string().min(1) }),
]);

export async function decide(
  inference: Inference,
  question: string,
  listings: readonly Listing[],
  budget: Price,
): Promise<{ readonly ok: true; readonly decision: Decision } | { readonly ok: false; readonly detail: string }> {
  const affordable = listings.filter((listing) => {
    const cmp = compareSameAsset(listing.price, budget);
    return cmp === -1 || cmp === 0;
  });
  if (affordable.length === 0) {
    return { ok: true, decision: { kind: "decline", reason: declineReason(listings, budget) } };
  }
  const result = await inference.run({
    name: "consumer.route",
    role: "consumer",
    system: routeSystem(affordable),
    input: question,
    tools: [],
    parseOutput: (raw) => parseDecision(raw, affordable),
  });
  if (!result.ok) return { ok: false, detail: result.detail };
  return { ok: true, decision: result.value };
}

function parseDecision(raw: string, affordable: readonly Listing[]): Decision | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = routeSchema.safeParse(data);
  if (!parsed.success) return null;
  if (parsed.data.kind !== "outsource") return parsed.data;
  const providerId = parsed.data.providerId;
  if (!isProviderId(providerId) || !affordable.some((listing) => listing.id === providerId)) {
    return { kind: "decline", reason: "The routed provider is outside the budget." };
  }
  return { kind: "outsource", providerId, reason: parsed.data.reason };
}

function declineReason(listings: readonly Listing[], budget: Price): string {
  const sameAsset = listings.filter((listing) => listing.price.asset === budget.asset);
  const pool = sameAsset.length > 0 ? sameAsset : listings;
  const first = pool[0];
  if (!first) return `No provider is priced in ${budget.symbol}.`;
  const cheapest = pool.reduce((best, listing) => (
    compareSameAsset(listing.price, best.price) === -1 ? listing : best
  ), first);
  return `Cheapest fitting provider costs ${cheapest.price.amount} ${cheapest.price.symbol}, budget is ${budget.amount} ${budget.symbol}.`;
}

function routeSystem(listings: readonly Listing[]): string {
  const lines = listings.map((listing) => {
    const reputation = listing.reputation.kind === "unrated"
      ? `${listing.reputation.completedJobs} completed jobs, unrated`
      : `${listing.reputation.completedJobs} completed jobs, average ${listing.reputation.average.toFixed(1)} from ${listing.reputation.ratings} ratings`;
    return `${listing.id} | ${listing.price.amount} ${listing.price.symbol} | ${reputation} | ${listing.routingHint}`;
  });
  return [
    "Choose who answers the question.",
    "Reply with one JSON object and no other text.",
    'Use {"kind":"outsource","providerId":"...","reason":"..."}, {"kind":"answer-locally","reason":"..."}, or {"kind":"decline","reason":"..."}.',
    "Outsource when a listed provider holds filed figures you do not.",
    "Providers:",
    ...lines,
  ].join("\n");
}
