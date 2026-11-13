import assert from "node:assert/strict";
import test from "node:test";
import { parseParentAccount, type AccountId } from "../domain.ts";
import { formatNear, nearOf } from "../payment/units.ts";
import { resolveRoster } from "../roster.ts";
import { accountTree, chooseRoot, planSetup, updateEnvText, type Observed } from "./testnet.ts";

const ROOT = must(parseParentAccount("inferpay.testnet"));

function tree() {
  const resolved = resolveRoster(ROOT);
  if (!resolved.ok) throw new Error(resolved.detail);
  return accountTree(resolved.roster);
}

function present(balance: string): Observed {
  return { exists: true, balance: nearOf(balance), savedKey: "matches" };
}

test("the tree is the root, four people, ten bots, and three shops, each parent before its children", () => {
  const nodes = tree();
  assert.equal(nodes.length, 18);
  const seen = new Set<AccountId>();
  for (const node of nodes) {
    if (node.parent !== null) assert.ok(seen.has(node.parent), `${node.account} comes after ${node.parent}`);
    seen.add(node.account);
  }
  const deposit = (account: string) => formatNear(nodes.find((node) => node.account === account)?.deposit ?? -1n);
  assert.equal(deposit("kyle.inferpay.testnet"), "6.1");
  assert.equal(deposit("researcher.kyle.inferpay.testnet"), "0.6");
  assert.equal(deposit("stella.inferpay.testnet"), "0.15");
  assert.equal(deposit("legal.stella.inferpay.testnet"), "0.05");
  const fromRoot = nodes.filter((node) => node.depth === 1).reduce((sum, node) => sum + node.deposit, 0n);
  assert.equal(formatNear(fromRoot), "6.55");
});

test("a new root is created through the faucet and every account under it is created", () => {
  const plan = planSetup(tree(), new Map(), "/keys");
  assert.ok(plan.ok);
  assert.deepEqual(plan.steps[0], { kind: "faucet", account: ROOT, key: "new" });
  assert.equal(plan.steps.filter((step) => step.kind === "create").length, 17);
});

test("a run after a crash halfway skips what exists and reuses a key saved before its account landed", () => {
  const nodes = tree();
  const observed = new Map<AccountId, Observed>();
  observed.set(ROOT, present("3.4"));
  for (const node of nodes.filter((item) => item.depth === 1)) observed.set(node.account, present(formatNear(node.deposit)));
  const researcher = nodes.find((node) => node.account.startsWith("researcher."));
  const writer = nodes.find((node) => node.account.startsWith("writer."));
  assert.ok(researcher && writer);
  observed.set(researcher.account, present("0.6"));
  observed.set(writer.account, { exists: false, savedKey: true });

  const plan = planSetup(nodes, observed, "/keys");
  assert.ok(plan.ok);
  const created = plan.steps.filter((step) => step.kind === "create");
  assert.equal(created.length, 12);
  assert.ok(!created.some((step) => step.account === researcher.account));
  const writerStep = created.find((step) => step.account === writer.account);
  assert.equal(writerStep?.key, "saved");
  assert.equal(writerStep?.parent, "kyle.inferpay.testnet");
});

test("a second run over a finished tree changes nothing", () => {
  const nodes = tree();
  const observed = new Map<AccountId, Observed>(nodes.map((node) => [node.account, present("1")]));
  const plan = planSetup(nodes, observed, "/keys");
  assert.ok(plan.ok);
  assert.ok(plan.steps.every((step) => step.kind === "verified"));
});

test("an existing account without the saved key, or a parent too poor to fund its children, stops the plan", () => {
  const nodes = tree();
  const observed = new Map<AccountId, Observed>([
    [ROOT, present("10")],
    [must(parseParentAccount("ban.inferpay.testnet")), { exists: true, balance: nearOf("1"), savedKey: "none" }],
    [must(parseParentAccount("david.inferpay.testnet")), { exists: true, balance: nearOf("1"), savedKey: "mismatch" }],
    [must(parseParentAccount("stella.inferpay.testnet")), present("0.01")],
  ]);
  const plan = planSetup(nodes, observed, "/keys");
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.problems.length, 3);
  assert.match(plan.problems.join("\n"), /ban\.inferpay\.testnet exists but \/keys has no key/);
  assert.match(plan.problems.join("\n"), /david\.inferpay\.testnet exists but the key saved/);
  assert.match(plan.problems.join("\n"), /stella\.inferpay\.testnet holds 0\.01 NEAR and needs 0\.06 NEAR/);
});

test("the root comes from --root, then from a testnet .env, then fresh from the faucet", () => {
  assert.deepEqual(chooseRoot(["--root", "inferpay.testnet"], {}), { root: "inferpay.testnet", source: "--root" });
  assert.ok("error" in chooseRoot(["--root", "inferpay.near"], {}));
  const recorded = chooseRoot([], { INFERPAY_PAYMENT: "near-testnet", INFERPAY_ROOT_ACCOUNT: "inferpay-0a1b2c3d.testnet" });
  assert.ok("root" in recorded && recorded.root === "inferpay-0a1b2c3d.testnet");
  const fresh = chooseRoot([], {});
  assert.ok("root" in fresh);
  if ("root" in fresh) assert.match(fresh.root, /^inferpay-[0-9a-f]{8}\.testnet$/);
});

test("the .env update touches only the two rail lines", () => {
  const before = "NEAR_AI_API_KEY=abc\n# keep me\nINFERPAY_ROOT_ACCOUNT=old.testnet\nOTHER=1\n";
  const after = updateEnvText(before, { INFERPAY_PAYMENT: "near-testnet", INFERPAY_ROOT_ACCOUNT: "inferpay.testnet" });
  assert.equal(after.text, "NEAR_AI_API_KEY=abc\n# keep me\nINFERPAY_ROOT_ACCOUNT=inferpay.testnet\nOTHER=1\nINFERPAY_PAYMENT=near-testnet\n");
  assert.deepEqual(after.changed, ["INFERPAY_ROOT_ACCOUNT=inferpay.testnet", "INFERPAY_PAYMENT=near-testnet"]);
  const again = updateEnvText(after.text, { INFERPAY_PAYMENT: "near-testnet", INFERPAY_ROOT_ACCOUNT: "inferpay.testnet" });
  assert.equal(again.text, after.text);
  assert.deepEqual(again.changed, []);
  assert.equal(updateEnvText("", { INFERPAY_PAYMENT: "near-testnet" }).text, "INFERPAY_PAYMENT=near-testnet\n");
});

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture failed its check");
  return value;
}
