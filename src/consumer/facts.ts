import { answersNeed, ruleHits, type Entry, type Need } from "../commitment/index.ts";
import type { BuyerCheck } from "./verify.ts";

// What the buyer relies on: for each needed key, only an entry it verified against the committed root. The shop's
// prose and its claims never reach here, so a summary that misstates an entry cannot change a fact.
export type ProvenFact =
  | { readonly need: Need; readonly kind: "entry"; readonly entry: Exclude<Entry, { kind: "rule" }> }
  // For a playbook rule, the buyer tests the proven rule against the clause it quoted itself.
  | { readonly need: Need; readonly kind: "rule"; readonly entry: Extract<Entry, { kind: "rule" }>; readonly applies: boolean }
  | { readonly need: Need; readonly kind: "empty" }
  | { readonly need: Need; readonly kind: "unproven" };

export function provenFacts(checks: readonly BuyerCheck[], needs: readonly Need[]): readonly ProvenFact[] {
  return needs.map((need): ProvenFact => {
    const check = checks.find((item) => item.status === "verified" && answersNeed(item, need));
    if (check === undefined || check.status !== "verified") return { need, kind: "unproven" };
    if (check.verdict === "absent") return { need, kind: "empty" };
    const { entry } = check;
    if (entry.kind !== "rule") return { need, kind: "entry", entry };
    return { need, kind: "rule", entry, applies: need.kind === "rule" && ruleHits(entry, need.clause) };
  });
}
