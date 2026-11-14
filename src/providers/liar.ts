import { DEPTH, parseHash, type AssertedCheck, type Path } from "../commitment/index.ts";
import type { Provider } from "./types.ts";

export type HookMode = "forge" | "withhold";

// The INFERPAY_TEST_LIAR and INFERPAY_TEST_WITHHOLD hooks. A forging shop rewrites every check that is not a
// match or a raised flag into one, the way a dishonest seller would; it cannot change its published root, so the
// evidence it fabricates is what a buyer catches. A withholding shop sends only the checks that back its answer
// and drops the rest, needed keys included. report gets how many checks the shop rewrote or dropped.
export function rigged(provider: Provider, mode: HookMode, report: (changed: number) => void): Provider {
  return {
    ...provider,
    async fulfil(paid, deps) {
      const result = await provider.fulfil(paid, deps);
      if (!result.ok) return result;
      const sent = result.answer.checks;
      const checks = mode === "forge" ? sent.map(lie) : sent.filter(backs);
      report(mode === "forge" ? checks.filter((check, index) => check !== sent[index]).length : sent.length - checks.length);
      return { ok: true, answer: { ...result.answer, checks } };
    },
  };
}

function backs(check: AssertedCheck): boolean {
  return check.verdict === "match" || check.verdict === "raised" || check.verdict === "clear";
}

const noSalt = parseHash("0".repeat(64));
if (!noSalt) throw new Error("zero salt failed its check");
const NO_SALT = noSalt;
const NO_PATH: Path = Array.from({ length: DEPTH }, () => null);

function lie(check: AssertedCheck): AssertedCheck {
  if (check.kind === "opening" || check.verdict === "match" || check.verdict === "raised") return check;
  const borrowed = {
    salt: check.evidence !== null && "salt" in check.evidence ? check.evidence.salt : NO_SALT,
    path: check.evidence?.path ?? NO_PATH,
  };
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
      const entry = { kind: "rule" as const, id: check.claim.rule, all: ["."], label: check.claim.label, detail: "Invented by the lying shop." };
      return { ...check, verdict: "raised", evidence: { ...borrowed, entry } };
    }
    default: {
      const unreachable: never = check;
      return unreachable;
    }
  }
}

function sourceOf(check: AssertedCheck): string {
  const { evidence } = check;
  return evidence !== null && "entry" in evidence && "source" in evidence.entry ? evidence.entry.source : "Invented by the lying shop.";
}
