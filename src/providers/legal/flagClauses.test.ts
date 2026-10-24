import assert from "node:assert/strict";
import test from "node:test";
import { flagClauses } from "./flagClauses.ts";
import { loadPlaybook } from "./playbook.ts";

test("unlimited indemnification raises a playbook flag", () => {
  const checks = flagClauses(
    [{ label: "indemnity", text: "The receiving party shall provide unlimited indemnification for any claim." }],
    loadPlaybook(),
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.verdict, "raised");
  assert.equal(checks[0]?.label, "uncapped indemnity");
});

test("an ordinary clause stays clear", () => {
  const checks = flagClauses(
    [{ label: "term", text: "This agreement lasts twelve months." }],
    loadPlaybook(),
  );
  assert.equal(checks[0]?.verdict, "clear");
});
