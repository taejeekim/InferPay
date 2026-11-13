import type { AccountId } from "../domain.ts";
import type { PinnedCommitment } from "../commitment/index.ts";

// The public record a rail keeps on chain. A rail without one passes null, and the marketplace falls back to the
// shop's listing and this machine's ledger.
export interface Registry {
  commitments(shops: readonly AccountId[]): Promise<ReadonlyMap<AccountId, PinnedCommitment>>;
}
