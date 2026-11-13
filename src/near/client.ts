import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  SignedTransaction,
  actions,
  base64Decode,
  base64Encode,
  baseDecode,
  baseEncode,
  createTransaction,
  type Action,
  type KeyPairString,
} from "near-api-js";
import {
  AccessKeyDoesNotExistError,
  AccountDoesNotExistError,
  ActionExecutionError,
  InvalidNonceError,
  TransactionExecutionError,
  TransactionExpiredError,
  TransactionTimeoutError,
  UnknownTransactionError,
} from "near-api-js/rpc-errors";
import type { AccountId } from "../domain.ts";

export { actions, type Action };

export const TESTNET = {
  // rpc.testnet.near.org is deprecated and answered our calls with a -429 error in November 2026.
  rpcUrl: "https://test.rpc.fastnear.com",
  // Only an archival node still knows a transaction after garbage collection, so "unknown" is trusted only from here.
  archivalRpcUrl: "https://archival-rpc.testnet.fastnear.com",
  faucetUrl: "https://helper.testnet.near.org/account",
} as const;

export type Credential = {
  readonly accountId: AccountId;
  readonly publicKey: string;
  readonly keyPair: KeyPair;
};

export function newCredential(accountId: AccountId): Credential {
  const keyPair = KeyPair.fromRandom("ed25519");
  return { accountId, publicKey: keyPair.getPublicKey().toString(), keyPair };
}

// near-cli format, the same files near-cli reads from ~/.near-credentials.
export async function loadCredential(dir: string, accountId: AccountId): Promise<Credential | null> {
  let text: string;
  try {
    text = await readFile(credentialPath(dir, accountId), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || !("private_key" in raw) || typeof raw.private_key !== "string") {
    throw new Error(`${credentialPath(dir, accountId)} has no private_key`);
  }
  if (!("account_id" in raw) || raw.account_id !== accountId) {
    throw new Error(`${credentialPath(dir, accountId)} is for a different account`);
  }
  if (!raw.private_key.startsWith("ed25519:")) throw new Error(`${credentialPath(dir, accountId)} is not an ed25519 key`);
  const keyPair = KeyPair.fromString(raw.private_key as KeyPairString);
  return { accountId, publicKey: keyPair.getPublicKey().toString(), keyPair };
}

// The wx flag refuses to overwrite: an existing file may hold the only key to a funded account.
export async function saveCredential(dir: string, credential: Credential): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const body = {
    account_id: credential.accountId,
    public_key: credential.publicKey,
    private_key: credential.keyPair.toString(),
  };
  await writeFile(credentialPath(dir, credential.accountId), `${JSON.stringify(body)}\n`, { mode: 0o600, flag: "wx" });
}

function credentialPath(dir: string, accountId: AccountId): string {
  return join(dir, `${accountId}.json`);
}

// What the caller persists before broadcasting. The same bytes can be included on chain at most once.
export type SignedTx = {
  readonly hash: string;
  readonly signerId: AccountId;
  readonly receiverId: AccountId;
  readonly nonce: string;
  readonly base64: string;
};

export type TxResult =
  | { readonly kind: "success" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string; readonly never: "expired" | "nonce-used" | null }
  | { readonly kind: "unknown" }
  | { readonly kind: "pending" }
  | { readonly kind: "unreachable"; readonly detail: string };

export interface NearClient {
  balance(accountId: AccountId): Promise<bigint | null>;
  hasKey(accountId: AccountId, publicKey: string): Promise<boolean>;
  // Calls a contract's read-only method at the final block. No key and no fee.
  view(contractId: AccountId, method: string, args: { readonly [key: string]: unknown }): Promise<unknown>;
  sign(credential: Credential, receiverId: AccountId, txActions: readonly Action[]): Promise<SignedTx>;
  broadcast(tx: SignedTx, wait: "FINAL" | "NONE"): Promise<TxResult>;
  status(tx: { readonly hash: string; readonly signerId: AccountId }): Promise<TxResult>;
  send(credential: Credential, receiverId: AccountId, txActions: readonly Action[]): Promise<{ tx: SignedTx; result: TxResult }>;
  createWithFaucet(accountId: AccountId, publicKey: string): Promise<void>;
}

