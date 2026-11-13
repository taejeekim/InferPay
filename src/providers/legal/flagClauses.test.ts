import assert from "node:assert/strict";
import test from "node:test";
import { entryKey, opensTo } from "../../commitment/index.ts";
import { flagClauses } from "./flagClauses.ts";
import { loadPlaybook } from "./playbook.ts";

test("unlimited indemnification raises a playbook flag and proves the rule that hit", () => {
  const playbook = loadPlaybook();
  const checks = flagClauses(
    [{ label: "indemnity", text: "The receiving party shall provide unlimited indemnification for any claim." }],
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
    [{ label: "indemnity", text: "The receiving party shall indemnify the discloser without limit." }],
    loadPlaybook(),
  );
  assert.equal(checks[0]?.verdict, "raised");
});

test("an ordinary clause stays clear and carries no evidence", () => {
  const checks = flagClauses([{ label: "term", text: "This agreement lasts twelve months." }], loadPlaybook());
  assert.equal(checks[0]?.verdict, "clear");
  assert.equal(checks[0]?.evidence, null);
});
