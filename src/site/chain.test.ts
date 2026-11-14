import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountId, parseParentAccount, type AccountId } from "../domain.ts";
import { readCommitments, readRatings } from "../registry/chain.ts";
import { resolveRoster } from "../roster.ts";

type Roster =
  | { readonly ok: false; readonly invalid: string }
  | {
      readonly ok: true;
      readonly root: string;
      readonly bots: readonly { readonly bot: string; readonly account: string; readonly defaultPayer: boolean }[];
      readonly shops: readonly { readonly providerId: string; readonly account: string }[];
    };
type Rating = { readonly jobId: string; readonly rater: string; readonly shop: string; readonly stars: number; readonly withheld?: number; readonly block: number };
type State = {
  readonly block: number;
  readonly shops: readonly { readonly providerId: string; readonly commitment: { readonly root: string; readonly block: number } | null; readonly reputation: { readonly ratings: number; readonly average: number | null; readonly quality: number } }[];
  readonly bots: readonly { readonly bot: string; readonly balance: bigint | null }[];
  readonly ratings: readonly Rating[];
  readonly earlier: readonly Rating[];
};
type SiteChain = {
  rosterOf(root: string): Roster;
  readRatings(raw: unknown, raters: readonly string[]): readonly (Rating & { readonly [field: string]: unknown })[];
  readEarlierRatings(raw: unknown, raters: readonly string[]): readonly Rating[];
  readCommitment(raw: unknown, account: string): { readonly scheme: string; readonly root: string; readonly leaves: number; readonly block: number } | null;
  readState(roster: Roster, fetcher: (url: string, init: { body: string }) => Promise<unknown>): Promise<State>;
};

const site = (await import(new URL("../../docs/js/chain.js", import.meta.url).href)) as SiteChain;

function account(raw: string): AccountId {
  const parsed = parseAccountId(raw);
  if (!parsed) throw new Error(`account fixture ${raw}`);
  return parsed;
}

test("the page derives the same eighteen accounts from a root as src/roster.ts, and refuses the roots it refuses", () => {
  const roots = ["inferpay.testnet", "inferpay-199f17e6.testnet", "a.b", "notop", "Bad.testnet", "x".repeat(40) + ".testnet", "-a.testnet", "a..testnet"];
  for (const root of roots) {
    const parent = parseParentAccount(root);
    const resolved = parent === null ? null : resolveRoster(parent);
    const ours = site.rosterOf(root);
    if (resolved === null || !resolved.ok) {
      assert.equal(ours.ok, false, root);
      continue;
    }
    assert.ok(ours.ok, root);
    const forest = resolved.roster.forest();
    assert.deepEqual(ours.bots.map((bot) => bot.account), forest.filter((row) => row.role !== "specialist").map((row) => row.account), root);
    assert.deepEqual(ours.bots.filter((bot) => bot.defaultPayer).map((bot) => bot.account), [resolved.roster.defaultBuyer.account], root);
    assert.deepEqual(
      [...ours.shops].map((shop) => [shop.providerId, shop.account]).sort(),
      forest.filter((row) => row.role === "specialist").map((row) => [row.bot, row.account]).sort(),
      root,
    );
  }
});

const ROOT = "d26d1609271e8c546648dc3d83990ff7540d60bf40cdf738d693ec655602b68f";

function rating(fields: Record<string, unknown>, block: number) {
  return { ":block": block, "": JSON.stringify({ shop: "insurance.ban.inferpay.testnet", stars: 5, payment: "tx", root: ROOT, verified: 1, unproven: 0, forged: 0, withheld: 0, ...fields }) };
}

const RAW = {
  "reviewer.kyle.inferpay.testnet": {
    inferpay: {
      ratings: {
        job_01M7BMG0TR1XEZH504RGA6MBP3: rating({}, 300),
        job_01M7BK17EQR5WSQH8AEMR1H7M8: rating({ shop: "disclosure.david.inferpay.testnet", stars: 4, verified: 2 }, 100),
        job_01M7BK17EQR5WSQH8AEMR1H7M9: rating({ stars: 6 }, 101),
        job_01M7BK17EQR5WSQH8AEMR1H7MA: rating({ root: "not-a-hash" }, 102),
        job_01M7BK17EQR5WSQH8AEMR1H7MB: rating({ root: null, verified: -1 }, 103),
        job_01M7BK17EQR5WSQH8AEMR1H7MC: rating({ root: null, forged: 1, stars: 1 }, 104),
        "not-a-job": rating({}, 105),
        job_01M7BK17EQR5WSQH8AEMR1H7MD: { ":block": 106, "": "not json" },
        job_01M7BK17EQR5WSQH8AEMR1H7ME: rating({ withheld: 2, stars: 1 }, 107),
        job_01M7BK17EQR5WSQH8AEMR1H7MF: rating({ withheld: -1 }, 108),
        // Written before ratings recorded withheld keys: the CLI skips these.
        job_01M7BK17EQR5WSQH8AEMR1H7MG: rating({ withheld: undefined, stars: 1 }, 400),
        job_01M7BK17EQR5WSQH8AEMR1H7MH: rating({ withheld: undefined, stars: 6 }, 401),
      },
    },
  },
  "editor.kyle.inferpay.testnet": { inferpay: { ratings: { job_01M7BMM6BHX9P6B7M5BDQ3JBF0: rating({ verified: 2 }, 300) } } },
  "insurance.ban.inferpay.testnet": {
    inferpay: { commitment: { ":block": 50, "": JSON.stringify({ scheme: "inferpay-keyed-merkle-sha256-v1", root: ROOT, leaves: 3 }) } },
  },
  "legal.stella.inferpay.testnet": { inferpay: { commitment: { ":block": 51, "": JSON.stringify({ scheme: "other", root: ROOT, leaves: 3 }) } } },
};

