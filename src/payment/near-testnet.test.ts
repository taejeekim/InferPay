import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newJobId, parseAccountId, parseAssetId, parseDecimalAmount, parseIdempotencyKey, type AccountId } from "../domain.ts";
import { newCredential, type SignedTx, type TxResult } from "../near/client.ts";
import type { PaymentRail, Transfer } from "./index.ts";
import { createTestnetRail } from "./near-testnet.ts";

const GAS = 44_600_000_000_000_000_000n;

const CLERK = must(parseAccountId("clerk.kyle.inferpay.testnet"));
const SHOP = must(parseAccountId("legal.stella.inferpay.testnet"));

type Port = Parameters<typeof createTestnetRail>[0]["chain"];

function fakeChain() {
  const state = {
    signed: [] as SignedTx[],
    sent: [] as { readonly base64: string; readonly wait: "FINAL" | "NONE" }[],
    landed: new Set<string>(),
    broadcastResults: [] as TxResult[],
  };
  const port: Port = {
    async sign(credential, receiverId) {
      const n = state.signed.length + 1;
      const tx: SignedTx = { hash: `hash${n}`, signerId: credential.accountId, receiverId, nonce: String(n), base64: `bytes${n}` };
      state.signed.push(tx);
      return tx;
    },
    async broadcast(tx, wait) {
      state.sent.push({ base64: tx.base64, wait });
      const next = state.broadcastResults.shift() ?? { kind: "success", burnt: GAS };
      if (next.kind === "success") state.landed.add(tx.hash);
      return next;
    },
    async status(tx) {
      return state.landed.has(tx.hash) ? { kind: "success", burnt: GAS } : { kind: "unknown" };
    },
  };
  return Object.assign(state, { port });
}

async function railOn(chain: ReturnType<typeof fakeChain>, file?: string): Promise<{ rail: PaymentRail; file: string }> {
  const path = file ?? join(await mkdtemp(join(tmpdir(), "inferpay-testnet-")), "rail.jsonl");
  const rail = createTestnetRail({
    file: path,
    chain: chain.port,
    credential: async (payer: AccountId) => (payer === CLERK ? newCredential(CLERK) : null),
    crash: null,
    onCrash() {
      throw new Error("no crash point is set");
    },
  });
  return { rail, file: path };
}

function transfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    jobId: newJobId(1_700_000_000_000),
    key: must(parseIdempotencyKey("nt_test-key")),
    payer: CLERK,
    recipient: SHOP,
    amount: { asset: must(parseAssetId("nep141:wrap.near")), symbol: "NEAR", amount: must(parseDecimalAmount("0.03")) },
    ...overrides,
  };
}

test("a first settle signs once, stores the bytes before broadcasting, and settles with the transaction hash", async () => {
  const chain = fakeChain();
  const { rail, file } = await railOn(chain);
  let storedAtBroadcast = "";
  const broadcast = chain.port.broadcast;
  chain.port.broadcast = async (tx, wait) => {
    storedAtBroadcast = await readFile(file, "utf8");
    return broadcast(tx, wait);
  };
  const status = await rail.settle(transfer());
  assert.equal(status.kind, "settled");
  if (status.kind === "settled") {
    assert.equal(status.receipt.correlationId, "hash1");
    assert.equal(status.receipt.rail, "near-testnet");
  }
  assert.equal(chain.signed.length, 1);
  assert.match(storedAtBroadcast, /"hash":"hash1"/);
  assert.match(storedAtBroadcast, /"base64":"bytes1"/);
});

test("the transfer pays from the bot that asked", async () => {
  const chain = fakeChain();
  const { rail } = await railOn(chain);
  await rail.settle(transfer());
  assert.equal(chain.signed[0]?.signerId, CLERK);
  assert.equal(chain.signed[0]?.receiverId, SHOP);
});

test("a retry after a lost answer rebroadcasts the same bytes and never signs again", async () => {
  const chain = fakeChain();
  const { rail, file } = await railOn(chain);
  chain.broadcastResults = [{ kind: "unreachable", detail: "socket hang up" }];
  const first = await rail.settle(transfer());
  assert.deepEqual(first, { kind: "uncertain", correlationId: "hash1" });

  const restarted = await railOn(chain, file);
  const second = await restarted.rail.settle(transfer());
  assert.equal(second.kind, "settled");
  if (second.kind === "settled") assert.equal(second.receipt.correlationId, "hash1");
  assert.equal(chain.signed.length, 1);
  assert.deepEqual(chain.sent.map((sent) => sent.base64), ["bytes1", "bytes1"]);
});

