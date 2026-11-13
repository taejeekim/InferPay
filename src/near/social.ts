import { parseAccountId, type AccountId } from "../domain.ts";
import { nearOf } from "../payment/units.ts";
import { actions, type Action, type NearClient } from "./client.ts";

const contract = parseAccountId("v1.social08.testnet");
if (!contract) throw new Error("SocialDB account failed its check");

// NEAR Social's key-value contract. An account can write only under its own id, and anyone can read.
export const SOCIAL_DB = contract;

// SocialDB asks 0.02 NEAR before an account's first write, which also pays for 2,000 bytes. The refund option
// returns whatever the write did not use, so a write costs its bytes and its gas.
export const SOCIAL_DEPOSIT = nearOf("0.02");

// A first write burned under 6 TGas on testnet in November 2026. The signer must hold the whole prepaid amount up
// front, about 0.001 NEAR for each TGas at that month's price, so the allowance stays close to what a write uses.
const SOCIAL_GAS = 20_000_000_000_000n;

export type SocialValue = string | { readonly [key: string]: SocialValue };

export function socialSet(account: AccountId, value: SocialValue): Action {
  return actions.functionCall(
    "set",
    { data: { [account]: value }, options: { refund_unused_deposit: true } },
    SOCIAL_GAS,
    SOCIAL_DEPOSIT,
  );
}

// The block height tells a reader when each value was written, so a commitment can be dated against a purchase.
export function socialGet(client: Pick<NearClient, "view">, keys: readonly string[]): Promise<unknown> {
  return client.view(SOCIAL_DB, "get", { keys, options: { with_block_height: true } });
}