const RATERS = ["reviewer.kyle.inferpay.testnet", "editor.kyle.inferpay.testnet", "writer.kyle.inferpay.testnet"];

test("the page keeps and skips the same SocialDB values as src/registry", () => {
  const ours = site.readRatings(RAW, RATERS);
  const theirs = readRatings(RAW, RATERS.map(account));
  assert.deepEqual(ours.map((item) => ({ ...item, block: undefined })), theirs.map((item) => ({ ...item, block: undefined })));
  assert.equal(ours.length, 5);
  assert.ok(ours.every((item) => typeof item.withheld === "number"));
  const earlier = site.readEarlierRatings(RAW, RATERS);
  assert.deepEqual(earlier.map((item) => item.jobId), ["job_01M7BK17EQR5WSQH8AEMR1H7MG"], "only a valid rating without withheld is earlier");
  assert.ok(!theirs.some((item) => item.jobId === earlier[0]?.jobId), "the CLI skips it");
  const shops = ["insurance.ban.inferpay.testnet", "legal.stella.inferpay.testnet", "disclosure.david.inferpay.testnet"].map(account);
  const pinned = readCommitments(RAW, shops);
  for (const shop of shops) {
    const ourCommitment = site.readCommitment(RAW, shop);
    const theirCommitment = pinned.get(shop);
    if (theirCommitment?.status !== "published" || theirCommitment.source.kind !== "chain") {
      assert.equal(ourCommitment, null, shop);
      continue;
    }
    assert.deepEqual(ourCommitment, { ...theirCommitment.commitment, block: theirCommitment.source.block }, shop);
  }
});

test("the page reads one SocialDB value and each bot's balance, orders ratings newest first, and computes reputation as the market does", async () => {
  const roster = site.rosterOf("inferpay.testnet");
  const requests: unknown[] = [];
  const fetcher = async (_url: string, init: { body: string }) => {
    const params = (JSON.parse(init.body) as { params: { request_type: string; account_id: string } }).params;
    requests.push(params.request_type);
    if (params.request_type === "call_function") {
      return { json: async () => ({ result: { block_height: 999, result: [...new TextEncoder().encode(JSON.stringify(RAW))] } }), ok: true };
    }
    if (params.account_id.startsWith("writer.")) return { ok: true, json: async () => ({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } }) };
    return { ok: true, json: async () => ({ result: { amount: "600000000000000000000000" } }) };
  };
  const state = await site.readState(roster, fetcher);
  assert.equal(requests.filter((kind) => kind === "call_function").length, 1);
  assert.equal(requests.filter((kind) => kind === "view_account").length, 10);
  assert.equal(state.block, 999);
  assert.deepEqual(state.ratings.map((item) => item.block), [300, 300, 107, 104, 100]);
  assert.deepEqual(state.earlier.map((item) => item.block), [400]);
  assert.equal(state.ratings[0]?.jobId, "job_01M7BMM6BHX9P6B7M5BDQ3JBF0", "the later job id first within a block");
  assert.equal(state.bots.find((bot) => bot.bot === "writer")?.balance, null);
  assert.equal(state.bots.find((bot) => bot.bot === "researcher")?.balance, 600000000000000000000000n);
  const insurance = state.shops.find((shop) => shop.providerId === "insurance");
  // Stars 5, 5, 1, and 1; the earlier 1-star rating does not count. The prior of 0.70 counts as two ratings, so
  // (2 x 0.70 + 4 x (3 - 1) / 4) / 6 = 0.57.
  assert.deepEqual(insurance?.reputation, { ratings: 4, average: 3, quality: 57 });
  assert.equal(insurance?.commitment?.root, ROOT);
  assert.equal(state.shops.find((shop) => shop.providerId === "legal")?.commitment, null);
});
