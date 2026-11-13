import type { AccountId } from "../domain.ts";
import { parseCommitment, type Commitment, type PinnedCommitment } from "../commitment/index.ts";
import { actions, type Credential, type NearClient } from "../near/client.ts";
import { SOCIAL_DB, SOCIAL_DEPOSIT, socialGet, socialSet, type SocialValue } from "../near/social.ts";
import { formatNear, nearOf } from "../payment/units.ts";
import type { Registry } from "./index.ts";
import { commitmentKey } from "./keys.ts";

export function createChainRegistry(deps: { readonly chain: Pick<NearClient, "view"> }): Registry {
  return {
    async commitments(shops) {
      return readCommitments(await socialGet(deps.chain, shops.map(commitmentKey)), shops);
    },
  };
}

export function commitmentValue(commitment: Commitment): SocialValue {
  return { inferpay: { commitment: JSON.stringify(commitment) } };
}

export function readCommitments(raw: unknown, shops: readonly AccountId[]): ReadonlyMap<AccountId, PinnedCommitment> {
  return new Map(shops.map((account) => {
    const leaf = leafAt(raw, [account, "inferpay", "commitment"]);
    const commitment = leaf === null ? null : parseCommitment(parseJson(leaf.value));
    const pinned: PinnedCommitment = leaf === null || commitment === null
      ? { status: "missing", contract: SOCIAL_DB, account }
      : { status: "published", commitment, source: { kind: "chain", contract: SOCIAL_DB, account, block: leaf.block } };
    return [account, pinned];
  }));
}

// With block heights on, SocialDB returns a value as { ":block": height, "": value } and nests it under its key path.
export function leafAt(raw: unknown, path: readonly string[]): { readonly value: string; readonly block: number } | null {
  let node = raw;
  for (const key of path) {
    if (!isRecord(node)) return null;
    node = node[key];
  }
  if (!isRecord(node)) return null;
  const value = node[""];
  const block = node[":block"];
  if (typeof value !== "string" || typeof block !== "number") return null;
  return { value, block };
}

export function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The 0.02 NEAR deposit, the gas for the call, and the storage the shop's own account must keep paying for.
export const COMMIT_RESERVE = nearOf("0.03");

export type ShopCommitment = {
  readonly account: AccountId;
  readonly parent: AccountId;
  readonly declared: Commitment;
};

export type Published =
  | { readonly kind: "current"; readonly account: AccountId; readonly commitment: Commitment; readonly block: number }
  | {
      readonly kind: "published";
      readonly account: AccountId;
      readonly commitment: Commitment;
      readonly why: "missing" | "changed";
      readonly hash: string;
      readonly toppedUp: bigint;
    };

export type PublishDeps = {
  readonly chain: Pick<NearClient, "view" | "balance" | "send">;
  readonly credential: (account: AccountId) => Promise<Credential | null>;
};

// Reads what is on chain and writes only where it differs, so a second run sends nothing and a run that stopped
// half way picks up at the first shop still out of date.
export async function publishCommitments(
  deps: PublishDeps,
  shops: readonly ShopCommitment[],
  onStep: (step: Published) => void,
): Promise<void> {
  const onChain = readCommitments(await socialGet(deps.chain, shops.map((shop) => commitmentKey(shop.account))), shops.map((shop) => shop.account));
  for (const shop of shops) {
    const seen = onChain.get(shop.account);
    if (seen?.status === "published" && sameCommitment(seen.commitment, shop.declared) && seen.source.kind === "chain") {
      onStep({ kind: "current", account: shop.account, commitment: shop.declared, block: seen.source.block });
      continue;
    }
    const toppedUp = await topUp(deps, shop);
    const credential = await requireCredential(deps, shop.account);
    const sent = await deps.chain.send(credential, SOCIAL_DB, [socialSet(shop.account, commitmentValue(shop.declared))]);
    if (sent.result.kind !== "success") {
      throw new Error(`publishing the commitment of ${shop.account} did not finish (${describe(sent.result)}). Run setup again; it resumes here.`);
    }
    onStep({
      kind: "published",
      account: shop.account,
      commitment: shop.declared,
      why: seen?.status === "published" ? "changed" : "missing",
      hash: sent.tx.hash,
      toppedUp,
    });
  }
}

async function topUp(deps: PublishDeps, shop: ShopCommitment): Promise<bigint> {
  const balance = await deps.chain.balance(shop.account);
  if (balance === null) throw new Error(`${shop.account} does not exist on testnet`);
  if (balance >= COMMIT_RESERVE) return 0n;
  const lacking = COMMIT_RESERVE - balance;
  const parent = await requireCredential(deps, shop.parent);
  const sent = await deps.chain.send(parent, shop.account, [actions.transfer(lacking)]);
  if (sent.result.kind !== "success") {
    throw new Error(`${shop.parent} could not send ${formatNear(lacking)} NEAR to ${shop.account} for its SocialDB deposit of ${formatNear(SOCIAL_DEPOSIT)} NEAR (${describe(sent.result)}). Fund ${shop.parent} and run setup again.`);
  }
  return lacking;
}

async function requireCredential(deps: PublishDeps, account: AccountId): Promise<Credential> {
  const credential = await deps.credential(account);
  if (credential === null) throw new Error(`no saved key for ${account}`);
  return credential;
}

function sameCommitment(a: Commitment, b: Commitment): boolean {
  return a.scheme === b.scheme && a.root === b.root && a.leaves === b.leaves;
}

function describe(result: { readonly kind: string; readonly reason?: string; readonly detail?: string }): string {
  return [result.kind, result.reason ?? result.detail].filter((part) => part !== undefined).join(": ");
}
