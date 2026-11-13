import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { progressLine } from "../cli/render.ts";
import { loadConfig } from "../config.ts";
import type { Progress } from "../consumer/index.ts";
import { parseAccountId, parseDecimalAmount, type AccountId } from "../domain.ts";
import { PROVIDERS } from "../providers/index.ts";
import { createRuntime } from "../runtime.ts";
import { parseCommitment, SCHEME, type Commitment } from "../commitment/index.ts";
import { newCredential, type Action, type NearClient, type TxResult } from "../near/client.ts";
import { SOCIAL_DB } from "../near/social.ts";
import { nearOf } from "../payment/units.ts";
import { COMMIT_RESERVE, createChainRegistry, publishCommitments, readCommitments, type Published, type ShopCommitment } from "./chain.ts";

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
function fakeChain(balances: Readonly<Record<string, bigint>>) {
  const state = {
    height: 1000,
    values: new Map<string, { value: string; block: number }>(),
    balances: new Map(Object.entries(balances)),
    calls: [] as Call[],
    transfers: [] as { from: AccountId; to: AccountId; amount: bigint }[],
    failNext: null as TxResult | null,
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
    }
  };
  const port: Pick<NearClient, "view" | "balance" | "send"> = {
    async view(contractId, method, args) {
      assert.equal(contractId, SOCIAL_DB);
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
      state.height += 1;
      const tx = { hash: `hash${state.height}`, signerId: credential.accountId, receiverId, nonce: "1", base64: "" };
      if (state.failNext !== null) {
        const result = state.failNext;
        state.failNext = null;
        return { tx, result };
      }
      for (const action of txActions) apply(credential.accountId, receiverId, action);
      return { tx, result: { kind: "success" } };
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
          "": '{"scheme":"inferpay-merkle-sha256-v1","root":"a4c9ebe62bca0698da105b2b7cadcd6097a276a236bce104186f01b81423a7dc","leaves":2}',
        },
      },
    },
  };
  const read = readCommitments(live, [DISCLOSURE, LEGAL]);
  assert.deepEqual(read.get(DISCLOSURE), {
    status: "published",
    commitment: { scheme: SCHEME, root: "a4c9ebe62bca0698da105b2b7cadcd6097a276a236bce104186f01b81423a7dc", leaves: 2 },
    source: { kind: "chain", contract: SOCIAL_DB, account: DISCLOSURE, block: 277575111 },
  });
  assert.deepEqual(read.get(LEGAL), { status: "missing", contract: SOCIAL_DB, account: LEGAL });
});

test("a value that is not a commitment in this scheme reads as missing", () => {
  for (const value of ["not json", '{"scheme":"other","root":"ab","leaves":1}', '{"scheme":"inferpay-merkle-sha256-v1","root":"xyz","leaves":2}']) {
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
        data: { [DISCLOSURE]: { inferpay: { commitment: `{"scheme":"inferpay-merkle-sha256-v1","root":"${"a1".repeat(32)}","leaves":2}` } } },
        options: { refund_unused_deposit: true },
      },
      deposit: nearOf("0.02"),
    },
    {
      signer: LEGAL,
      receiver: SOCIAL_DB,
      method: "set",
      args: {
        data: { [LEGAL]: { inferpay: { commitment: `{"scheme":"inferpay-merkle-sha256-v1","root":"${"b2".repeat(32)}","leaves":3}` } } },
        options: { refund_unused_deposit: true },
      },
      deposit: nearOf("0.02"),
    },
  ]);
  assert.deepEqual(chain.transfers, []);

  const second = await publish(chain);
  assert.deepEqual(second.map((step) => step.kind), ["current", "current"]);
  assert.equal(chain.calls.length, 2);

  const registry = createChainRegistry({ chain: chain.port });
  const read = await registry.commitments([DISCLOSURE, LEGAL]);
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

async function askOn(chain: ReturnType<typeof fakeChain>, question: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    const config = loadConfig({ INFERPAY_DATA_DIR: root });
    assert.ok(config.ok);
    const runtime = await createRuntime(config.value, createChainRegistry({ chain: chain.port }));
    const amount = parseDecimalAmount("0.10");
    assert.ok(amount);
    const seen: Progress[] = [];
    await runtime.consumer.ask(question, { budget: { ...config.value.near, amount }, buyer: config.value.roster.defaultBuyer }, (step) => seen.push(step));
    return seen.map((step) => progressLine(step, "near-testnet")).join("\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fundedShops() {
  return fakeChain({ [DISCLOSURE]: nearOf("0.09"), [LEGAL]: nearOf("0.09"), [INSURANCE]: nearOf("0.09") });
}

test("the buyer verifies against the root it read from chain and says where it read it", async () => {
  const chain = fundedShops();
  await publish(chain, realShops());
  const text = await askOn(chain, "Does this policy cover an outpatient MRI?");
  assert.match(text, /^checks {4}1 of 1 verified by the buyer against the shop's committed root$/m);
  assert.match(text, /^ {10}from {6}NEAR testnet, written at block 1003 and read before paying$/m);
  assert.match(text, /^ {10}key {7}insurance\.ban\.inferpay\.testnet\/inferpay\/commitment in SocialDB v1\.social08\.testnet$/m);
  assert.match(text, /^ {10}link {6}https:\/\/testnet\.nearblocks\.io\/address\/insurance\.ban\.inferpay\.testnet$/m);
  assert.match(text, /^rate {6}5\/5$/m);
});

test("the root on chain decides, not the one the shop holds: honest evidence against another root is forged", async () => {
  const chain = fundedShops();
  await publish(chain, realShops().map((shop) => (shop.account === INSURANCE ? { ...shop, declared: commitment("ee", 3) } : shop)));
  const text = await askOn(chain, "Does this policy cover an outpatient MRI?");
  assert.match(text, /^checks {4}0 of 1 verified by the buyer against the shop's committed root, 1 FORGED$/m);
  assert.match(text, /^rate {6}1\/5 /m);
});

test("a shop with nothing on chain has only its word, and the rating cannot pass 3", async () => {
  const chain = fundedShops();
  const text = await askOn(chain, "Does this policy cover an outpatient MRI?");
  assert.match(text, /^ {10}unproven {2}match {9}outpatient MRI {2}covered$/m);
  assert.match(text, /^ {10}root {6}none: insurance\.ban\.inferpay\.testnet has published no commitment in SocialDB v1\.social08\.testnet$/m);
  assert.match(text, /^rate {6}3\/5 /m);
});
