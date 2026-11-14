import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { progressLine } from "../cli/render.ts";
import { loadConfig } from "../config.ts";
import type { Progress } from "../consumer/index.ts";
import { parseAccountId, parseDecimalAmount, parseJobId, type AccountId } from "../domain.ts";
import { PROVIDERS } from "../providers/index.ts";
import { createRuntime } from "../runtime.ts";
import { parseCommitment, SCHEME, type Commitment } from "../commitment/index.ts";
import { newCredential, type Action, type NearClient, type SignedTx, type TxResult } from "../near/client.ts";
import { SOCIAL_DB } from "../near/social.ts";
import { formatNear, nearOf } from "../payment/units.ts";
import type { CrashPoint } from "../near/outbox.ts";
import { COMMIT_RESERVE, createChainRegistry, publishCommitments, readCommitments, readRatings, type Published, type ShopCommitment } from "./chain.ts";

const DISCLOSURE = account("disclosure.david.inferpay.testnet");
const DAVID = account("david.inferpay.testnet");
const LEGAL = account("legal.stella.inferpay.testnet");
const STELLA = account("stella.inferpay.testnet");

function account(raw: string): AccountId {
  const parsed = parseAccountId(raw);
  if (!parsed) throw new Error("fixture account");
  return parsed;
}

function commitment(byte: string, leaves = 2): Commitment {
  const parsed = parseCommitment({ scheme: SCHEME, root: byte.repeat(32), leaves });
  if (!parsed) throw new Error("fixture commitment");
  return parsed;
}

type Call = { readonly signer: AccountId; readonly receiver: AccountId; readonly method: string; readonly args: unknown; readonly deposit: bigint };

// Stands in for testnet and the SocialDB contract: `set` stores each string under its key path with the block it
// landed in, and `get` nests the stored values the way the live contract does with block heights on.
const RATING_GAS = 900_000_000_000_000_000_000n;
const BYTE_PRICE = 10_000_000_000_000_000_000n;

