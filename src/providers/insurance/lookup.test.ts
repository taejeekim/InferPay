import assert from "node:assert/strict";
import test from "node:test";
import { opensTo } from "../../commitment/index.ts";
import { lookupCoverage } from "./lookup.ts";
import { loadCoverage } from "./schedule.ts";

test("an outpatient MRI matches the private schedule as covered, with evidence that opens to the shop's root", () => {
  const data = loadCoverage();
  const checks = lookupCoverage([{ label: "outpatient MRI", topic: "outpatient-mri", claimed: "covered" }], data);
  assert.equal(checks[0]?.verdict, "match");
  assert.ok(checks[0]?.evidence);
  assert.equal(opensTo(checks[0].evidence), data.commitment.root);
});

test("claiming MRI is excluded mismatches the schedule and proves the entry that says covered", () => {
  const checks = lookupCoverage([{ label: "outpatient MRI", topic: "outpatient-mri", claimed: "excluded" }], loadCoverage());
  assert.equal(checks[0]?.verdict, "mismatch");
  const entry = checks[0]?.evidence?.entry;
  assert.ok(entry?.kind === "fact");
  assert.equal(entry.value, "covered");
});

test("a copay stated as a percent matches the schedule", () => {
  const checks = lookupCoverage([{ label: "MRI copay", topic: "mri-copay", claimed: "20%" }], loadCoverage());
  assert.equal(checks[0]?.verdict, "match");
});

test("a topic the schedule does not hold is unverifiable with no evidence", () => {
  const checks = lookupCoverage([{ label: "dental", topic: "dental", claimed: "covered" }], loadCoverage());
  assert.deepEqual(checks[0], { kind: "fact", claim: { label: "dental", topic: "dental", claimed: "covered" }, verdict: "unverifiable", evidence: null });
});
