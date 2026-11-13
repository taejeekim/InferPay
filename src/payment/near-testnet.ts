import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isCorrelationId, isIdempotencyKey } from "../domain.ts";
import type { PaymentConfig } from "../config.ts";
import { actions, createNearClient, loadCredential, type SignedTx, type TxResult } from "../near/client.ts";
import { sendOnce, type OutboxDeps } from "../near/outbox.ts";
import type { PaymentRail, PaymentStatus, Transfer } from "./index.ts";
import { serialize } from "./jsonl.ts";
import { decimalToAtomic } from "./units.ts";

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

// The idempotency key is the outbox key, so a retried settle can never move NEAR twice.
export function createTestnetRail(deps: OutboxDeps): PaymentRail {
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

async function settle(deps: OutboxDeps, transfer: Transfer): Promise<PaymentStatus> {
  const yocto = decimalToAtomic(transfer.amount.symbol, transfer.amount.amount);
  if (yocto === null) return { kind: "rejected", reason: `${transfer.amount.amount} ${transfer.amount.symbol} is not a NEAR amount` };
  const sent = await sendOnce(deps, {
    key: transfer.key,
    signer: transfer.payer,
    receiver: transfer.recipient,
    yocto,
    actions: [actions.transfer(BigInt(yocto))],
    idempotent: false,
  });
  if (sent.kind === "key-reused") return { kind: "rejected", reason: `key ${transfer.key} already signed a different transfer` };
  if (sent.kind === "no-credential") {
    return { kind: "rejected", reason: `no saved key for ${transfer.payer}. Run: npx inferpay testnet setup` };
  }
  return toStatus(sent.result, sent.tx, transfer);
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
