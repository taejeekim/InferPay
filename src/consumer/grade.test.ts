import assert from "node:assert/strict";
import test from "node:test";
import { parseModelId } from "../domain.ts";
import type { Answer, NumberCheck } from "../providers/types.ts";
import { grade } from "./grade.ts";

test("grade scores checks the way a buyer can recompute", () => {
  assert.equal(grade(answer([])), 3);
  assert.equal(grade(answer([match("operating profit")])), 5);
  assert.equal(grade(answer([match("operating profit"), mismatch("revenue")])), 4);
  assert.equal(grade(answer([mismatch("a"), mismatch("b"), mismatch("c"), mismatch("d"), mismatch("e")])), 1);
  assert.equal(grade(answer([{ verdict: "unverifiable", label: "capex", claimed: 1, unit: "KRW T" }])), 5);
});

function answer(checks: readonly NumberCheck[]): Answer {
  const model = parseModelId("stub");
  if (!model) throw new Error("model");
  return { text: "answer", checks, model, inference: "stub" };
}

function match(label: string): NumberCheck {
  return { verdict: "match", label, claimed: 12.1, unit: "KRW T", source: "quarterly report, p.14" };
}

function mismatch(label: string): NumberCheck {
  return {
    verdict: "mismatch",
    label,
    claimed: 79,
    unit: "KRW T",
    reference: 79.1,
    deltaPct: -0.13,
    source: "quarterly report",
  };
}
