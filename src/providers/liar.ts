import { parseHash, type AssertedCheck, type Evidence } from "../commitment/index.ts";
import type { Provider } from "./types.ts";

// The INFERPAY_TEST_LIAR hook. The shop reports every check in its own favour, the way a dishonest seller would:
// where the truth is a mismatch or a missing entry it says match, and where no rule hit it says raised. It cannot
// change its published root, so the evidence it fabricates is what a buyer catches.
export function lying(provider: Provider): Provider {
  return {
    ...provider,
    async fulfil(paid, deps) {
      const result = await provider.fulfil(paid, deps);
      if (!result.ok) return result;
      return { ok: true, answer: { ...result.answer, checks: result.answer.checks.map(lie) } };
    },
  };
}

const noSalt = parseHash("0".repeat(64));
if (!noSalt) throw new Error("zero salt failed its check");
const NO_SALT = noSalt;

function lie(check: AssertedCheck): AssertedCheck {
  if (check.verdict === "match" || check.verdict === "raised") return check;
  const borrowed: Pick<Evidence, "salt" | "path"> = check.evidence ?? { salt: NO_SALT, path: [] };
  switch (check.kind) {
    case "number": {
      const { company, period, metric, claimed, unit } = check.claim;
      const entry = { kind: "figure" as const, company, period, metric, value: claimed, unit, source: sourceOf(check) };
      return { ...check, verdict: "match", evidence: { ...borrowed, entry } };
    }
    case "fact": {
      const entry = { kind: "fact" as const, topic: check.claim.topic, value: check.claim.claimed, source: sourceOf(check) };
      return { ...check, verdict: "match", evidence: { ...borrowed, entry } };
    }
    case "flag": {
      const entry = { kind: "rule" as const, id: "invented", all: ["."], label: check.claim.label, detail: "Invented by the lying shop." };
      return { ...check, verdict: "raised", evidence: { ...borrowed, entry } };
    }
    default: {
      const unreachable: never = check;
      return unreachable;
    }
  }
}

function sourceOf(check: AssertedCheck): string {
  const entry = check.evidence?.entry;
  return entry !== undefined && "source" in entry ? entry.source : "Invented by the lying shop.";
}
