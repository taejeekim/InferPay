import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isCorrelationId, isIdempotencyKey, parseAccountId, type AccountId } from "../domain.ts";
import type { PaymentConfig } from "../config.ts";
import {
  actions,
  createNearClient,
  loadCredential,
  type Credential,
  type NearClient,
  type SignedTx,
  type TxResult,
} from "../near/client.ts";
import type { PaymentRail, PaymentStatus, Transfer } from "./index.ts";
import { appendJsonl, readJsonl, serialize } from "./jsonl.ts";
import { decimalToAtomic } from "./units.ts";

export type CrashPoint = "after-sign" | "after-broadcast";

type Signed = SignedTx & { readonly key: string; readonly yocto: string };

export type TestnetRailDeps = {
  readonly file: string;
  readonly chain: Pick<NearClient, "sign" | "broadcast" | "status">;
  readonly credential: (payer: AccountId) => Promise<Credential | null>;
  readonly crash: CrashPoint | null;
  readonly onCrash: (point: CrashPoint, tx: Signed) => never;
};

export function createNearTestnetRail(config: Extract<PaymentConfig, { kind: "near-testnet" }>): PaymentRail {
  return createTestnetRail({
    file: join(config.root, "near-testnet-rail.jsonl"),
    chain: createNearClient(),
    credential: (payer) => loadCredential(config.credentialsDir, payer),
    crash: config.crash,
    onCrash(point, tx) {
      process.stderr.write(`INFERPAY_TEST_CRASH=${point}: exiting with key ${tx.key} and transaction ${tx.hash} stored\n`);
      process.exit(137);
    },
  });
}

// Each idempotency key owns the signed bytes stored under it. A retry only rebroadcasts or looks up those bytes,
// and signs a replacement only once the chain refuses the old transaction as expired and an archival node has
// no record of it, so the key can never move NEAR twice.
export function createTestnetRail(deps: TestnetRailDeps): PaymentRail {
  const enqueue = serialize();
  return {
    kind: "near-testnet",
    mintKey() {
      const key = `nt_${randomUUID()}`;
      if (!isIdempotencyKey(key)) throw new Error("testnet key failed its check");
      return key;
    },
    settle(transfer) {
      return enqueue(() => settle(deps, transfer));
    },
  };
}

async function settle(deps: TestnetRailDeps, transfer: Transfer): Promise<PaymentStatus> {
  const yocto = decimalToAtomic(transfer.amount.symbol, transfer.amount.amount);
  if (yocto === null) return { kind: "rejected", reason: `${transfer.amount.amount} ${transfer.amount.symbol} is not a NEAR amount` };
  const stored = await latest(deps.file, transfer.key);
  if (stored === null) return signAndSend(deps, transfer, yocto);
  if (stored.signerId !== transfer.payer || stored.receiverId !== transfer.recipient || stored.yocto !== yocto) {
    return { kind: "rejected", reason: `key ${transfer.key} already signed a different transfer` };
  }

  const seen = await deps.chain.status(stored);
  if (seen.kind !== "unknown") return toStatus(seen, stored, transfer);

  const again = await deps.chain.broadcast(stored, "FINAL");
  if (again.kind !== "refused" || again.never !== "expired") return toStatus(again, stored, transfer);
  // Expired is permanent, so the stored bytes can no longer land. Ask once more in case they landed before expiring.
  const last = await deps.chain.status(stored);
  if (last.kind === "unknown") return signAndSend(deps, transfer, yocto);
  return toStatus(last, stored, transfer);
}

async function signAndSend(deps: TestnetRailDeps, transfer: Transfer, yocto: string): Promise<PaymentStatus> {
  const credential = await deps.credential(transfer.payer);
  if (credential === null) {
    return { kind: "rejected", reason: `no saved key for ${transfer.payer}. Run: npx inferpay testnet setup` };
  }
  const tx = await deps.chain.sign(credential, transfer.recipient, [actions.transfer(BigInt(yocto))]);
  const signed: Signed = { ...tx, key: transfer.key, yocto };
  await appendJsonl(deps.file, signed);
  if (deps.crash === "after-sign") deps.onCrash("after-sign", signed);
  if (deps.crash === "after-broadcast") {
    await deps.chain.broadcast(signed, "NONE");
    deps.onCrash("after-broadcast", signed);
  }
  return toStatus(await deps.chain.broadcast(signed, "FINAL"), signed, transfer);
}

function toStatus(result: TxResult, tx: SignedTx, transfer: Transfer): PaymentStatus {
  if (!isCorrelationId(tx.hash)) return { kind: "uncertain", correlationId: null };
  const correlationId = tx.hash;
  switch (result.kind) {
    case "success":
      return {
        kind: "settled",
        receipt: { key: transfer.key, correlationId, amount: transfer.amount, recipient: transfer.recipient, rail: "near-testnet" },
      };
    case "failed":
      return { kind: "rejected", reason: `transaction ${tx.hash} failed on chain: ${result.reason}` };
    case "refused":
      // A used nonce may mean these bytes already landed, so only expiry, checked in settle, proves they never will.
      if (result.never === null) return { kind: "rejected", reason: `testnet refused the transfer: ${result.reason}` };
      return { kind: "uncertain", correlationId };
    case "pending":
    case "unknown":
      return { kind: "pending", correlationId };
    case "unreachable":
      return { kind: "uncertain", correlationId };
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

async function latest(file: string, key: string): Promise<Signed | null> {
  const rows = await readJsonl(file, parseSigned);
  let found: Signed | null = null;
  for (const row of rows) {
    if (row.key === key) found = row;
  }
  return found;
}

function parseSigned(raw: unknown): Signed | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const { key, hash, nonce, base64, yocto } = row;
  if (typeof key !== "string" || typeof hash !== "string" || typeof nonce !== "string") return null;
  if (typeof base64 !== "string" || typeof yocto !== "string") return null;
  const signerId = typeof row.signerId === "string" ? parseAccountId(row.signerId) : null;
  const receiverId = typeof row.receiverId === "string" ? parseAccountId(row.receiverId) : null;
  if (signerId === null || receiverId === null) return null;
  return { key, hash, signerId, receiverId, nonce, base64, yocto };
}
