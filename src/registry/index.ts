import type { AccountId, JobId, Stars } from "../domain.ts";
import type { Hash, PinnedCommitment } from "../commitment/index.ts";

// A buyer bot's rating as it stands on chain, under the bot's own account.
export type OnChainRating = {
  readonly jobId: JobId;
  readonly rater: AccountId;
  readonly shop: AccountId;
  readonly stars: Stars;
  // The transfer that paid for the job, so a reader can check the rater bought what it rated. Null when the buyer
  // verified the delivery and owed nothing, as after a forged check.
  readonly payment: string | null;
  // The root the checks were verified against, or null when the shop had published none.
  readonly root: Hash | null;
  readonly verified: number;
  readonly unproven: number;
  readonly forged: number;
  // Keys the buyer needed that the shop did not open.
  readonly withheld: number;
};

// What writing the rating cost the bot on top of any price: the gas it burnt, from the transaction outcome, and
// the storage SocialDB kept for the new bytes, from the bot's SocialDB storage balance before and after.
export type RatingCost = { readonly gas: bigint; readonly storage: bigint };

export type RatingPost =
  // cost is null when an earlier run sent the transaction, so this run saw neither balance before it.
  | { readonly kind: "posted"; readonly tx: string; readonly contract: AccountId; readonly key: string; readonly cost: RatingCost | null }
  | { readonly kind: "pending"; readonly tx: string | null; readonly detail: string }
  | { readonly kind: "failed"; readonly reason: string };

// The most writing one rating can cost its rater, in yoctoNEAR, stated before the purchase. storage is the deposit the
// write attaches, which is the most SocialDB can keep. first is true before the rater's first write ever, which
// registers its storage and so needs the larger deposit.
export type RatingFeeBound = { readonly gas: bigint; readonly storage: bigint; readonly first: boolean };

// The public record a rail keeps on chain. A rail without one passes null, and the marketplace falls back to the
// shop's listing and this machine's ledger.
export interface Registry {
  commitments(shops: readonly AccountId[]): Promise<ReadonlyMap<AccountId, PinnedCommitment>>;
  // Every rating the known buyer bots have written, whichever machine wrote it.
  ratings(): Promise<readonly OnChainRating[]>;
  ratingFeeBound(rater: AccountId): Promise<RatingFeeBound>;
  // Safe to call again for the same job with the same deposit: a retry looks up or rebroadcasts the transaction it
  // already signed.
  postRating(rating: OnChainRating, deposit: bigint): Promise<RatingPost>;
}
