import type { AccountId, CorrelationId, IdempotencyKey } from "../domain.ts";
import type { PaymentConfig } from "../config.ts";
import type { Price } from "../domain.ts";
import { createMockRail } from "./mock.ts";

export type PaymentReceipt = {
  readonly key: IdempotencyKey;
  readonly correlationId: CorrelationId;
  readonly amount: Price;
  readonly recipient: AccountId;
  readonly rail: "mock" | "near-intents";
};

export type PaymentStatus =
  | { readonly kind: "settled"; readonly receipt: PaymentReceipt }
  | { readonly kind: "pending"; readonly correlationId: CorrelationId | null }
  | { readonly kind: "uncertain"; readonly correlationId: CorrelationId | null }
  | { readonly kind: "rejected"; readonly reason: string };

export type Transfer = {
  readonly key: IdempotencyKey;
  readonly payer: AccountId;
  readonly amount: Price;
  readonly recipient: AccountId;
};

export interface PaymentRail {
  readonly kind: "mock" | "near-intents";
  mintKey(): IdempotencyKey;
  settle(transfer: Transfer): Promise<PaymentStatus>;
}

export async function createPaymentRail(config: PaymentConfig): Promise<PaymentRail> {
  if (config.kind === "mock") return createMockRail(config);
  const loaded = await import("./near-intents.ts");
  return loaded.createNearIntentsRail(config);
}
