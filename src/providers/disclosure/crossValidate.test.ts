import assert from "node:assert/strict";
import test from "node:test";
import { figureKey, opensTo } from "../../commitment/index.ts";
import { crossValidate } from "./crossValidate.ts";
import { loadFacts } from "./facts.ts";

test("12.2T matches the filing and 86.0T mismatches it, each with evidence that opens to the shop's root", () => {
  const data = loadFacts();
  const checks = crossValidate(
    [
      claim("operating profit Q3 2025", "operating profit", 12.2, "KRW T"),
      claim("revenue Q3 2025", "revenue", 86, "KRW T"),
    ],
    data,
  );
  assert.deepEqual(checks.map((check) => check.verdict), ["match", "mismatch"]);
  for (const check of checks) {
    assert.ok(check.kind === "number" && check.evidence);
    assert.equal(opensTo(figureKey(check.claim), check.evidence), data.commitment.root);
  }
  const revenue = checks[1]?.evidence;
  assert.ok(revenue && "entry" in revenue && revenue.entry.kind === "figure");
  assert.equal(revenue.entry.value, 86.1);
});

test("a trillion-scale claim matches the same figure in KRW", () => {
  const checks = crossValidate([claim("operating profit Q3 2025", "operating profit", 12_200_000_000_000, "KRW")], loadFacts());
  assert.equal(checks[0]?.verdict, "match");
});

test("case and spacing do not hide a filed figure, and a missing figure comes with proof that its slot is empty", () => {
  const checks = crossValidate(
    [
      {
        label: "operating profit Q3 2025",
        company: " samsung   electronics ",
        period: "q3 2025",
        metric: "Operating Profit",
        claimed: 12.2,
        unit: "krw t",
      },
      claim("capex Q3 2025", "capex", 1, "KRW T"),
    ],
    loadFacts(),
  );
  assert.equal(checks[0]?.verdict, "match");
  const capex = checks[1];
  assert.ok(capex?.kind === "number" && capex.verdict === "unverifiable" && capex.evidence && "vacant" in capex.evidence);
  assert.equal(opensTo(figureKey(capex.claim), capex.evidence), loadFacts().commitment.root);
});

function claim(label: string, metric: string, claimed: number, unit: string) {
  return {
    label,
    company: "Samsung Electronics",
    period: "Q3 2025",
    metric,
    claimed,
    unit,
  };
}
