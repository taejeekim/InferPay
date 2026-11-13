import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isCorrelationId, isIdempotencyKey, type CorrelationId } from "../domain.ts";
import type { PaymentRail, PaymentReceipt, PaymentStatus, Transfer } from "./index.ts";
import { appendJsonl, readJsonl, serialize } from "./jsonl.ts";

type Row = { readonly key: string; readonly correlationId: string; readonly outcome: "uncertain" | "settled" };

export function createMockRail(config: { readonly root: string; readonly chaos: "none" | "uncertain-once" }): PaymentRail {
  const file = join(config.root, "mock-rail.jsonl");
  const enqueue = serialize();
  return {
    kind: "mock",
    mintKey() {
      const key = `mock_${randomUUID()}`;
      if (!isIdempotencyKey(key)) throw new Error("mock key failed its check");
      return key;
    },
    settle(transfer) {
      return enqueue(() => settleMock(file, config.chaos, transfer));
    },
  };
}

async function settleMock(
  file: string,
  chaos: "none" | "uncertain-once",
  transfer: Transfer,
): Promise<PaymentStatus> {
  const rows = await readJsonl(file, parseRow);
  const known = lastRow(rows, transfer.key);
  if (known?.outcome === "settled") return settled(transfer, known.correlationId);
  if (known?.outcome === "uncertain") {
    await appendJsonl(file, { key: transfer.key, correlationId: known.correlationId, outcome: "settled" });
    return settled(transfer, known.correlationId);
  }
  const correlationId = freshCorrelation();
  if (chaos === "uncertain-once") {
    await appendJsonl(file, { key: transfer.key, correlationId, outcome: "uncertain" });
    return { kind: "uncertain", correlationId };
  }
  await appendJsonl(file, { key: transfer.key, correlationId, outcome: "settled" });
  return settled(transfer, correlationId);
}

function settled(transfer: Transfer, correlation: string): PaymentStatus {
  if (!isCorrelationId(correlation)) return { kind: "uncertain", correlationId: null };
  const receipt: PaymentReceipt = {
    key: transfer.key,
    correlationId: correlation,
    amount: transfer.amount,
    recipient: transfer.recipient,
    rail: "mock",
  };
  return { kind: "settled", receipt };
}

function freshCorrelation(): CorrelationId {
  const correlationId = `mock-${randomBytes(2).toString("hex")}`;
  if (!isCorrelationId(correlationId)) throw new Error("mock correlation id failed its check");
  return correlationId;
}

function lastRow(rows: readonly Row[], key: string): Row | undefined {
  let found: Row | undefined;
  for (const row of rows) {
    if (row.key === key) found = row;
  }
  return found;
}

function parseRow(raw: unknown): Row | null {
  if (typeof raw !== "object" || raw === null) return null;
  if (!("key" in raw) || typeof raw.key !== "string") return null;
  if (!("correlationId" in raw) || typeof raw.correlationId !== "string") return null;
  if (!("outcome" in raw) || (raw.outcome !== "uncertain" && raw.outcome !== "settled")) return null;
  return { key: raw.key, correlationId: raw.correlationId, outcome: raw.outcome };
}
