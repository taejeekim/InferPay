import type { AccountId, AssetId, DecimalAmount, JobId, ModelId, ParentAccount, ProviderId } from "../domain.ts";
import type { Brand } from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import type { CallAttestation } from "../inference/attest.ts";
import type { AssertedCheck, CatalogItem, Commitment, Need } from "../commitment/index.ts";

export type Answer = {
  readonly text: string;
  readonly checks: readonly AssertedCheck[];
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
  // The shop's own statement of its root. A buyer on a chain rail reads the root from chain instead.
  readonly declared: Commitment;
  // The keys the shop holds entries for, without their values. A buyer may name only these as needs.
  readonly catalog: readonly CatalogItem[];
};

// An open job at an agreed price. The shop delivers before it is paid, and the buyer pays for what it verifies.
export type JobOrder = Brand<
  {
    readonly jobId: JobId;
    readonly question: string;
    // The keys the buyer requires opened in the answer.
    readonly needs: readonly Need[];
    readonly quote: PriceFields;
  },
  "JobOrder"
>;

export type Fulfilment =
  | { readonly ok: true; readonly answer: Answer }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export interface Provider {
  readonly quoteNear: DecimalAmount;
  // The lowest price the shop accepts. It stays out of the listing, so a buyer learns it only by making an offer.
  readonly floorNear: DecimalAmount;
  readonly describe: Omit<ProviderListing, "price" | "owner" | "payTo" | "declared" | "catalog">;
  commitment(): Commitment;
  catalog(): readonly CatalogItem[];
  fulfil(order: JobOrder, deps: { readonly inference: Inference }): Promise<Fulfilment>;
}
