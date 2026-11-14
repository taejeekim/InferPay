import {
  answersNeed,
  catalogName,
  entryKey,
  needKey,
  ruleHits,
  sameKey,
  type AssertedCheck,
  type Dataset,
  type Entry,
  type Need,
} from "../commitment/index.ts";

// The shop's code opens every key the buyer needed that its model's checks left out, so a model that forgets one
// cannot make an honest shop look like it withheld it.
export function openNeeds<E extends Entry>(checks: readonly AssertedCheck[], needs: readonly Need[], data: Dataset<E>): readonly AssertedCheck[] {
  const missed = needs.filter((need) => !checks.some((check) => answersNeed(check, need)));
  return [...checks, ...missed.flatMap((need) => openNeed(need, data))];
}

function openNeed<E extends Entry>(need: Need, data: Dataset<E>): AssertedCheck[] {
  const key = needKey(need);
  const entry = data.entries.find((candidate) => sameKey(entryKey(candidate), key));
  if (need.kind === "rule") {
    const claim = { label: need.id, text: need.clause, rule: need.id };
    if (entry?.kind === "rule") {
      return [{ kind: "flag", claim, verdict: ruleHits(entry, need.clause) ? "raised" : "clear", evidence: data.prove(entry) }];
    }
    return [{ kind: "flag", claim, verdict: "unverifiable", evidence: data.proveAbsent(key) }];
  }
  if (entry) return [{ kind: "opening", key, verdict: "opened", evidence: data.prove(entry) }];
  const vacancy = data.proveAbsent(key);
  return vacancy === null ? [] : [{ kind: "opening", key, verdict: "unverifiable", evidence: vacancy }];
}

export function needsPrompt(needs: readonly Need[]): string {
  if (needs.length === 0) return "";
  const named = needs.map((need) => (need.kind === "rule" ? `${need.id} on "${need.clause}"` : catalogName(need)));
  return `The buyer pays only for the keys you open, and needs each one in your tool call: ${named.join("; ")}.`;
}