function fakeChain(balances: Readonly<Record<string, bigint>>) {
  const state = {
    height: 1000,
    values: new Map<string, { value: string; block: number }>(),
    balances: new Map(Object.entries(balances)),
    calls: [] as Call[],
    transfers: [] as { from: AccountId; to: AccountId; amount: bigint }[],
    signed: new Map<string, readonly Action[]>(),
    broadcasts: [] as string[],
    landed: new Set<string>(),
    failNext: null as TxResult | null,
    // What SocialDB keeps for each account: one yoctoNEAR price per byte written, as the contract charges.
    storage: new Map<string, bigint>(),
  };
  const store = (prefix: string, value: unknown): void => {
    if (typeof value === "string") {
      state.values.set(prefix, { value, block: state.height });
      return;
    }
    for (const [key, inner] of Object.entries(value as object)) store(`${prefix}/${key}`, inner);
  };
  const apply = (signer: AccountId, receiver: AccountId, action: Action): void => {
    if (action.transfer) {
      state.balances.set(signer, (state.balances.get(signer) ?? 0n) - action.transfer.deposit);
      state.balances.set(receiver, (state.balances.get(receiver) ?? 0n) + action.transfer.deposit);
      state.transfers.push({ from: signer, to: receiver, amount: action.transfer.deposit });
    }
    if (action.functionCall) {
      const args: unknown = JSON.parse(Buffer.from(action.functionCall.args).toString("utf8"));
      state.calls.push({ signer, receiver, method: action.functionCall.methodName, args, deposit: action.functionCall.deposit });
      const data = (args as { data: Record<string, unknown> }).data;
      assert.deepEqual(Object.keys(data), [signer], "SocialDB lets an account write only under its own id");
      store(signer, data[signer]);
      state.storage.set(signer, (state.storage.get(signer) ?? 0n) + BigInt(JSON.stringify(data[signer]).length) * BYTE_PRICE);
    }
  };
  const land = (tx: SignedTx): void => {
    if (state.landed.has(tx.hash)) return;
    state.height += 1;
    state.landed.add(tx.hash);
    for (const action of state.signed.get(tx.hash) ?? []) apply(tx.signerId, tx.receiverId, action);
  };
  const port: Pick<NearClient, "view" | "balance" | "send" | "sign" | "broadcast" | "status"> = {
    async sign(credential, receiverId, txActions) {
      const hash = `tx${state.signed.size + 1}`;
      state.signed.set(hash, txActions);
      return { hash, signerId: credential.accountId, receiverId, nonce: String(state.signed.size), base64: hash };
    },
    async broadcast(tx, wait) {
      state.broadcasts.push(tx.hash);
      if (state.failNext !== null) {
        const result = state.failNext;
        state.failNext = null;
        return result;
      }
      land(tx);
      return wait === "NONE" ? { kind: "pending" } : { kind: "success", burnt: RATING_GAS };
    },
    async status(tx) {
      return state.landed.has(tx.hash) ? { kind: "success", burnt: RATING_GAS } : { kind: "unknown" };
    },
    async view(contractId, method, args) {
      assert.equal(contractId, SOCIAL_DB);
      if (method === "storage_balance_of") {
        const total = state.storage.get(String(args.account_id));
        return total === undefined ? null : { total: total.toString(), available: "0" };
      }
      assert.equal(method, "get");
      assert.deepEqual(args.options, { with_block_height: true });
      const out: Record<string, unknown> = { ":block": state.height };
      for (const pattern of args.keys as string[]) {
        for (const [key, leaf] of state.values) {
          const matches = pattern.endsWith("/*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern;
          if (!matches) continue;
          const parts = key.split("/");
          let node = out;
          for (const part of parts.slice(0, -1)) {
            node[part] ??= { ":block": leaf.block };
            node = node[part] as Record<string, unknown>;
          }
          node[parts.at(-1) ?? ""] = { ":block": leaf.block, "": leaf.value };
        }
      }
      return out;
    },
    async balance(accountId) {
      return state.balances.get(accountId) ?? null;
    },
    async send(credential, receiverId, txActions) {
      const tx = await port.sign(credential, receiverId, txActions);
      return { tx, result: await port.broadcast(tx, "FINAL") };
    },
  };
  return Object.assign(state, { port });
}

const SHOPS: readonly ShopCommitment[] = [
  { account: DISCLOSURE, parent: DAVID, declared: commitment("a1") },
  { account: LEGAL, parent: STELLA, declared: commitment("b2", 3) },
];

async function publish(chain: ReturnType<typeof fakeChain>, shops: readonly ShopCommitment[] = SHOPS): Promise<Published[]> {
  const steps: Published[] = [];
  await publishCommitments({ chain: chain.port, credential: async (id) => newCredential(id) }, shops, (step) => steps.push(step));
  return steps;
}

function funded() {
  return fakeChain({ [DISCLOSURE]: nearOf("0.09"), [LEGAL]: nearOf("0.075"), [DAVID]: nearOf("0.09"), [STELLA]: nearOf("0.09") });
}

test("the response testnet gave for a published commitment reads as that commitment and its block", () => {
  const live = {
    ":block": 277575111,
    "disclosure.david.inferpay.testnet": {
      ":block": 277575111,
      inferpay: {
        ":block": 277575111,
        commitment: {
          ":block": 277575111,
          "": '{"scheme":"inferpay-keyed-merkle-sha256-v1","root":"4bc59b533ac3b45997fa8cb2af6bac1052a8fa9c88247405fbc8c1087cd2a40a","leaves":2}',
        },
      },
    },
  };
  const read = readCommitments(live, [DISCLOSURE, LEGAL]);
  assert.deepEqual(read.get(DISCLOSURE), {
    status: "published",
    commitment: { scheme: SCHEME, root: "4bc59b533ac3b45997fa8cb2af6bac1052a8fa9c88247405fbc8c1087cd2a40a", leaves: 2 },
    source: { kind: "chain", contract: SOCIAL_DB, account: DISCLOSURE, block: 277575111 },
  });
  assert.deepEqual(read.get(LEGAL), { status: "missing", contract: SOCIAL_DB, account: LEGAL });
});

test("a value that is not a commitment in this scheme reads as missing", () => {
  for (const value of ["not json", '{"scheme":"other","root":"ab","leaves":1}', '{"scheme":"inferpay-keyed-merkle-sha256-v1","root":"xyz","leaves":2}']) {
    const raw = { [DISCLOSURE]: { inferpay: { commitment: { ":block": 5, "": value } } } };
    assert.equal(readCommitments(raw, [DISCLOSURE]).get(DISCLOSURE)?.status, "missing", value);
  }
});

test("the first run writes each shop's commitment under its own account, and a second run writes nothing", async () => {
  const chain = funded();
  const first = await publish(chain);
  assert.deepEqual(first.map((step) => [step.kind, step.account]), [["published", DISCLOSURE], ["published", LEGAL]]);
  assert.deepEqual(chain.calls, [
    {
      signer: DISCLOSURE,
      receiver: SOCIAL_DB,
      method: "set",
      args: {
        data: { [DISCLOSURE]: { inferpay: { commitment: `{"scheme":"inferpay-keyed-merkle-sha256-v1","root":"${"a1".repeat(32)}","leaves":2}` } } },
        options: { refund_unused_deposit: true },
      },
      deposit: nearOf("0.02"),
    },
    {
      signer: LEGAL,
      receiver: SOCIAL_DB,
      method: "set",
      args: {
        data: { [LEGAL]: { inferpay: { commitment: `{"scheme":"inferpay-keyed-merkle-sha256-v1","root":"${"b2".repeat(32)}","leaves":3}` } } },
        options: { refund_unused_deposit: true },
      },
      deposit: nearOf("0.02"),
    },
  ]);
  assert.deepEqual(chain.transfers, []);

  const second = await publish(chain);
  assert.deepEqual(second.map((step) => step.kind), ["current", "current"]);
  assert.equal(chain.calls.length, 2);

  const read = await registryOn(chain, "unused").commitments([DISCLOSURE, LEGAL]);
  assert.deepEqual(read.get(LEGAL), {
    status: "published",
    commitment: commitment("b2", 3),
    source: { kind: "chain", contract: SOCIAL_DB, account: LEGAL, block: 1002 },
  });
});

test("only the shop whose root changed publishes again", async () => {
  const chain = funded();
  await publish(chain);
  const steps = await publish(chain, [SHOPS[0] as ShopCommitment, { account: LEGAL, parent: STELLA, declared: commitment("c3", 4) }]);
  assert.deepEqual(steps.map((step) => [step.kind, step.kind === "published" && step.why]), [["current", false], ["published", "changed"]]);
  assert.equal(chain.calls.length, 3);
  assert.equal(chain.values.get(`${LEGAL}/inferpay/commitment`)?.value, JSON.stringify(commitment("c3", 4)));
});

test("a shop short of the deposit is topped up by its owner with exactly what it lacks, once", async () => {
  const chain = fakeChain({ [DISCLOSURE]: nearOf("0.005"), [DAVID]: nearOf("0.09") });
  const [step] = await publish(chain, [SHOPS[0] as ShopCommitment]);
  assert.deepEqual(chain.transfers, [{ from: DAVID, to: DISCLOSURE, amount: COMMIT_RESERVE - nearOf("0.005") }]);
  assert.ok(step?.kind === "published");
  assert.equal(step.toppedUp, COMMIT_RESERVE - nearOf("0.005"));
  await publish(chain, [SHOPS[0] as ShopCommitment]);
  assert.equal(chain.transfers.length, 1);
});

test("a publish that fails stops setup, and the next run publishes the shops still missing", async () => {
  const chain = funded();
  chain.failNext = { kind: "failed", reason: "Not enough storage balance" };
  await assert.rejects(() => publish(chain), /publishing the commitment of disclosure\.david\.inferpay\.testnet did not finish \(failed: Not enough storage balance\)/);
  assert.equal(chain.values.size, 0);
  const steps = await publish(chain);
  assert.deepEqual(steps.map((step) => step.kind), ["published", "published"]);
  assert.equal(chain.values.size, 2);
});

const INSURANCE = account("insurance.ban.inferpay.testnet");
const BAN = account("ban.inferpay.testnet");

function realShops(): ShopCommitment[] {
  const seats: Record<string, readonly [AccountId, AccountId]> = { disclosure: [DISCLOSURE, DAVID], legal: [LEGAL, STELLA], insurance: [INSURANCE, BAN] };
  return PROVIDERS.flatMap((provider) => {
    const seat = seats[provider.describe.id];
    return seat ? [{ account: seat[0], parent: seat[1], declared: provider.commitment() }] : [];
  });
}

const RESEARCHER = account("researcher.kyle.inferpay.testnet");
const MRI = "Does this policy cover an outpatient MRI?";

function registryOn(chain: ReturnType<typeof fakeChain>, root: string, crash: CrashPoint | null = null) {
  const config = loadConfig({});
  assert.ok(config.ok);
  return createChainRegistry({
    chain: chain.port,
    raters: config.value.roster.forest().filter((row) => row.role !== "specialist").map((row) => row.account),
    outbox: {
      file: join(root, "ratings.jsonl"),
      chain: chain.port,
      credential: async (id) => newCredential(id),
      crash,
      // The real hook exits the process. Throwing leaves the same files behind: a stored transaction, a rated
      // ledger line, and no record that the rating was posted.
      onCrash(point) {
        throw new Error(`stopped ${point}`);
      },
    },
  });
}

async function runtimeOn(chain: ReturnType<typeof fakeChain>, root: string, crash: CrashPoint | null = null) {
  const config = loadConfig({ INFERPAY_DATA_DIR: root });
  assert.ok(config.ok);
  return { config: config.value, runtime: await createRuntime(config.value, registryOn(chain, root, crash)) };
}

async function askOn(chain: ReturnType<typeof fakeChain>, root: string, question: string, crash: CrashPoint | null = null): Promise<string> {
  const { config, runtime } = await runtimeOn(chain, root, crash);
  const amount = parseDecimalAmount("0.10");
  assert.ok(amount);
  const seen: Progress[] = [];
  await runtime.consumer.ask(question, { budget: { ...config.near, amount }, buyer: config.roster.defaultBuyer }, (step) => seen.push(step));
  return seen.map((step) => progressLine(step, "near-testnet")).join("\n");
}

async function resumeOn(chain: ReturnType<typeof fakeChain>, root: string): Promise<string> {
  const { runtime } = await runtimeOn(chain, root);
  const jobId = parseJobId((await readdir(join(root, "jobs"))).find((name) => name.endsWith(".jsonl"))?.slice(0, -".jsonl".length) ?? "");
  assert.ok(jobId);
  const seen: Progress[] = [];
  await runtime.consumer.resume(jobId, (step) => seen.push(step));
  return seen.map((step) => progressLine(step, "near-testnet")).join("\n");
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function published() {
  const chain = fakeChain({ [DISCLOSURE]: nearOf("0.09"), [LEGAL]: nearOf("0.09"), [INSURANCE]: nearOf("0.09") });
  await publish(chain, realShops());
  return chain;
}

function ratingCalls(chain: ReturnType<typeof fakeChain>): Call[] {
  return chain.calls.filter((call) => call.signer === RESEARCHER);
}

test("the buyer verifies against the root it read from chain and says where it read it", async () => {
  await withRoot(async (root) => {
    const text = await askOn(await published(), root, MRI);
    assert.match(text, /^checks {4}1 of 1 needed key opened and verified against the shop's committed root$/m);
    assert.match(text, /^ {10}from {6}NEAR testnet, written at block 1003 and read before paying$/m);
    assert.match(text, /^ {10}key {7}insurance\.ban\.inferpay\.testnet\/inferpay\/commitment in SocialDB v1\.social08\.testnet$/m);
    assert.match(text, /^ {10}link {6}https:\/\/testnet\.nearblocks\.io\/address\/insurance\.ban\.inferpay\.testnet$/m);
    assert.match(text, /^rate {6}5\/5 {2}= 5$/m);
  });
});

test("a shop whose data no longer seals to its root on chain turns the order down before any payment or rating", async () => {
  await withRoot(async (root) => {
    const chain = fakeChain({ [DISCLOSURE]: nearOf("0.09"), [LEGAL]: nearOf("0.09"), [INSURANCE]: nearOf("0.09") });
    await publish(chain, realShops().map((shop) => (shop.account === INSURANCE ? { ...shop, declared: commitment("ee", 3) } : shop)));
    const { config, runtime } = await runtimeOn(chain, root);
    const amount = parseDecimalAmount("0.10");
    assert.ok(amount);
    const outcome = await runtime.consumer.ask(MRI, { budget: { ...config.near, amount }, buyer: config.roster.defaultBuyer });
    assert.deepEqual(outcome, { kind: "failed", reason: { kind: "stale-commitment", providerId: "insurance" } });
    assert.deepEqual(ratingCalls(chain), []);
    assert.deepEqual((await readdir(root)).filter((name) => name !== "jobs"), []);
    assert.deepEqual((await readdir(join(root, "jobs"))).filter((name) => name.endsWith(".jsonl")), []);
  });
});

test("a forged check is rated 1 on chain, with the forgery counted and the root it was checked against", async () => {
  await withRoot(async (root) => {
    const chain = await published();
    const config = loadConfig({ INFERPAY_DATA_DIR: root, INFERPAY_TEST_LIAR: "disclosure" });
    assert.ok(config.ok);
    const runtime = await createRuntime(config.value, registryOn(chain, root));
    const amount = parseDecimalAmount("0.10");
    assert.ok(amount);
    await runtime.consumer.ask("What was Samsung's Q3 2025 operating profit?", { budget: { ...config.value.near, amount }, buyer: config.value.roster.defaultBuyer });
    const [call] = ratingCalls(chain);
    const posted = JSON.parse(Object.values((call?.args as { data: Record<string, { inferpay: { ratings: Record<string, string> } }> }).data[RESEARCHER]?.inferpay.ratings ?? {})[0] ?? "");
    assert.deepEqual(
      [posted.shop, posted.stars, posted.verified, posted.unproven, posted.forged, posted.root],
      [DISCLOSURE, 1, 1, 0, 1, "4bc59b533ac3b45997fa8cb2af6bac1052a8fa9c88247405fbc8c1087cd2a40a"],
    );
  });
});

test("a shop with nothing on chain has only its word, so the key it was paid to open counts as withheld", async () => {
  await withRoot(async (root) => {
    const chain = fakeChain({});
    const text = await askOn(chain, root, MRI);
    assert.match(text, /^ {10}unproven {4}match {9}outpatient MRI {2}covered$/m);
    assert.match(text, /^ {10}WITHHELD {18}outpatient-mri$/m);
    assert.match(text, /^ {10}root {6}none: insurance\.ban\.inferpay\.testnet has published no commitment in SocialDB v1\.social08\.testnet$/m);
    assert.match(text, /^rate {6}2\/5 /m);
  });
});

test("the buyer bot writes its rating under its own account, with the shop, the payment, the root, and the counts", async () => {
  await withRoot(async (root) => {
    const chain = await published();
    const text = await askOn(chain, root, MRI);
    const jobId = text.match(/^ {10}job {5}(job_\w+)$/m)?.[1];
    const payment = JSON.parse((await readFile(join(root, "mock-rail.jsonl"), "utf8")).trim().split("\n")[0] ?? "").correlationId;
    assert.ok(jobId && typeof payment === "string");
    assert.deepEqual(ratingCalls(chain), [{
      signer: RESEARCHER,
      receiver: SOCIAL_DB,
      method: "set",
      args: {
        data: {
          [RESEARCHER]: {
            inferpay: {
              ratings: {
                [jobId]: JSON.stringify({
                  shop: INSURANCE,
                  stars: 5,
                  payment,
                  root: "d26d1609271e8c546648dc3d83990ff7540d60bf40cdf738d693ec655602b68f",
                  verified: 1,
                  unproven: 0,
                  forged: 0,
                  withheld: 0,
                }),
              },
            },
          },
        },
        options: { refund_unused_deposit: true },
      },
      deposit: nearOf("0.02"),
    }]);
    assert.match(text, /^ {10}on chain {2}SocialDB v1\.social08\.testnet, written by the buyer bot under its own account$/m);
    assert.match(text, new RegExp(`^ {10}key {7}researcher\\.kyle\\.inferpay\\.testnet/inferpay/ratings/${jobId}$`, "m"));
    assert.match(text, /^ {10}tx {8}https:\/\/testnet\.nearblocks\.io\/txns\/tx4$/m);
    const stored = BigInt(JSON.stringify((ratingCalls(chain)[0]?.args as { data: Record<string, unknown> }).data[RESEARCHER]).length) * BYTE_PRICE;
    const shown = (yocto: bigint): string => formatNear(yocto, 8).replace(".", "\\.");
    assert.match(text, new RegExp(`^ {10}cost {6}${shown(RATING_GAS + stored)} NEAR on top of the price: ${shown(RATING_GAS)} gas, from the transaction outcome,$`, "m"));
    assert.match(text, new RegExp(`^ {20}\\+ ${shown(stored)} SocialDB storage, from the bot's storage_balance_of before and after$`, "m"));
  });
});

test("reputation comes from the ratings on chain, so it survives losing the local ledger", async () => {
  const chain = await published();
  await withRoot(async (root) => {
    await askOn(chain, root, MRI);
    await askOn(chain, root, "What was Samsung's Q3 2025 operating profit?");
  });
  await withRoot(async (fresh) => {
    const { runtime } = await runtimeOn(chain, fresh);
    const listings = await runtime.market.listings();
    assert.deepEqual(listings.map((listing) => [listing.id, listing.reputation]), [
      ["disclosure", { kind: "rated", completedJobs: 1, ratings: 1, average: 5 }],
      ["legal", { kind: "unrated", completedJobs: 0 }],
      ["insurance", { kind: "rated", completedJobs: 1, ratings: 1, average: 5 }],
    ]);
    const next = await askOn(chain, fresh, MRI);
    assert.match(next, /insurance {3}ask 0\.02 {2}cover 1\.00 x rep 0\.80 = quality 0\.80/);
  });
});

test("resuming a rated job posts nothing new and shows the same transaction", async () => {
  await withRoot(async (root) => {
    const chain = await published();
    const first = await askOn(chain, root, MRI);
    const again = await resumeOn(chain, root);
    assert.equal(ratingCalls(chain).length, 1);
    assert.equal(chain.signed.size, 4);
    const tx = /^ {10}tx {8}https:\/\/testnet\.nearblocks\.io\/txns\/tx4$/m;
    assert.match(first, tx);
    assert.match(again, tx);
  });
});

test("a crash after the rating was signed or broadcast keeps the local rating, and resume posts it exactly once", async () => {
  for (const crash of ["after-sign", "after-broadcast"] as const) {
    await withRoot(async (root) => {
      const chain = await published();
      assert.match(await askOn(chain, root, MRI, crash), new RegExp(`^ {10}on chain {2}not yet: stopped ${crash}$`, "m"));
      const { runtime } = await runtimeOn(chain, root);
      const [row] = (await runtime.market.listings()).filter((listing) => listing.id === "insurance");
      assert.equal(row?.reputation.kind, crash === "after-broadcast" ? "rated" : "unrated", crash);
      const ledger = await readFile(join(root, "jobs", (await readdir(join(root, "jobs"))).find((name) => name.endsWith(".jsonl")) ?? ""), "utf8");
      assert.match(ledger, /"type":"rated","at":"[^"]+","rating":5/, crash);
      assert.doesNotMatch(ledger, /rating-posted/, crash);

      const resumed = await resumeOn(chain, root);
      assert.match(resumed, /^rate {6}5\/5 {2}= 5$/m, crash);
      assert.match(resumed, /^ {10}tx {8}https:\/\/testnet\.nearblocks\.io\/txns\/tx4$/m, crash);
      assert.equal(chain.signed.size, 4, crash);
      assert.equal(ratingCalls(chain).length, 1, crash);
      await resumeOn(chain, root);
      assert.equal(ratingCalls(chain).length, 1, crash);
    });
  }
});

test("a signed rating whose nonce another transaction took is signed again, because posting it twice changes nothing", async () => {
  await withRoot(async (root) => {
    const chain = await published();
    await askOn(chain, root, MRI, "after-sign");
    chain.failNext = { kind: "refused", reason: "nonce 4 is not above the access key's nonce", never: "nonce-used" };
    const resumed = await resumeOn(chain, root);
    assert.match(resumed, /^ {10}tx {8}https:\/\/testnet\.nearblocks\.io\/txns\/tx5$/m);
    assert.equal(chain.signed.size, 5);
    assert.equal(ratingCalls(chain).length, 1);
  });
});

test("a rating that cannot reach the chain stays pending with a resume hint, and resume posts it", async () => {
  await withRoot(async (root) => {
    const chain = await published();
    chain.failNext = { kind: "unreachable", detail: "fetch failed" };
    const text = await askOn(chain, root, MRI);
    assert.match(text, /^rate {6}5\/5 {2}= 5$/m);
    assert.match(text, /^ {10}on chain {2}not yet: fetch failed$/m);
    assert.match(text, /^ {20}the rating is in the local ledger\. Run: npx inferpay resume job_\w+$/m);
    assert.equal(ratingCalls(chain).length, 0);
    assert.match(await resumeOn(chain, root), /^ {10}tx {8}https:\/\/testnet\.nearblocks\.io\/txns\/tx4$/m);
    assert.equal(ratingCalls(chain).length, 1);
    assert.equal(chain.signed.size, 4);
  });
});

test("only a well-formed rating under a known bot's account counts", () => {
  const good = JSON.stringify({ shop: INSURANCE, stars: 4, payment: "hash", root: null, verified: 1, unproven: 1, forged: 0, withheld: 0 });
  const leaf = (value: string) => ({ ":block": 9, "": value });
  const raw = {
    [RESEARCHER]: {
      inferpay: {
        ratings: {
          ":block": 9,
          job_01M7BGGX58BF3B8VB4ADYKXYZA: leaf(good),
          job_01M7BGGX58BF3B8VB4ADYKXYZB: leaf(JSON.stringify({ shop: INSURANCE, stars: 9, payment: "hash", root: null, verified: 0, unproven: 0, forged: 0 })),
          job_01M7BGGX58BF3B8VB4ADYKXYZC: leaf("five stars"),
          // Written before the buyer named its needs, so it says nothing about withheld keys.
          job_01M7BGGX58BF3B8VB4ADYKXYZE: leaf(JSON.stringify({ shop: INSURANCE, stars: 5, payment: "hash", root: null, verified: 1, unproven: 0, forged: 0 })),
          "not-a-job": leaf(good),
        },
      },
    },
    [INSURANCE]: { inferpay: { ratings: { job_01M7BGGX58BF3B8VB4ADYKXYZD: leaf(good.replace('"stars":4', '"stars":5')) } } },
  };
  assert.deepEqual(readRatings(raw, [RESEARCHER]), [{
    jobId: "job_01M7BGGX58BF3B8VB4ADYKXYZA",
    rater: RESEARCHER,
    shop: INSURANCE,
    stars: 4,
    payment: "hash",
    root: null,
    verified: 1,
    unproven: 1,
    forged: 0,
    withheld: 0,
  }]);
});
