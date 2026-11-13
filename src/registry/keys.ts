import type { AccountId } from "../domain.ts";

// SocialDB lets an account write only under its own id, so the first segment of a key names who wrote the value.
export function commitmentKey(shop: AccountId): string {
  return `${shop}/inferpay/commitment`;
}
