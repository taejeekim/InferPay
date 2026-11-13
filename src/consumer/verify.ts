import type { Brand } from "../domain.ts";
import {
  judgeFact,
  judgeFigure,
  opensTo,
  ruleHits,
  sameFigure,
  sameTopic,
  type AssertedCheck,
  type ClauseClaim,
  type Fact,
  type FactClaim,
  type Figure,
  type FigureClaim,
  type Hash,
  type PinnedCommitment,
  type Rule,
  type Step,
} from "../commitment/index.ts";

// The entry a check rests on, with the salt and sibling path that walked it to the committed root.
type Proven<E> = { readonly entry: E; readonly salt: Hash; readonly path: readonly Step[] };

// A verdict the buyer computed itself, from an entry it walked to the shop's committed root.
export type VerifiedCheck = Brand<
  | ({ readonly status: "verified"; readonly kind: "number"; readonly claim: FigureClaim; readonly verdict: "match" } & Proven<Figure>)
  | ({ readonly status: "verified"; readonly kind: "number"; readonly claim: FigureClaim; readonly verdict: "mismatch"; readonly deltaPct: number } & Proven<Figure>)
  | ({ readonly status: "verified"; readonly kind: "fact"; readonly claim: FactClaim; readonly verdict: "match" | "mismatch" } & Proven<Fact>)
  | ({ readonly status: "verified"; readonly kind: "flag"; readonly claim: ClauseClaim; readonly verdict: "raised" } & Proven<Rule>),
  "VerifiedCheck"
>;

// The shop's word with nothing to check it against: it says it holds no entry, or it never published a root.
export type UnprovenCheck = {
  readonly status: "unproven";
  readonly check: AssertedCheck;
  readonly why: "absence" | "no-commitment";
};

export type Forgery =
  | { readonly kind: "no-evidence" }
  | { readonly kind: "wrong-root"; readonly opensTo: Hash; readonly committed: Hash }
  | { readonly kind: "wrong-entry" }
  | { readonly kind: "wrong-verdict"; readonly recomputed: "match" | "mismatch" | "unverifiable" | "clear" };

export type ForgedCheck = {
  readonly status: "forged";
  readonly check: AssertedCheck;
  readonly forgery: Forgery;
};

export type BuyerCheck = VerifiedCheck | UnprovenCheck | ForgedCheck;

export function verifyChecks(checks: readonly AssertedCheck[], pinned: PinnedCommitment): readonly BuyerCheck[] {
  return checks.map((check) => verifyCheck(check, pinned));
}

function verifyCheck(check: AssertedCheck, pinned: PinnedCommitment): BuyerCheck {
  if (check.verdict === "unverifiable" || check.verdict === "clear") return { status: "unproven", check, why: "absence" };
  if (pinned.status === "missing") return { status: "unproven", check, why: "no-commitment" };
  const { evidence } = check;
  if (evidence === null) return forged(check, { kind: "no-evidence" });
  const root = opensTo(evidence);
  if (root !== pinned.commitment.root) {
    return forged(check, { kind: "wrong-root", opensTo: root, committed: pinned.commitment.root });
  }
  const { entry, salt, path } = evidence;
  switch (check.kind) {
    case "number": {
      if (entry.kind !== "figure" || !sameFigure(check.claim, entry)) return forged(check, { kind: "wrong-entry" });
      const judged = judgeFigure(check.claim, entry);
      if (judged.verdict !== check.verdict) return forged(check, { kind: "wrong-verdict", recomputed: judged.verdict });
      if (judged.verdict === "match") return verified({ status: "verified", kind: "number", claim: check.claim, verdict: "match", entry, salt, path });
      return verified({ status: "verified", kind: "number", claim: check.claim, verdict: "mismatch", deltaPct: judged.deltaPct, entry, salt, path });
    }
    case "fact": {
      if (entry.kind !== "fact" || !sameTopic(check.claim, entry)) return forged(check, { kind: "wrong-entry" });
      const verdict = judgeFact(check.claim, entry);
      if (verdict !== check.verdict) return forged(check, { kind: "wrong-verdict", recomputed: verdict });
      return verified({ status: "verified", kind: "fact", claim: check.claim, verdict, entry, salt, path });
    }
    case "flag": {
      if (entry.kind !== "rule") return forged(check, { kind: "wrong-entry" });
      if (!ruleHits(entry, check.claim.text)) return forged(check, { kind: "wrong-verdict", recomputed: "clear" });
      return verified({ status: "verified", kind: "flag", claim: check.claim, verdict: "raised", entry, salt, path });
    }
    default: {
      const unreachable: never = check;
      return unreachable;
    }
  }
}

function forged(check: AssertedCheck, forgery: Forgery): ForgedCheck {
  return { status: "forged", check, forgery };
}

type Unbranded<T> = T extends Brand<infer Inner, "VerifiedCheck"> ? Inner : never;

function verified(check: Unbranded<VerifiedCheck>): VerifiedCheck {
  return check as VerifiedCheck;
}
