import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isCorrelationId, isIdempotencyKey, type CorrelationId } from "../domain.ts";
import type { PaymentRail, PaymentReceipt, PaymentStatus, Transfer } from "./index.ts";

type Row = { readonly key: string; readonly correlationId: string; readonly outcome: "uncertain" | "settled" };

export function createMockRail(config: { readonly root: string; readonly chaos: "none" | "uncertain-once" }): PaymentRail {
  const file = join(config.root, "mock-rail.jsonl");
  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op, op);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
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
  const rows = await readRows(file);
  const known = lastRow(rows, transfer.key);
  if (known?.outcome === "settled") return settled(transfer, known.correlationId);
  if (known?.outcome === "uncertain") {
    await appendRow(file, { key: transfer.key, correlationId: known.correlationId, outcome: "settled" });
    return settled(transfer, known.correlationId);
  }
  const correlationId = freshCorrelation();
  if (chaos === "uncertain-once") {
    await appendRow(file, { key: transfer.key, correlationId, outcome: "uncertain" });
    return { kind: "uncertain", correlationId };
  }
  await appendRow(file, { key: transfer.key, correlationId, outcome: "settled" });
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

async function readRows(file: string): Promise<readonly Row[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const rows: Row[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) continue;
    const row = parseRow(line);
    if (row) {
      rows.push(row);
      continue;
    }
    if (index === lines.length - 1) continue;
    throw new Error(`mock rail line ${index + 1} is not a record`);
  }
  return rows;
}

function parseRow(line: string): Row | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  if (!("key" in raw) || typeof raw.key !== "string") return null;
  if (!("correlationId" in raw) || typeof raw.correlationId !== "string") return null;
  if (!("outcome" in raw) || (raw.outcome !== "uncertain" && raw.outcome !== "settled")) return null;
  return { key: raw.key, correlationId: raw.correlationId, outcome: raw.outcome };
}

async function appendRow(file: string, row: Row): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  const handle = await open(file, "a");
  try {
    await handle.write(`${JSON.stringify(row)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
