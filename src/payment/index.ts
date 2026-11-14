import type { AccountId, CorrelationId, IdempotencyKey, JobId } from "../domain.ts";
import type { PaymentConfig } from "../config.ts";
import type { Price } from "../domain.ts";
import { createMockRail } from "./mock.ts";

export type PaymentReceipt = {
  readonly key: IdempotencyKey;
  readonly correlationId: CorrelationId;
  readonly amount: Price;
  readonly recipient: AccountId;
  readonly rail: PaymentRail["kind"];
  // The gas the payer paid on top of the amount, in yoctoNEAR, from the transaction outcome. Null on a rail that
  // reports none.
  readonly feeYocto: string | null;
};

export type PaymentStatus =
  | { readonly kind: "settled"; readonly receipt: PaymentReceipt }
  | { readonly kind: "pending"; readonly correlationId: CorrelationId | null }
  | { readonly kind: "uncertain"; readonly correlationId: CorrelationId | null }
  | { readonly kind: "rejected"; readonly reason: string };

export type Transfer = {
  // The job the transfer pays for, so a crash message can name what to resume.
  readonly jobId: JobId;
  readonly key: IdempotencyKey;
  readonly payer: AccountId;
  readonly amount: Price;
  readonly recipient: AccountId;
};

export interface PaymentRail {
  readonly kind: "mock" | "near-intents" | "near-testnet";
  mintKey(): IdempotencyKey;
  settle(transfer: Transfer): Promise<PaymentStatus>;
}

export async function createPaymentRail(config: PaymentConfig): Promise<PaymentRail> {
  if (config.kind === "mock") return createMockRail(config);
  if (config.kind === "near-testnet") {
    const loaded = await import("./near-testnet.ts");
    return loaded.createNearTestnetRail(config);
  }
  const loaded = await import("./near-intents.ts");
  return loaded.createNearIntentsRail(config);
}
