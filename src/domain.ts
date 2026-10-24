import { randomBytes } from "node:crypto";

declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type ProviderId = Brand<string, "ProviderId">;
export type JobId = Brand<string, "JobId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type AccountId = Brand<string, "AccountId">;
export type AssetId = Brand<string, "AssetId">;
export type ModelId = Brand<string, "ModelId">;
export type IsoTime = Brand<string, "IsoTime">;
export type DecimalAmount = Brand<string, "DecimalAmount">;
export type Stars = Brand<1 | 2 | 3 | 4 | 5, "Stars">;

export type Price = {
  readonly asset: AssetId;
  readonly symbol: string;
  readonly amount: DecimalAmount;
};

export interface Secret {
  reveal(): string;
  toJSON(): "[redacted]";
  toString(): "[redacted]";
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DECIMAL = /^(0|[1-9]\d*)(\.\d{1,18})?$/;
const JOB_ID = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
const ACCOUNT_ID = /^[A-Za-z0-9._-]+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FRACTION_DIGITS = 18;

export function secret(value: string): Secret {
  return {
    reveal: () => value,
    toJSON: () => "[redacted]",
    toString: () => "[redacted]",
  };
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_ID.test(value);
}

export function parseProviderId(raw: string): ProviderId | null {
  if (!isProviderId(raw)) return null;
  return raw;
}

export function isJobId(value: string): value is JobId {
  return JOB_ID.test(value);
}

export function parseJobId(raw: string): JobId | null {
  if (!isJobId(raw)) return null;
  return raw;
}

export function isIdempotencyKey(value: string): value is IdempotencyKey {
  return value.length > 0 && !/\s/.test(value);
}

export function parseIdempotencyKey(raw: string): IdempotencyKey | null {
  if (!isIdempotencyKey(raw)) return null;
  return raw;
}

export function isCorrelationId(value: string): value is CorrelationId {
  return value.length > 0 && !/\s/.test(value);
}

export function parseCorrelationId(raw: string): CorrelationId | null {
  if (!isCorrelationId(raw)) return null;
  return raw;
}

export function isAccountId(value: string): value is AccountId {
  return ACCOUNT_ID.test(value);
}

export function parseAccountId(raw: string): AccountId | null {
  if (!isAccountId(raw)) return null;
  return raw;
}

export function isAssetId(value: string): value is AssetId {
  return value.length > 0 && !/\s/.test(value);
}

export function parseAssetId(raw: string): AssetId | null {
  if (!isAssetId(raw)) return null;
  return raw;
}

export function isModelId(value: string): value is ModelId {
  return value.length > 0 && !/\s/.test(value);
}

export function parseModelId(raw: string): ModelId | null {
  if (!isModelId(raw)) return null;
  return raw;
}

export function isIsoTime(value: string): value is IsoTime {
  if (!ISO_TIME.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

export function parseIsoTime(raw: string): IsoTime | null {
  if (!isIsoTime(raw)) return null;
  return raw;
}

export function isDecimalAmount(value: string): value is DecimalAmount {
  return DECIMAL.test(value);
}

export function parseDecimalAmount(raw: string): DecimalAmount | null {
  if (!isDecimalAmount(raw)) return null;
  return raw;
}

export function isStars(value: number): value is Stars {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

export function parseStars(raw: number): Stars | null {
  if (!isStars(raw)) return null;
  return raw;
}

export function newJobId(now = Date.now()): JobId {
  const id = `job_${ulid(now)}`;
  if (!isJobId(id)) throw new Error("minted job id failed its check");
  return id;
}

export function compareSameAsset(a: Price, b: Price): -1 | 0 | 1 | "different-asset" {
  if (a.asset !== b.asset) return "different-asset";
  const left = scaled(a.amount);
  const right = scaled(b.amount);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function scaled(amount: DecimalAmount): bigint {
  const parts = amount.split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  const padded = frac.padEnd(FRACTION_DIGITS, "0");
  return BigInt(whole) * 10n ** BigInt(FRACTION_DIGITS) + BigInt(padded);
}

function ulid(now: number): string {
  let time = Math.max(0, Math.floor(now));
  let timestamp = "";
  for (let i = 0; i < 10; i += 1) {
    timestamp = crockford(time % 32) + timestamp;
    time = Math.floor(time / 32);
  }
  let random = 0n;
  for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
  let tail = "";
  for (let i = 0; i < 16; i += 1) {
    tail = crockford(Number(random & 31n)) + tail;
    random >>= 5n;
  }
  return timestamp + tail;
}

function crockford(index: number): string {
  const char = CROCKFORD[index];
  if (char === undefined) throw new Error("ulid alphabet index out of range");
  return char;
}
