import { z } from "zod";
import {
  factClaimSchema,
  factKey,
  judgeFact,
  sameKey,
  type AssertedCheck,
  type Dataset,
  type Fact,
  type FactClaim,
} from "../../commitment/index.ts";

export function parseFactClaims(raw: unknown): readonly FactClaim[] | null {
  const parsed = z.object({ claims: z.array(factClaimSchema) }).safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.claims;
}

export function lookupCoverage(claims: readonly FactClaim[], data: Dataset<Fact>): readonly AssertedCheck[] {
  return claims.map((claim) => {
    const key = factKey(claim);
    const fact = data.entries.find((entry) => sameKey(key, factKey(entry)));
    if (!fact) return { kind: "fact", claim, verdict: "unverifiable", evidence: data.proveAbsent(key) };
    return { kind: "fact", claim, verdict: judgeFact(claim, fact), evidence: data.prove(fact) };
  });
}
