import type { Brand } from "../domain.ts";
import {
  answersNeed,
  entryKey,
  judgeFact,
  judgeFigure,
  opensTo,
  quotedFrom,
  ruleHits,
  sameKey,
  subjectKey,
  type AssertedCheck,
  type ClauseClaim,
  type Entry,
  type Fact,
  type FactClaim,
  type Figure,
  type FigureClaim,
  type Hash,
  type Key,
  type Membership,
  type Need,
  type Path,
  type PinnedCommitment,
  type Rule,
} from "../commitment/index.ts";

// The entry a check rests on, with the salt and sibling path that walked it to the committed root.
type Proven<E> = { readonly entry: E; readonly salt: Hash; readonly path: Path };

// A verdict the buyer computed itself, from the slot of the check's key in the tree the shop committed to. The
// slot either holds an entry, which gives match, mismatch, raised, clear, or opened, or is empty, which gives absent.
export type VerifiedCheck = Brand<
  | ({ readonly status: "verified"; readonly kind: "number"; readonly claim: FigureClaim; readonly verdict: "match" } & Proven<Figure>)
  | ({ readonly status: "verified"; readonly kind: "number"; readonly claim: FigureClaim; readonly verdict: "mismatch"; readonly deltaPct: number } & Proven<Figure>)
  | { readonly status: "verified"; readonly kind: "number"; readonly claim: FigureClaim; readonly verdict: "absent"; readonly path: Path }
  | ({ readonly status: "verified"; readonly kind: "fact"; readonly claim: FactClaim; readonly verdict: "match" | "mismatch" } & Proven<Fact>)
  | { readonly status: "verified"; readonly kind: "fact"; readonly claim: FactClaim; readonly verdict: "absent"; readonly path: Path }
  | ({ readonly status: "verified"; readonly kind: "flag"; readonly claim: ClauseClaim; readonly verdict: "raised" | "clear" } & Proven<Rule>)
  | { readonly status: "verified"; readonly kind: "flag"; readonly claim: ClauseClaim; readonly verdict: "absent"; readonly path: Path }
  // The shop opened a needed slot and its model made no claim about it: the buyer holds the entry, and the answer
  // gains nothing from it.
  | ({ readonly status: "verified"; readonly kind: "opening"; readonly key: Key; readonly verdict: "opened" } & Proven<Entry>)
  | { readonly status: "verified"; readonly kind: "opening"; readonly key: Key; readonly verdict: "absent"; readonly path: Path },
  "VerifiedCheck"
>;

// A check that verified but answers no key the buyer needed. It is shown and never counts for the shop.
export type UnrequestedCheck = { readonly status: "unrequested"; readonly verified: VerifiedCheck };

// A key the buyer needed that no verified check opened.
export type WithheldNeed = { readonly status: "withheld"; readonly need: Need };

// The shop's word with nothing behind it. It sent no proof, it never published a root, or it flagged a clause
// the buyer did not ask about.
export type UnprovenCheck = {
  readonly status: "unproven";
  readonly check: AssertedCheck;
  readonly why: "no-proof" | "no-commitment" | "unquoted";
};

export type Forgery =
  | { readonly kind: "no-evidence" }
  | { readonly kind: "wrong-root"; readonly opensTo: Hash | null; readonly committed: Hash }
  | { readonly kind: "wrong-entry" }
  | { readonly kind: "wrong-verdict"; readonly recomputed: "match" | "mismatch" | "unverifiable" | "raised" | "clear" };

export type ForgedCheck = {
  readonly status: "forged";
  readonly check: AssertedCheck;
  readonly forgery: Forgery;
};

export type BuyerCheck = VerifiedCheck | UnrequestedCheck | WithheldNeed | UnprovenCheck | ForgedCheck;

// Every check the shop sent, in its order, then each needed key that no verified check opened. The buyer fixed
// its needs before it paid, so the shop cannot choose which of its keys get looked at.
export function verifyChecks(
  checks: readonly AssertedCheck[],
  pinned: PinnedCommitment,
  question: string,
  needs: readonly Need[],
): readonly BuyerCheck[] {
  const results = checks.map((check) => ({ check, result: verifyCheck(check, pinned, question) }));
  const opened = (need: Need): boolean => results.some(({ check, result }) => result.status === "verified" && answersNeed(check, need));
  return [
    ...results.map(({ check, result }): BuyerCheck => (
      result.status === "verified" && !needs.some((need) => answersNeed(check, need)) ? { status: "unrequested", verified: result } : result
    )),
    ...needs.filter((need) => !opened(need)).map((need): WithheldNeed => ({ status: "withheld", need })),
  ];
}

