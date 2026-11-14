import assert from "node:assert/strict";
import test from "node:test";
import { entryKey, opensTo } from "../../commitment/index.ts";
import { flagClauses } from "./flagClauses.ts";
import { loadPlaybook } from "./playbook.ts";

test("unlimited indemnification raises a playbook flag and proves the rule that hit", () => {
  const playbook = loadPlaybook();
  const checks = flagClauses(
    [{ label: "indemnity", text: "The receiving party shall provide unlimited indemnification for any claim.", rule: "uncapped-indemnity" }],
    playbook,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.verdict, "raised");
  const evidence = checks[0]?.evidence;
  assert.ok(evidence && "entry" in evidence && evidence.entry.kind === "rule");
  assert.equal(evidence.entry.label, "uncapped indemnity");
  assert.equal(opensTo(entryKey(evidence.entry), evidence), playbook.commitment.root);
});

test("a reworded uncapped indemnity still raises the flag", () => {
  const checks = flagClauses(
    [{ label: "indemnity", text: "The receiving party shall indemnify the discloser without limit.", rule: "uncapped-indemnity" }],
    loadPlaybook(),
  );
  assert.equal(checks[0]?.verdict, "raised");
});

test("a clause the named rule does not hit is clear, with that rule opened as proof", () => {
  const playbook = loadPlaybook();
  const checks = flagClauses([{ label: "term", text: "Confidentiality lasts three years.", rule: "perpetual-nda" }], playbook);
  assert.equal(checks[0]?.verdict, "clear");
  const evidence = checks[0]?.evidence;
  assert.ok(evidence && "entry" in evidence && evidence.entry.kind === "rule");
  assert.equal(evidence.entry.id, "perpetual-nda");
  assert.equal(opensTo(entryKey(evidence.entry), evidence), playbook.commitment.root);
});

test("a rule the playbook does not hold is answered with its empty slot", () => {
  const playbook = loadPlaybook();
  const [check] = flagClauses([{ label: "law", text: "Governed by the laws of Mars.", rule: "governing-law" }], playbook);
  assert.equal(check?.verdict, "unverifiable");
  assert.ok(check?.evidence && "vacant" in check.evidence);
  assert.equal(opensTo(["rule", "governing-law"], check.evidence), playbook.commitment.root);
});
