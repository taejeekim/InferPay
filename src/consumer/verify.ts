import type { Brand } from "../domain.ts";
import {
  entryKey,
  factKey,
  figureKey,
  judgeFact,
  judgeFigure,
  opensTo,
  quotedFrom,
  ruleHits,
  sameKey,
  type AssertedCheck,
  type ClauseClaim,
  type Fact,
  type FactClaim,
  type Figure,
  type FigureClaim,
  type Hash,
  type Membership,
  type Path,
  type PinnedCommitment,
  type Rule,
} from "../commitment/index.ts";

// The entry a check rests on, with the salt and sibling path that walked it to the committed root.
type Proven<E> = { readonly entry: E; readonly salt: Hash; readonly path: Path };

// A verdict the buyer computed itself, from the slot of the claim's key in the tree the shop committed to. The
// slot either holds an entry, which gives match, mismatch, or raised, or is empty, which gives absent.
export type VerifiedCheck = Brand<
  | ({ readonly status: "verified"; readonly kind: "number"; readonly claim: FigureClaim; readonly verdict: "match" } & Proven<Figure>)
  | ({ readonly status: "verified"; readonly kind: "number"; readonly claim: FigureClaim; readonly verdict: "mismatch"; readonly deltaPct: number } & Proven<Figure>)
  | { readonly status: "verified"; readonly kind: "number"; readonly claim: FigureClaim; readonly verdict: "absent"; readonly path: Path }
  | ({ readonly status: "verified"; readonly kind: "fact"; readonly claim: FactClaim; readonly verdict: "match" | "mismatch" } & Proven<Fact>)
  | { readonly status: "verified"; readonly kind: "fact"; readonly claim: FactClaim; readonly verdict: "absent"; readonly path: Path }
  | ({ readonly status: "verified"; readonly kind: "flag"; readonly claim: ClauseClaim; readonly verdict: "raised" } & Proven<Rule>),
  "VerifiedCheck"
>;

// The shop's word with nothing behind it. It sent no proof, it never published a root, or it raised a flag on
// a clause the buyer did not ask about.
export type UnprovenCheck = {
  readonly status: "unproven";
  readonly check: AssertedCheck;
  readonly why: "no-proof" | "no-commitment" | "unquoted";
};

export type Forgery =
  | { readonly kind: "no-evidence" }
  | { readonly kind: "wrong-root"; readonly opensTo: Hash | null; readonly committed: Hash }
  | { readonly kind: "wrong-entry" }
  | { readonly kind: "wrong-verdict"; readonly recomputed: "match" | "mismatch" | "unverifiable" | "clear" };

export type ForgedCheck = {
  readonly status: "forged";
  readonly check: AssertedCheck;
  readonly forgery: Forgery;
};

export type BuyerCheck = VerifiedCheck | UnprovenCheck | ForgedCheck;

export function verifyChecks(checks: readonly AssertedCheck[], pinned: PinnedCommitment, question: string): readonly BuyerCheck[] {
  return checks.map((check) => verifyCheck(check, pinned, question));
}

function verifyCheck(check: AssertedCheck, pinned: PinnedCommitment, question: string): BuyerCheck {
  // No rule matching a clause cannot be shown without revealing every rule, so a clear flag is never more than a claim.
  if (check.kind === "flag" && check.verdict === "clear") return { status: "unproven", check, why: "no-proof" };
  if (pinned.status === "missing") return { status: "unproven", check, why: "no-commitment" };
  const committed = pinned.commitment.root;
  const { evidence } = check;

  if (check.verdict === "unverifiable") {
    if (evidence === null || !("vacant" in evidence)) return { status: "unproven", check, why: "no-proof" };
    const opened = opensTo(check.kind === "number" ? figureKey(check.claim) : factKey(check.claim), evidence);
    if (opened !== committed) return forged(check, { kind: "wrong-root", opensTo: opened, committed });
    if (check.kind === "number") return verified({ status: "verified", kind: "number", claim: check.claim, verdict: "absent", path: evidence.path });
    return verified({ status: "verified", kind: "fact", claim: check.claim, verdict: "absent", path: evidence.path });
  }

  if (evidence === null || "vacant" in evidence) return forged(check, { kind: "no-evidence" });
  const { entry, salt, path } = evidence;
  switch (check.kind) {
    case "number": {
      const key = figureKey(check.claim);
      if (entry.kind !== "figure" || !sameKey(key, figureKey(entry))) return forged(check, { kind: "wrong-entry" });
      const miss = missesRoot(check, evidence, committed);
      if (miss) return miss;
      const judged = judgeFigure(check.claim, entry);
      if (judged.verdict !== check.verdict) return forged(check, { kind: "wrong-verdict", recomputed: judged.verdict });
      if (judged.verdict === "match") return verified({ status: "verified", kind: "number", claim: check.claim, verdict: "match", entry, salt, path });
      return verified({ status: "verified", kind: "number", claim: check.claim, verdict: "mismatch", deltaPct: judged.deltaPct, entry, salt, path });
    }
    case "fact": {
      if (entry.kind !== "fact" || !sameKey(factKey(check.claim), factKey(entry))) return forged(check, { kind: "wrong-entry" });
      const miss = missesRoot(check, evidence, committed);
      if (miss) return miss;
      const verdict = judgeFact(check.claim, entry);
      if (verdict !== check.verdict) return forged(check, { kind: "wrong-verdict", recomputed: verdict });
      return verified({ status: "verified", kind: "fact", claim: check.claim, verdict, entry, salt, path });
    }
    case "flag": {
      if (entry.kind !== "rule") return forged(check, { kind: "wrong-entry" });
      const miss = missesRoot(check, evidence, committed);
      if (miss) return miss;
      if (!quotedFrom(question, check.claim.text)) return { status: "unproven", check, why: "unquoted" };
      if (!ruleHits(entry, check.claim.text)) return forged(check, { kind: "wrong-verdict", recomputed: "clear" });
      return verified({ status: "verified", kind: "flag", claim: check.claim, verdict: "raised", entry, salt, path });
    }
    default: {
      const unreachable: never = check;
      return unreachable;
    }
  }
}

// The slot comes from the entry's own key, which the caller has already matched to the claim.
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