function verifyCheck(check: AssertedCheck, pinned: PinnedCommitment, question: string): VerifiedCheck | UnprovenCheck | ForgedCheck {
  if (pinned.status === "missing") return { status: "unproven", check, why: "no-commitment" };
  const committed = pinned.commitment.root;
  const { evidence } = check;

  if (check.verdict === "unverifiable") {
    if (evidence === null || !("vacant" in evidence)) return { status: "unproven", check, why: "no-proof" };
    const opened = opensTo(subjectKey(check), evidence);
    if (opened !== committed) return forged(check, { kind: "wrong-root", opensTo: opened, committed });
    const { path } = evidence;
    switch (check.kind) {
      case "number":
        return verified({ status: "verified", kind: "number", claim: check.claim, verdict: "absent", path });
      case "fact":
        return verified({ status: "verified", kind: "fact", claim: check.claim, verdict: "absent", path });
      case "flag":
        return verified({ status: "verified", kind: "flag", claim: check.claim, verdict: "absent", path });
      case "opening":
        return verified({ status: "verified", kind: "opening", key: check.key, verdict: "absent", path });
      default: {
        const unreachable: never = check;
        return unreachable;
      }
    }
  }

  if (evidence === null || "vacant" in evidence) return forged(check, { kind: "no-evidence" });
  const { entry, salt, path } = evidence;
  if (!sameKey(entryKey(entry), subjectKey(check))) return forged(check, { kind: "wrong-entry" });
  const miss = missesRoot(check, evidence, committed);
  if (miss) return miss;
  switch (check.kind) {
    case "number": {
      if (entry.kind !== "figure") return forged(check, { kind: "wrong-entry" });
      const judged = judgeFigure(check.claim, entry);
      if (judged.verdict !== check.verdict) return forged(check, { kind: "wrong-verdict", recomputed: judged.verdict });
      if (judged.verdict === "match") return verified({ status: "verified", kind: "number", claim: check.claim, verdict: "match", entry, salt, path });
      return verified({ status: "verified", kind: "number", claim: check.claim, verdict: "mismatch", deltaPct: judged.deltaPct, entry, salt, path });
    }
    case "fact": {
      if (entry.kind !== "fact") return forged(check, { kind: "wrong-entry" });
      const verdict = judgeFact(check.claim, entry);
      if (verdict !== check.verdict) return forged(check, { kind: "wrong-verdict", recomputed: verdict });
      return verified({ status: "verified", kind: "fact", claim: check.claim, verdict, entry, salt, path });
    }
    case "flag": {
      if (entry.kind !== "rule") return forged(check, { kind: "wrong-entry" });
      if (!quotedFrom(question, check.claim.text)) return { status: "unproven", check, why: "unquoted" };
      const verdict = ruleHits(entry, check.claim.text) ? "raised" : "clear";
      if (verdict !== check.verdict) return forged(check, { kind: "wrong-verdict", recomputed: verdict });
      return verified({ status: "verified", kind: "flag", claim: check.claim, verdict, entry, salt, path });
    }
    case "opening":
      return verified({ status: "verified", kind: "opening", key: check.key, verdict: "opened", entry, salt, path });
    default: {
      const unreachable: never = check;
      return unreachable;
    }
  }
}

// The slot comes from the entry's own key, which the caller has already matched to the check.
function missesRoot(check: AssertedCheck, evidence: Membership, committed: Hash): ForgedCheck | null {
  const opened = opensTo(entryKey(evidence.entry), evidence);
  return opened === committed ? null : forged(check, { kind: "wrong-root", opensTo: opened, committed });
}

function forged(check: AssertedCheck, forgery: Forgery): ForgedCheck {
  return { status: "forged", check, forgery };
}

type Unbranded<T> = T extends Brand<infer Inner, "VerifiedCheck"> ? Inner : never;

function verified(check: Unbranded<VerifiedCheck>): VerifiedCheck {
  return check as VerifiedCheck;
}
