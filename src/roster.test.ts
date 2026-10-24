import assert from "node:assert/strict";
import test from "node:test";
import { parseAssetId, parseParentAccount } from "./domain.ts";
import { bindProviders, PROVIDERS } from "./providers/index.ts";
import { resolveRoster } from "./roster.ts";

const KYLE_BOTS = [
  "researcher",
  "writer",
  "trader",
  "analyst",
  "clerk",
  "scout",
  "editor",
  "buyer",
  "reviewer",
  "assistant",
] as const;

test("the roster derives Kyle's bots and the three shops", () => {
  const resolved = resolveRoster();
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const rows = resolved.roster.forest();
  assert.deepEqual(
    rows.filter((row) => row.personId === "kyle").map((row) => [row.bot, row.account, row.role]),
    KYLE_BOTS.map((bot, index) => [bot, `${bot}.kyle.near`, index === 0 ? "default-payer" : "payer"]),
  );
  assert.deepEqual(
    rows.filter((row) => row.role === "specialist").map((row) => [row.personId, row.parent, row.bot, row.account]),
    [
      ["stella", "stella.near", "legal", "legal.stella.near"],
      ["ban", "ban.near", "insurance", "insurance.ban.near"],
      ["david", "david.near", "disclosure", "disclosure.david.near"],
    ],
  );
  assert.equal(resolved.roster.buyer("clerk")?.account, "clerk.kyle.near");
  assert.equal(resolved.roster.buyer("nope"), null);
  assert.equal(resolved.roster.defaultBuyer.account, "researcher.kyle.near");
  const asset = parseAssetId("nep141:wrap.near");
  assert.ok(asset);
  const bound = bindProviders(PROVIDERS, resolved.roster, { asset, symbol: "NEAR" });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  assert.deepEqual(
    bound.providers.map((item) => [item.listing.id, item.listing.owner, item.listing.payTo, item.listing.price.amount]),
    [
      ["disclosure", "david.near", "disclosure.david.near", "0.02"],
      ["legal", "stella.near", "legal.stella.near", "0.03"],
      ["insurance", "ban.near", "insurance.ban.near", "0.02"],
    ],
  );
});

test("a specialist parent cannot also be Kyle's parent", () => {
  const parent = parseParentAccount("ban.near");
  assert.ok(parent);
  const resolved = resolveRoster({ kyleParent: parent });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.fault, "overlap");
});
