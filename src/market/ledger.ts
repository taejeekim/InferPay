import { open, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  isAccountId,
  isAssetId,
  isCorrelationId,
  isDecimalAmount,
  isIdempotencyKey,
  isIsoTime,
  isJobId,
  isModelId,
  isProviderId,
  isStars,
  parseJobId,
  type JobId,
} from "../domain.ts";
import { assertedCheckSchema, needSchema, pinnedCommitmentSchema } from "../commitment/index.ts";
import type { JobEvent } from "./job.ts";
import { UNVERIFIED_REASONS, type CallAttestation } from "../inference/attest.ts";

export class LedgerReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerReadError";
  }
}

export interface Ledger {
  read(jobId: JobId): Promise<readonly JobEvent[]>;
  append(jobId: JobId, event: JobEvent): Promise<void>;
  appendIfAbsent(jobId: JobId, event: JobEvent): Promise<boolean>;
  lock(jobId: JobId): Promise<{ release(): Promise<void> } | null>;
  all(): Promise<readonly { jobId: JobId; events: readonly JobEvent[] }[]>;
}

export function createFileLedger(root: string): Ledger {
  const jobs = join(root, "jobs");
  return {
    async read(jobId) {
      return readEvents(join(jobs, `${jobId}.jsonl`));
    },
    async append(jobId, event) {
      await writeLine(join(jobs, `${jobId}.jsonl`), event);
    },
    async appendIfAbsent(jobId, event) {
      const events = await readEvents(join(jobs, `${jobId}.jsonl`));
      if (events.some((item) => item.type === event.type)) return false;
      await writeLine(join(jobs, `${jobId}.jsonl`), event);
      return true;
    },
    lock(jobId) {
      return lockJob(join(jobs, `${jobId}.lock`));
    },
    async all() {
      let names: string[];
      try {
        names = await readdir(jobs);
      } catch (error) {
        if (isErrno(error, "ENOENT")) return [];
        throw error;
      }
      const rows: { jobId: JobId; events: readonly JobEvent[] }[] = [];
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const jobId = parseJobId(name.slice(0, -".jsonl".length));
        if (!jobId) continue;
        try {
          rows.push({ jobId, events: await readEvents(join(jobs, name)) });
        } catch (error) {
          if (error instanceof LedgerReadError) continue;
          throw error;
        }
      }
      return rows;
    },
  };
}

// A shop's answer is outside input. One the ledger could not read back must never be written to it.
export function isStorableAnswer(answer: unknown): boolean {
  let roundTrip: unknown;
  try {
    roundTrip = JSON.parse(JSON.stringify(answer));
  } catch {
    return false;
  }
  return answerSchema.safeParse(roundTrip).success;
}

export function parseJobEvent(line: string): JobEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return null;
  return brandEvent(parsed.data);
}

const priceSchema = z.object({
  asset: z.string(),
  symbol: z.string().min(1),
  amount: z.string(),
});

const yocto = z.string().regex(/^\d+$/);

const orderSchema = z.object({
  jobId: z.string(),
  providerId: z.string(),
  question: z.string(),
  needs: z.array(needSchema),
  offer: priceSchema,
  budget: priceSchema,
  reserve: z.object({ paymentGas: yocto, ratingGas: yocto, ratingStorage: yocto, firstRating: z.boolean() }),
  payFrom: z.string(),
  commitment: pinnedCommitmentSchema,
});

const attestationSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("verified"), model: z.string(), completionId: z.string(), signer: z.string() }),
  z.object({
    verdict: z.literal("unverified"),
    model: z.string(),
    completionId: z.string().nullable(),
    reason: z.enum(UNVERIFIED_REASONS),
    detail: z.string(),
  }),
]);

const answerSchema = z.object({
  text: z.string(),
  checks: z.array(assertedCheckSchema),
  model: z.string(),
  inference: z.enum(["near-ai", "stub"]),
  // Jobs answered before attestation existed made no checked calls.
  attestation: z.array(attestationSchema).default([]),
});

const receiptSchema = z.object({
  key: z.string(),
  correlationId: z.string(),
  amount: priceSchema,
  recipient: z.string(),
  rail: z.enum(["mock", "near-intents", "near-testnet"]),
  feeYocto: z.string().regex(/^\d+$/).nullable(),
});

const count = z.number().int().nonnegative();

const payoutSchema = z.object({
  amount: priceSchema,
  basis: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("forged"), forged: count }),
    z.object({ kind: z.literal("share"), proven: count, needed: count }),
  ]),
});

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("opened"), at: z.string(), order: orderSchema, quote: priceSchema, payTo: z.string() }),
  z.object({ type: z.literal("fulfil-failed"), at: z.string(), reason: z.string(), retryable: z.boolean() }),
  z.object({ type: z.literal("delivered"), at: z.string(), answer: answerSchema }),
  z.object({ type: z.literal("payout-decided"), at: z.string(), payout: payoutSchema }),
  z.object({ type: z.literal("payment-intended"), at: z.string(), key: z.string() }),
  z.object({
    type: z.literal("payment-pending"),
    at: z.string(),
    correlationId: z.string().nullable(),
    uncertain: z.boolean(),
  }),
  z.object({ type: z.literal("payment-settled"), at: z.string(), receipt: receiptSchema }),
  z.object({ type: z.literal("payment-rejected"), at: z.string(), reason: z.string() }),
  z.object({ type: z.literal("rated"), at: z.string(), rating: z.number() }),
  z.object({ type: z.literal("rating-posted"), at: z.string(), tx: z.string().min(1) }),
]);

