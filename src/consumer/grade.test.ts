import assert from "node:assert/strict";
import test from "node:test";
import { parseModelId } from "../domain.ts";
import type { Answer, Check } from "../providers/types.ts";
import { grade } from "./grade.ts";

test("grade scores checks the way a buyer can recompute", () => {
  assert.equal(grade(answer([])), 3);
  assert.equal(grade(answer([match("operating profit")])), 5);
  assert.equal(grade(answer([match("operating profit"), mismatch("revenue")])), 4);
  assert.equal(grade(answer([mismatch("a"), mismatch("b"), mismatch("c"), mismatch("d"), mismatch("e")])), 1);
  assert.equal(grade(answer([{ kind: "number", verdict: "unverifiable", label: "capex", claimed: 1, unit: "KRW T" }])), 3);
  assert.equal(grade(answer([{ kind: "flag", verdict: "raised", label: "uncapped indemnity", detail: "cap it" }])), 5);
  assert.equal(grade(answer([{ kind: "flag", verdict: "clear", label: "term", detail: "ok" }])), 5);
  assert.equal(grade(answer([{ kind: "fact", verdict: "match", label: "decimals", claimed: "24", source: "NEAR protocol" }])), 5);
  assert.equal(grade(answer([{ kind: "fact", verdict: "mismatch", label: "decimals", claimed: "18", reference: "24", source: "NEAR protocol" }])), 4);
});

function answer(checks: readonly Check[]): Answer {
  const model = parseModelId("stub");
  if (!model) throw new Error("model");
  return { text: "answer", checks, model, inference: "stub" };
}

function match(label: string): Check {
  return { kind: "number", verdict: "match", label, claimed: 12.1, unit: "KRW T", source: "quarterly report, p.14" };
}

function mismatch(label: string): Check {
  return {
    kind: "number",
    verdict: "mismatch",
    label,
    claimed: 79,
    unit: "KRW T",
    reference: 79.1,
    deltaPct: -0.13,
    source: "quarterly report",
  };
}
