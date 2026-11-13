import type { AccountId, AssetId, DecimalAmount, JobId, ModelId, ParentAccount, ProviderId } from "../domain.ts";
import type { Brand } from "../domain.ts";
import type { PaymentReceipt } from "../payment/index.ts";
import type { Inference } from "../inference/index.ts";
import type { CallAttestation } from "../inference/attest.ts";

export type NumberCheck =
  | {
      readonly kind: "number";
      readonly verdict: "match";
      readonly label: string;
      readonly claimed: number;
      readonly unit: string;
      readonly source: string;
    }
  | {
      readonly kind: "number";
      readonly verdict: "mismatch";
      readonly label: string;
      readonly claimed: number;
      readonly unit: string;
      readonly reference: number;
      readonly deltaPct: number;
      readonly source: string;
    }
  | {
      readonly kind: "number";
      readonly verdict: "unverifiable";
      readonly label: string;
      readonly claimed: number;
      readonly unit: string;
    };

export type FlagCheck = {
  readonly kind: "flag";
  readonly verdict: "raised" | "clear";
  readonly label: string;
  readonly detail: string;
};

export type FactCheck =
  | {
      readonly kind: "fact";
      readonly verdict: "match";
      readonly label: string;
      readonly claimed: string;
      readonly source: string;
    }
  | {
      readonly kind: "fact";
      readonly verdict: "mismatch";
      readonly label: string;
      readonly claimed: string;
      readonly reference: string;
      readonly source: string;
    }
  | {
      readonly kind: "fact";
      readonly verdict: "unverifiable";
      readonly label: string;
      readonly claimed: string;
    };

export type Check = NumberCheck | FlagCheck | FactCheck;

export type Answer = {
  readonly text: string;
  readonly checks: readonly Check[];
  readonly model: ModelId;
  readonly inference: "near-ai" | "stub";
  readonly attestation: readonly CallAttestation[];
};

export type PriceFields = {
  readonly asset: AssetId;
  readonly symbol: string;
  readonly amount: DecimalAmount;
};

export type ProviderListing = {
  readonly id: ProviderId;
  readonly name: string;
  readonly specialty: string;
  readonly routingHint: string;
  readonly price: PriceFields;
  readonly owner: ParentAccount;
  readonly payTo: AccountId;
};

export type PaidOrder = Brand<
  {
    readonly jobId: JobId;
    readonly question: string;
    readonly receipt: PaymentReceipt;
  },
  "PaidOrder"
>;

export type Fulfilment =
  | { readonly ok: true; readonly answer: Answer }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export interface Provider {
  readonly quoteNear: DecimalAmount;
  // The lowest price the shop accepts. It stays out of the listing, so a buyer learns it only by making an offer.
  readonly floorNear: DecimalAmount;
  readonly describe: Omit<ProviderListing, "price" | "owner" | "payTo">;
  fulfil(paid: PaidOrder, deps: { readonly inference: Inference }): Promise<Fulfilment>;
}
