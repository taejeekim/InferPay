import assert from "node:assert/strict";
import test from "node:test";
import { measure } from "./measure.ts";
import { renderReport } from "./render.ts";

test("the eval catches every planted lie, flags no honest run, and keeps InferPay inside each budget", async () => {
  const report = await measure();
  assert.deepEqual(report.failures, []);
  assert.equal(report.rails, "payment=mock inference=stub");
  assert.ok(report.forgery.length > 0);
  for (const row of report.forgery) {
    assert.equal(row.honestForged, 0, `${row.shop} honest run on "${row.question}"`);
    assert.equal(row.caught, row.planted, `${row.shop} on "${row.question}"`);
  }
  assert.ok(report.forgery.some((row) => row.planted > 0), "some shop had something to lie about");
  assert.deepEqual(
    [...new Set(report.economics.rows.map((row) => row.policy))],
    ["inferpay", "always-buy", "never-buy"],
  );
  for (const row of report.economics.rows) {
    assert.match(row.spent, /^\d+(\.\d+)?$/);
    assert.equal(row.verified + row.alone + row.unanswered <= report.questions, true);
  }
  assert.equal(report.reputation.length, 3);
  const [before, afterGood, afterForged] = report.reputation;
  assert.ok(before && afterGood && afterForged);
  assert.ok(afterGood.rep > before.rep, "an honest 5/5 raises the shop's quality figure");
  assert.ok(afterForged.rep < afterGood.rep, "a forged 1/5 lowers it");
  assert.ok(report.cliRuns > 0);
  const text = renderReport(report);
  assert.match(text.split("\n")[0] ?? "", /payment=mock inference=stub/);
  assert.ok(text.split("\n").every((line) => line.length <= 100));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});
