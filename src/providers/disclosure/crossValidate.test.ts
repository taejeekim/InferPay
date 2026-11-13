import assert from "node:assert/strict";
import test from "node:test";
import { crossValidate, TOLERANCE_PCT, type DisclosureFact } from "./crossValidate.ts";

const facts: readonly DisclosureFact[] = [
  {
    company: "Samsung Electronics",
    period: "Q3 2025",
    metric: "operating profit",
    value: 12.2,
    unit: "KRW T",
    source: "Samsung Electronics Q3 2025 earnings release",
  },
  {
    company: "Samsung Electronics",
    period: "Q3 2025",
    metric: "revenue",
    value: 86.1,
    unit: "KRW T",
    source: "Samsung Electronics Q3 2025 earnings release",
  },
];

test("12.2T matches the filing and 86.0T is a 0.12 percent mismatch", () => {
  const checks = crossValidate(
    [
      claim("operating profit Q3 2025", "operating profit", 12.2, "KRW T"),
      claim("revenue Q3 2025", "revenue", 86, "KRW T"),
    ],
    facts,
    TOLERANCE_PCT,
  );
  const profit = checks[0];
  const revenue = checks[1];
  assert.ok(profit && revenue);
  assert.equal(profit.verdict, "match");
  assert.equal(revenue.verdict, "mismatch");
  if (revenue.verdict !== "mismatch") return;
  assert.equal(revenue.reference, 86.1);
  assert.ok(Math.abs(revenue.deltaPct) > TOLERANCE_PCT);
  assert.equal(revenue.deltaPct.toFixed(2), "-0.12");
});

test("a trillion-scale claim matches the same figure in KRW", () => {
  const checks = crossValidate(
    [claim("operating profit Q3 2025", "operating profit", 12_200_000_000_000, "KRW")],
    facts,
    TOLERANCE_PCT,
  );
  assert.equal(checks[0]?.verdict, "match");
});

test("case and spacing do not hide a filed figure, and a missing figure stays unverifiable", () => {
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
    facts,
    TOLERANCE_PCT,
  );
  assert.equal(checks[0]?.verdict, "match");
  assert.equal(checks[1]?.verdict, "unverifiable");
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
