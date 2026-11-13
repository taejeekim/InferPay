import type { Commitment } from "../commitment/index.ts";
import { nearOf } from "../payment/units.ts";

export type Row = {
  readonly kind: "accounts" | "transfer" | "commitment" | "rating tx" | "rating";
  readonly what: string;
  readonly ok: boolean;
  readonly detail: string;
};

type ChainTx = {
  readonly transaction: { readonly signer_id: string; readonly receiver_id: string; readonly actions: readonly unknown[] };
  readonly status: unknown;
};

function asTx(raw: unknown): ChainTx | null {
  if (typeof raw !== "object" || raw === null || !("transaction" in raw) || !("status" in raw)) return null;
  return raw as ChainTx;
}

function succeeded(status: unknown): boolean {
  return typeof status === "object" && status !== null && "SuccessValue" in status;
}

export function matchTransfer(
  expected: { readonly what: string; readonly hash: string; readonly signer: string; readonly receiver: string; readonly near: string },
  raw: unknown,
): Row {
  const what = `${expected.near} NEAR  ${expected.signer} -> ${expected.receiver}  (${expected.what})`;
  const found = asTx(raw);
  if (!found) return { kind: "transfer", what, ok: false, detail: `${expected.hash} is unknown to the chain` };
  const action = found.transaction.actions[0];
  const deposit = typeof action === "object" && action !== null && "Transfer" in action
    ? (action as { Transfer: { deposit: string } }).Transfer.deposit
    : null;
  const problems = [
    found.transaction.signer_id === expected.signer ? null : `signer is ${found.transaction.signer_id}`,
    found.transaction.receiver_id === expected.receiver ? null : `receiver is ${found.transaction.receiver_id}`,
    found.transaction.actions.length === 1 && deposit !== null ? null : "not a single Transfer action",
    deposit === nearOf(expected.near).toString() ? null : `deposit is ${deposit ?? "absent"} yocto`,
    succeeded(found.status) ? null : "the transaction did not succeed",
  ].filter((item) => item !== null);
  return { kind: "transfer", what, ok: problems.length === 0, detail: problems.length === 0 ? `tx ${expected.hash}` : problems.join("; ") };
}

export function matchCommitment(shop: string, local: Commitment, onChain: unknown): Row {
  const what = `${shop} dataset root`;
  const text = dig(onChain, [shop, "inferpay", "commitment"]);
  if (typeof text !== "string") return { kind: "commitment", what, ok: false, detail: "no commitment on chain" };
  let published: { root?: unknown; leaves?: unknown; scheme?: unknown };
  try {
    published = JSON.parse(text) as typeof published;
  } catch {
    return { kind: "commitment", what, ok: false, detail: "the commitment on chain is not JSON" };
  }
  const ok = published.root === local.root && published.leaves === local.leaves && published.scheme === local.scheme;
  return {
    kind: "commitment",
    what,
    ok,
    detail: ok
      ? `on chain ${local.root} equals the root recomputed from this repository's dataset`
      : `on chain ${String(published.root)}, recomputed here ${local.root}`,
  };
}

export function matchRatingTx(
  expected: { readonly hash: string; readonly rater: string; readonly jobId: string },
  socialDb: string,
  raw: unknown,
): Row {
  const what = `${expected.rater} wrote its rating for ${expected.jobId}`;
  const found = asTx(raw);
  if (!found) return { kind: "rating tx", what, ok: false, detail: `${expected.hash} is unknown to the chain` };
  const action = found.transaction.actions[0];
  const method = typeof action === "object" && action !== null && "FunctionCall" in action
    ? (action as { FunctionCall: { method_name: string } }).FunctionCall.method_name
    : null;
  const problems = [
    found.transaction.signer_id === expected.rater ? null : `signer is ${found.transaction.signer_id}`,
    found.transaction.receiver_id === socialDb ? null : `receiver is ${found.transaction.receiver_id}`,
    method === "set" ? null : `first action calls ${method ?? "nothing"}`,
    succeeded(found.status) ? null : "the transaction did not succeed",
  ].filter((item) => item !== null);
  return { kind: "rating tx", what, ok: problems.length === 0, detail: problems.length === 0 ? `tx ${expected.hash}` : problems.join("; ") };
}

export function matchRating(
  expected: { readonly rater: string; readonly jobId: string; readonly shop: string; readonly stars: number; readonly payment: string },
  onChain: unknown,
): Row {
  const what = `${expected.stars}/5 for ${expected.shop}, bound to payment ${expected.payment.slice(0, 8)}…`;
  const text = dig(onChain, [expected.rater, "inferpay", "ratings", expected.jobId]);
  if (typeof text !== "string") return { kind: "rating", what, ok: false, detail: "no rating on chain under that key" };
  let stored: { shop?: unknown; stars?: unknown; payment?: unknown; forged?: unknown; verified?: unknown };
  try {
    stored = JSON.parse(text) as typeof stored;
  } catch {
    return { kind: "rating", what, ok: false, detail: "the rating on chain is not JSON" };
  }
  const ok = stored.shop === expected.shop && stored.stars === expected.stars && stored.payment === expected.payment;
  return {
    kind: "rating",
    what,
    ok,
    detail: ok
      ? `${expected.rater}/inferpay/ratings/${expected.jobId}: ${String(stored.verified)} verified, ${String(stored.forged)} forged`
      : `on chain: ${text}`,
  };
}

function dig(value: unknown, path: readonly string[]): unknown {
  let at = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null || !(key in at)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}