test("a retry after the transfer already landed settles without broadcasting", async () => {
  const chain = fakeChain();
  const { rail } = await railOn(chain);
  chain.broadcastResults = [{ kind: "pending" }];
  assert.deepEqual(await rail.settle(transfer()), { kind: "pending", correlationId: "hash1" });
  chain.landed.add("hash1");
  const again = await rail.settle(transfer());
  assert.equal(again.kind, "settled");
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.signed.length, 1);
});

test("no second signature while the first transaction can still land", async () => {
  const chain = fakeChain();
  const { rail } = await railOn(chain);
  chain.broadcastResults = [
    { kind: "unreachable", detail: "timeout" },
    { kind: "pending" },
    { kind: "refused", reason: "nonce already used", never: "nonce-used" },
    { kind: "unreachable", detail: "timeout" },
  ];
  assert.equal((await rail.settle(transfer())).kind, "uncertain");
  assert.deepEqual(await rail.settle(transfer()), { kind: "pending", correlationId: "hash1" });
  assert.deepEqual(await rail.settle(transfer()), { kind: "uncertain", correlationId: "hash1" });
  assert.deepEqual(await rail.settle(transfer()), { kind: "uncertain", correlationId: "hash1" });
  assert.equal(chain.signed.length, 1);
  assert.ok(chain.sent.every((sent) => sent.base64 === "bytes1"));
});

test("a fresh signature only after the chain refuses the stored bytes as expired and has no record of them", async () => {
  const chain = fakeChain();
  const { rail, file } = await railOn(chain);
  chain.broadcastResults = [
    { kind: "unreachable", detail: "timeout" },
    { kind: "refused", reason: "transaction expired", never: "expired" },
    { kind: "success", burnt: GAS },
  ];
  await rail.settle(transfer());
  const status = await rail.settle(transfer());
  assert.equal(status.kind, "settled");
  if (status.kind === "settled") assert.equal(status.receipt.correlationId, "hash2");
  assert.equal(chain.signed.length, 2);
  assert.deepEqual(chain.sent.map((sent) => sent.base64), ["bytes1", "bytes1", "bytes2"]);
  const rows = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(rows.length, 2);
});

test("an expired transaction that had landed settles under its own hash", async () => {
  const chain = fakeChain();
  const { rail } = await railOn(chain);
  chain.broadcastResults = [{ kind: "unreachable", detail: "timeout" }, { kind: "refused", reason: "transaction expired", never: "expired" }];
  await rail.settle(transfer());
  let lookups = 0;
  chain.port.status = async () => {
    lookups += 1;
    return lookups === 1 ? { kind: "unknown" } : { kind: "success", burnt: GAS };
  };
  const settled = await rail.settle(transfer());
  assert.equal(settled.kind, "settled");
  if (settled.kind === "settled") assert.equal(settled.receipt.correlationId, "hash1");
  assert.equal(chain.signed.length, 1);
});

test("chain outcomes map onto payment statuses", async () => {
  const cases: { result: TxResult; kind: string }[] = [
    { result: { kind: "success", burnt: GAS }, kind: "settled" },
    { result: { kind: "failed", reason: "{\"ActionError\":{}}" }, kind: "rejected" },
    { result: { kind: "refused", reason: "NotEnoughBalanceError: balance 1 is below cost 2", never: null }, kind: "rejected" },
    { result: { kind: "pending" }, kind: "pending" },
    { result: { kind: "unreachable", detail: "fetch failed" }, kind: "uncertain" },
  ];
  for (const { result, kind } of cases) {
    const chain = fakeChain();
    const { rail } = await railOn(chain);
    chain.broadcastResults = [result];
    const status = await rail.settle(transfer());
    assert.equal(status.kind, kind, result.kind);
    if (status.kind === "rejected" && result.kind === "refused") assert.match(status.reason, /NotEnoughBalance/);
  }
});

test("a payer with no saved key is rejected before anything is signed", async () => {
  const chain = fakeChain();
  const { rail } = await railOn(chain);
  const status = await rail.settle(transfer({ payer: must(parseAccountId("writer.kyle.inferpay.testnet")) }));
  assert.equal(status.kind, "rejected");
  if (status.kind === "rejected") assert.match(status.reason, /testnet setup/);
  assert.equal(chain.signed.length, 0);
});

test("a key already used for a different transfer is refused", async () => {
  const chain = fakeChain();
  const { rail } = await railOn(chain);
  chain.broadcastResults = [{ kind: "unreachable", detail: "timeout" }];
  await rail.settle(transfer());
  const other = await rail.settle(transfer({ recipient: must(parseAccountId("insurance.ban.inferpay.testnet")) }));
  assert.equal(other.kind, "rejected");
  assert.equal(chain.signed.length, 1);
});

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture failed its check");
  return value;
}
