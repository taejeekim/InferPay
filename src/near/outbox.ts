import { parseAccountId, type AccountId } from "../domain.ts";
import { appendJsonl, readJsonl } from "../payment/jsonl.ts";
import type { Action, Credential, NearClient, SignedTx, TxResult } from "./client.ts";

export type CrashPoint = "after-sign" | "after-broadcast";

// yocto is the NEAR the transaction takes from its signer: a transfer's amount or a call's attached deposit.
export type StoredTx = SignedTx & { readonly key: string; readonly yocto: string };

export type OutboxDeps = {
  readonly file: string;
  readonly chain: Pick<NearClient, "sign" | "broadcast" | "status">;
  readonly credential: (signer: AccountId) => Promise<Credential | null>;
  readonly crash: CrashPoint | null;
  readonly onCrash: (point: CrashPoint, tx: StoredTx) => never;
};

export type Outgoing = {
  readonly key: string;
  readonly signer: AccountId;
  readonly receiver: AccountId;
  readonly yocto: string;
  readonly actions: readonly Action[];
  // True when landing twice changes nothing on chain. Only then may a used nonce count as proof the stored bytes are dead.
  readonly idempotent: boolean;
};

export type Sent =
  | { readonly kind: "sent"; readonly tx: SignedTx; readonly result: TxResult }
  | { readonly kind: "key-reused" }
  | { readonly kind: "no-credential" };

// Each key owns the signed bytes stored under it. A retry only rebroadcasts or looks up those bytes, and signs a
// replacement only once the chain refuses the old transaction as expired and an archival node has no record of
// it, so one key can never put two transactions on chain.
export async function sendOnce(deps: OutboxDeps, out: Outgoing): Promise<Sent> {
  const stored = await latest(deps.file, out.key);
  if (stored === null) return signAndSend(deps, out);
  if (stored.signerId !== out.signer || stored.receiverId !== out.receiver || stored.yocto !== out.yocto) {
    return { kind: "key-reused" };
  }

  const seen = await deps.chain.status(stored);
  if (seen.kind !== "unknown") return { kind: "sent", tx: stored, result: seen };

  const again = await deps.chain.broadcast(stored, "FINAL");
  // A used nonce can also mean these bytes landed and the archival node has not caught up, so it retires them only
  // for an idempotent write.
  const dead = again.kind === "refused" && (again.never === "expired" || (again.never === "nonce-used" && out.idempotent));
  if (!dead) return { kind: "sent", tx: stored, result: again };
  // The stored bytes can no longer land. Ask once more in case they landed before the chain refused them.
  const last = await deps.chain.status(stored);
  if (last.kind === "unknown") return signAndSend(deps, out);
  return { kind: "sent", tx: stored, result: last };
}

async function signAndSend(deps: OutboxDeps, out: Outgoing): Promise<Sent> {
  const credential = await deps.credential(out.signer);
  if (credential === null) return { kind: "no-credential" };
  const tx = await deps.chain.sign(credential, out.receiver, out.actions);
  const signed: StoredTx = { ...tx, key: out.key, yocto: out.yocto };
  await appendJsonl(deps.file, signed);
  if (deps.crash === "after-sign") deps.onCrash("after-sign", signed);
  if (deps.crash === "after-broadcast") {
    await deps.chain.broadcast(signed, "NONE");
    deps.onCrash("after-broadcast", signed);
  }
  return { kind: "sent", tx: signed, result: await deps.chain.broadcast(signed, "FINAL") };
}

async function latest(file: string, key: string): Promise<StoredTx | null> {
  const rows = await readJsonl(file, parseStored);
  let found: StoredTx | null = null;
  for (const row of rows) {
    if (row.key === key) found = row;
  }
  return found;
}

function parseStored(raw: unknown): StoredTx | null {
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
