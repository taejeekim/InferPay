import { z } from "zod";
import {
  figureClaimSchema,
  figureKey,
  judgeFigure,
  sameKey,
  type AssertedCheck,
  type Dataset,
  type Figure,
  type FigureClaim,
} from "../../commitment/index.ts";

export function parseClaims(raw: unknown): readonly FigureClaim[] | null {
  const parsed = z.object({ claims: z.array(figureClaimSchema) }).safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.claims;
}

export function crossValidate(claims: readonly FigureClaim[], data: Dataset<Figure>): readonly AssertedCheck[] {
  return claims.map((claim) => {
    const key = figureKey(claim);
    const fact = data.entries.find((entry) => sameKey(key, figureKey(entry)));
    if (!fact) return { kind: "number", claim, verdict: "unverifiable", evidence: data.proveAbsent(key) };
    const { verdict } = judgeFigure(claim, fact);
    if (verdict === "unverifiable") return { kind: "number", claim, verdict, evidence: null };
    return { kind: "number", claim, verdict, evidence: data.prove(fact) };
  });
}
