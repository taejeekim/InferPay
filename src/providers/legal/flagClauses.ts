import { z } from "zod";
import {
  clauseClaimSchema,
  ruleHits,
  type AssertedCheck,
  type ClauseClaim,
  type Dataset,
  type Rule,
} from "../../commitment/index.ts";

export function parseClauses(raw: unknown): readonly ClauseClaim[] | null {
  const parsed = z.object({ clauses: z.array(clauseClaimSchema) }).safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.clauses;
}

export function flagClauses(clauses: readonly ClauseClaim[], playbook: Dataset<Rule>): readonly AssertedCheck[] {
  return clauses.map((claim) => {
    const hit = playbook.entries.find((rule) => ruleHits(rule, claim.text));
    if (!hit) return { kind: "flag", claim, verdict: "clear", evidence: null };
    return { kind: "flag", claim, verdict: "raised", evidence: playbook.prove(hit) };
  });
}
