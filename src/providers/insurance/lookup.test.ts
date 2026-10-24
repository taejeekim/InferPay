import assert from "node:assert/strict";
import test from "node:test";
import { lookupCoverage } from "./lookup.ts";
import { loadCoverage } from "./schedule.ts";

test("an outpatient MRI matches the private schedule as covered", () => {
  const checks = lookupCoverage(
    [{ label: "outpatient MRI", topic: "outpatient-mri", claimed: "covered" }],
    loadCoverage(),
  );
  assert.equal(checks[0]?.verdict, "match");
});

test("claiming MRI is excluded mismatches the schedule", () => {
  const checks = lookupCoverage(
    [{ label: "outpatient MRI", topic: "outpatient-mri", claimed: "excluded" }],
    loadCoverage(),
  );
  assert.equal(checks[0]?.verdict, "mismatch");
  if (checks[0]?.verdict === "mismatch") assert.equal(checks[0].reference, "covered");
});
