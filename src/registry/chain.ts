import { z } from "zod";
import { isAccountId, isJobId, isStars, type AccountId } from "../domain.ts";
import { isHash } from "../commitment/merkle.ts";
import { parseCommitment, type Commitment, type PinnedCommitment } from "../commitment/index.ts";
import { actions, type Credential, type NearClient, type TxResult } from "../near/client.ts";
import { sendOnce, type OutboxDeps } from "../near/outbox.ts";
import { SOCIAL_DB, SOCIAL_DEPOSIT, socialGet, socialSet, type SocialValue } from "../near/social.ts";
import { formatNear, nearOf } from "../payment/units.ts";
import type { OnChainRating, RatingCost, RatingPost, Registry } from "./index.ts";
import { commitmentKey, ratingKey, ratingsPattern } from "./keys.ts";

export function createChainRegistry(deps: {
  readonly chain: Pick<NearClient, "view">;
  readonly raters: readonly AccountId[];
  readonly outbox: OutboxDeps;
}): Registry {
  return {
    async commitments(shops) {
      return readCommitments(await socialGet(deps.chain, shops.map(commitmentKey)), shops);
    },
    async ratings() {
      return readRatings(await socialGet(deps.chain, deps.raters.map(ratingsPattern)), deps.raters);
    },
    async postRating(rating) {
      const before = await storageOf(deps.chain, rating.rater);
      // One key for each job, so a retry reuses the transaction the first attempt signed.
      const sent = await sendOnce(deps.outbox, {
        key: `rating:${rating.jobId}`,
        signer: rating.rater,
        receiver: SOCIAL_DB,
        yocto: SOCIAL_DEPOSIT.toString(),
        actions: [socialSet(rating.rater, ratingValue(rating))],
        // Writing the same value under the same key twice leaves SocialDB as it was.
        idempotent: true,
      });
      if (sent.kind === "no-credential") return { kind: "failed", reason: `no saved key for ${rating.rater}` };
      if (sent.kind === "key-reused") return { kind: "failed", reason: `the rating of ${rating.jobId} was already signed by another account` };
      const cost = sent.fresh && sent.result.kind === "success"
        ? { gas: sent.result.burnt, storage: (await storageOf(deps.chain, rating.rater)) - before }
        : null;
      return toPost(sent.result, sent.tx.hash, ratingKey(rating.rater, rating.jobId), cost);
    },
  };
}

// SocialDB refunds whatever part of the attached deposit the write did not use, so the storage balance it keeps
// for an account grows by exactly the bytes each write adds.
async function storageOf(chain: Pick<NearClient, "view">, account: AccountId): Promise<bigint> {
  const balance = await chain.view(SOCIAL_DB, "storage_balance_of", { account_id: account });
  const parsed = z.object({ total: z.string().regex(/^\d+$/) }).nullable().safeParse(balance);
  return parsed.success && parsed.data !== null ? BigInt(parsed.data.total) : 0n;
}

function toPost(result: TxResult, tx: string, key: string, cost: RatingCost | null): RatingPost {
  switch (result.kind) {
    case "success":
      return { kind: "posted", tx, contract: SOCIAL_DB, key, cost };
    case "failed":
      return { kind: "failed", reason: `transaction ${tx} failed on chain: ${result.reason}` };
    case "refused":
      if (result.never === null) return { kind: "failed", reason: `testnet refused the rating: ${result.reason}` };
      return { kind: "pending", tx, detail: result.reason };
    case "pending":
    case "unknown":
      return { kind: "pending", tx, detail: "the transaction is not final yet" };
    case "unreachable":
      return { kind: "pending", tx, detail: result.detail };
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

export function ratingValue(rating: OnChainRating): SocialValue {
  const { shop, stars, payment, root, verified, unproven, forged, withheld } = rating;
  return { inferpay: { ratings: { [rating.jobId]: JSON.stringify({ shop, stars, payment, root, verified, unproven, forged, withheld }) } } };
}

const count = z.number().int().nonnegative();

const ratingSchema = z.object({
  shop: z.string(),
  stars: z.number(),
  payment: z.string(),
  root: z.string().nullable(),
  verified: count,
  unproven: count,
  forged: count,
  withheld: count,
});

// Anyone can write anything under an account they hold, so a value that is not a rating is skipped, not trusted.
export function readRatings(raw: unknown, raters: readonly AccountId[]): readonly OnChainRating[] {
  const ratings: OnChainRating[] = [];
  for (const rater of raters) {
    const jobs = nodeAt(raw, [rater, "inferpay", "ratings"]);
    if (jobs === null) continue;
    for (const jobId of Object.keys(jobs)) {
      const leaf = leafAt(jobs, [jobId]);
      const parsed = leaf === null ? null : ratingSchema.safeParse(parseJson(leaf.value));
      if (!isJobId(jobId) || !parsed?.success) continue;
      const { shop, stars, payment, root, verified, unproven, forged, withheld } = parsed.data;
      if (!isAccountId(shop) || !isStars(stars) || (root !== null && !isHash(root))) continue;
      ratings.push({ jobId, rater, shop, stars, payment, root, verified, unproven, forged, withheld });
    }
  }
  return ratings;
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

type Node = { readonly [key: string]: unknown };

function nodeAt(raw: unknown, path: readonly string[]): Node | null {
  let node = raw;
  for (const key of path) {
    if (!isNode(node)) return null;
    node = node[key];
  }
  return isNode(node) ? node : null;
}

// With block heights on, SocialDB returns a value as { ":block": height, "": value } and nests it under its key path.
function leafAt(raw: unknown, path: readonly string[]): { readonly value: string; readonly block: number } | null {
  const node = nodeAt(raw, path);
  if (node === null) return null;
  const value = node[""];
  const block = node[":block"];
  if (typeof value !== "string" || typeof block !== "number") return null;
  return { value, block };
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// What a shop must hold to publish: the 0.02 NEAR deposit, about 0.02 NEAR of prepaid gas, and the storage its own
// account keeps paying for. Testnet refused a shop holding 0.064 NEAR when the call prepaid 50 TGas.
export const COMMIT_RESERVE = nearOf("0.05");

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
