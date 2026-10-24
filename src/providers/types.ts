import type { AccountId, AssetId, DecimalAmount, JobId, ModelId, ProviderId } from "../domain.ts";
import type { Brand } from "../domain.ts";
import type { PaymentReceipt } from "../payment/index.ts";
import type { Inference } from "../inference/index.ts";

export type NumberCheck =
  | {
      readonly verdict: "match";
      readonly label: string;
      readonly claimed: number;
      readonly unit: string;
      readonly source: string;
    }
  | {
      readonly verdict: "mismatch";
      readonly label: string;
      readonly claimed: number;
      readonly unit: string;
      readonly reference: number;
      readonly deltaPct: number;
      readonly source: string;
    }
  | {
      readonly verdict: "unverifiable";
      readonly label: string;
      readonly claimed: number;
      readonly unit: string;
    };

export type Answer = {
  readonly text: string;
  readonly checks: readonly NumberCheck[];
  readonly model: ModelId;
  readonly inference: "near-ai" | "stub";
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
  readonly describe: Omit<ProviderListing, "price" | "payTo">;
  fulfil(paid: PaidOrder, deps: { readonly inference: Inference }): Promise<Fulfilment>;
}