type ParsedEvent = z.infer<typeof eventSchema>;

function brandEvent(event: ParsedEvent): JobEvent | null {
  const at = isIsoTime(event.at) ? event.at : null;
  if (!at) return null;
  switch (event.type) {
    case "opened": {
      const order = brandOrder(event.order);
      const quote = brandPrice(event.quote);
      if (!order || !quote || !isAccountId(event.payTo)) return null;
      return { type: "opened", at, order, quote, payTo: event.payTo };
    }
    case "payment-intended":
      if (!isIdempotencyKey(event.key)) return null;
      return { type: "payment-intended", at, key: event.key };
    case "payment-pending": {
      if (event.correlationId !== null && !isCorrelationId(event.correlationId)) return null;
      return { type: "payment-pending", at, correlationId: event.correlationId, uncertain: event.uncertain };
    }
    case "payment-settled": {
      const receipt = brandReceipt(event.receipt);
      if (!receipt) return null;
      return { type: "payment-settled", at, receipt };
    }
    case "payment-rejected":
      return { type: "payment-rejected", at, reason: event.reason };
    case "fulfil-failed":
      return { type: "fulfil-failed", at, reason: event.reason, retryable: event.retryable };
    case "payout-decided": {
      const amount = brandPrice(event.payout.amount);
      if (!amount) return null;
      return { type: "payout-decided", at, payout: { amount, basis: event.payout.basis } };
    }
    case "delivered": {
      if (!isModelId(event.answer.model)) return null;
      const attestation: CallAttestation[] = [];
      for (const item of event.answer.attestation) {
        if (!isModelId(item.model)) return null;
        attestation.push({ ...item, model: item.model });
      }
      return {
        type: "delivered",
        at,
        answer: {
          text: event.answer.text,
          checks: event.answer.checks,
          model: event.answer.model,
          inference: event.answer.inference,
          attestation,
        },
      };
    }
    case "rated":
      if (!isStars(event.rating)) return null;
      return { type: "rated", at, rating: event.rating };
    case "rating-posted":
      return { type: "rating-posted", at, tx: event.tx };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function brandOrder(order: z.infer<typeof orderSchema>) {
  const offer = brandPrice(order.offer);
  const budget = brandPrice(order.budget);
  if (!isJobId(order.jobId) || !isProviderId(order.providerId) || !isAccountId(order.payFrom) || !offer || !budget) return null;
  return {
    jobId: order.jobId,
    providerId: order.providerId,
    question: order.question,
    needs: order.needs,
    offer,
    budget,
    reserve: order.reserve,
    payFrom: order.payFrom,
    commitment: order.commitment,
  };
}

function isJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function brandPrice(price: z.infer<typeof priceSchema>) {
  if (!isAssetId(price.asset) || !isDecimalAmount(price.amount)) return null;
  return { asset: price.asset, symbol: price.symbol, amount: price.amount };
}

function brandReceipt(receipt: z.infer<typeof receiptSchema>) {
  const amount = brandPrice(receipt.amount);
  if (!isIdempotencyKey(receipt.key) || !isCorrelationId(receipt.correlationId) || !isAccountId(receipt.recipient) || !amount) {
    return null;
  }
  return {
    key: receipt.key,
    correlationId: receipt.correlationId,
    amount,
    recipient: receipt.recipient,
    rail: receipt.rail,
    feeYocto: receipt.feeYocto,
  };
}

async function readEvents(path: string): Promise<readonly JobEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const events: JobEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) continue;
    const event = parseJobEvent(line);
    if (event) {
      events.push(event);
      continue;
    }
    // A crash can leave a partial last line. Dropping that line lets the next run resume from the last complete event.
    if (index === lines.length - 1 && !isJson(line)) continue;
    throw new LedgerReadError(`ledger line ${index + 1} is not a job event`);
  }
  return events;
}

async function writeLine(path: string, event: JobEvent): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.write(`${JSON.stringify(event)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function lockJob(path: string): Promise<{ release(): Promise<void> } | null> {
  await mkdir(join(path, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return { release: () => rm(path, { force: true }) };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const owner = await readPid(path);
      if (owner !== null && isAlive(owner)) return null;
      await rm(path, { force: true });
    }
  }
  return null;
}

async function readPid(path: string): Promise<number | null> {
  try {
    const text = await readFile(path, "utf8");
    const pid = Number(text.trim());
    return Number.isInteger(pid) ? pid : null;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