export function createNearClient(network: typeof TESTNET = TESTNET): NearClient {
  const rpc = new JsonRpcProvider({ url: network.rpcUrl }, { retries: 3 });
  const archival = new JsonRpcProvider({ url: network.archivalRpcUrl }, { retries: 3 });

  const client: NearClient = {
    async balance(accountId) {
      try {
        const view = await rpc.viewAccount({ accountId, blockQuery: { finality: "final" } });
        return view.amount;
      } catch (error) {
        if (error instanceof AccountDoesNotExistError) return null;
        throw error;
      }
    },

    async hasKey(accountId, publicKey) {
      try {
        await rpc.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "final" } });
        return true;
      } catch (error) {
        if (error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError) return false;
        throw error;
      }
    },

    async view(contractId, method, args) {
      return await rpc.callFunction({ contractId, method, args: { ...args }, blockQuery: { finality: "final" } }) ?? null;
    },

    async sign(credential, receiverId, txActions) {
      const key = await rpc.viewAccessKey({
        accountId: credential.accountId,
        publicKey: credential.publicKey,
        finalityQuery: { finality: "final" },
      });
      const nonce = key.nonce + 1n;
      const transaction = createTransaction(
        credential.accountId,
        credential.keyPair.getPublicKey(),
        receiverId,
        nonce,
        [...txActions],
        baseDecode(key.block_hash),
      );
      const signed = await new KeyPairSigner(credential.keyPair).signTransaction(transaction);
      return {
        hash: baseEncode(signed.txHash),
        signerId: credential.accountId,
        receiverId,
        nonce: nonce.toString(),
        base64: base64Encode(signed.signedTransaction.encode()),
      };
    },

    async broadcast(tx, wait) {
      try {
        const response = await rpc.sendTransactionUntil(SignedTransaction.decode(base64Decode(tx.base64)), wait);
        if (wait === "NONE") return { kind: "pending" };
        return fromResponse(response);
      } catch (error) {
        return fromThrown(error);
      }
    },

    async status(tx) {
      try {
        return fromResponse(await archival.viewTransactionStatus({ txHash: tx.hash, accountId: tx.signerId, waitUntil: "NONE" }));
      } catch (error) {
        return fromThrown(error);
      }
    },

    async send(credential, receiverId, txActions) {
      const tx = await client.sign(credential, receiverId, txActions);
      return { tx, result: await client.broadcast(tx, "FINAL") };
    },

    async createWithFaucet(accountId, publicKey) {
      const response = await fetch(network.faucetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
      });
      if (!response.ok) throw new Error(`faucet refused ${accountId}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    },
  };
  return client;
}

type RpcTransactionResponse = Awaited<ReturnType<JsonRpcProvider["viewTransactionStatus"]>>;

function fromResponse(response: RpcTransactionResponse): TxResult {
  const status = response.status;
  if (response.final_execution_status !== "FINAL" || typeof status !== "object") return { kind: "pending" };
  if ("Failure" in status) return { kind: "failed", reason: JSON.stringify(status.Failure) };
  return { kind: "success" };
}

function fromThrown(error: unknown): TxResult {
  if (error instanceof UnknownTransactionError) return { kind: "unknown" };
  if (error instanceof TransactionTimeoutError) return { kind: "pending" };
  if (error instanceof TransactionExpiredError) return { kind: "refused", reason: "transaction expired", never: "expired" };
  if (error instanceof InvalidNonceError) return { kind: "refused", reason: error.message, never: "nonce-used" };
  if (error instanceof ActionExecutionError) return { kind: "failed", reason: error.message };
  if (error instanceof TransactionExecutionError) return { kind: "refused", reason: `${error.name}: ${error.message}`, never: null };
  return { kind: "unreachable", detail: error instanceof Error ? error.message : String(error) };
}
