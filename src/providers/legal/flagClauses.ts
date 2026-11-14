import { z } from "zod";
import {
  clauseClaimSchema,
  ruleHits,
  ruleKey,
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

// Each clause is tested against the one rule it names, and that rule's slot is opened whatever the verdict.
export function flagClauses(clauses: readonly ClauseClaim[], playbook: Dataset<Rule>): readonly AssertedCheck[] {
  return clauses.map((claim) => {
    const rule = playbook.entries.find((entry) => entry.id === claim.rule);
    if (!rule) return { kind: "flag", claim, verdict: "unverifiable", evidence: playbook.proveAbsent(ruleKey({ id: claim.rule })) };
    return { kind: "flag", claim, verdict: ruleHits(rule, claim.text) ? "raised" : "clear", evidence: playbook.prove(rule) };
  });
}
