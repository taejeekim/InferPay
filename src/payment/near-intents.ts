import { isCorrelationId, isIdempotencyKey, type CorrelationId } from "../domain.ts";
import type { PaymentConfig } from "../config.ts";
import type { PaymentRail, PaymentStatus, Transfer } from "./index.ts";
import { decimalToAtomic } from "./units.ts";

export type WireStatus = {
  readonly status: string;
  readonly correlation_id: string;
  readonly failure_code: string | null;
};

export function mapWireStatus(body: WireStatus, transfer: Transfer): PaymentStatus {
  const correlationId = correlationOf(body.correlation_id);
  switch (body.status) {
    case "SUCCESS":
      if (!correlationId) return { kind: "uncertain", correlationId: null };
      return {
        kind: "settled",
        receipt: {
          key: transfer.key,
          correlationId,
          amount: transfer.amount,
          recipient: transfer.recipient,
          rail: "near-intents",
          feeYocto: null,
        },
      };
    case "UNCERTAIN":
    case "NEEDS_REVIEW":
      return { kind: "uncertain", correlationId };
    case "FAILED":
    case "REFUNDED":
      return { kind: "rejected", reason: body.failure_code ?? body.status };
    case "PENDING_SIGNATURE":
    case "QUEUED":
    case "PENDING_APPROVAL":
    case "PENDING_DEPOSIT":
    case "PROCESSING":
      return { kind: "pending", correlationId };
    default:
      return { kind: "uncertain", correlationId };
  }
}

export function mapThrown(error: {
  readonly name: string;
  readonly status?: number;
  readonly code?: string;
  readonly retryable?: boolean;
}): PaymentStatus {
  if (error.name === "AgentApiRequestError" || error.name === "AgentApiResponseTooLargeError") {
    return { kind: "uncertain", correlationId: null };
  }
  if (error.name !== "AgentApiError") return { kind: "uncertain", correlationId: null };
  const status = error.status ?? 0;
  if (error.retryable && status < 500) return { kind: "pending", correlationId: null };
  if (status >= 500) return { kind: "uncertain", correlationId: null };
  return { kind: "rejected", reason: error.code ?? "rejected" };
}

export async function createNearIntentsRail(
  config: Extract<PaymentConfig, { kind: "near-intents" }>,
): Promise<PaymentRail> {
  const sdk = await import("@near-intents-agent-api/sdk");
  const api = sdk.createAgentApi({ apiKey: config.apiKey.reveal() });
  // The grant token is the agent's credential. forGrant sends it as X-Grant-Token, so transfer does not ask the owner to sign again.
  const agent = api.forGrant(config.grantToken.reveal());
  return {
    kind: "near-intents",
    mintKey() {
      // A new key is a new transfer. The marketplace stores this key before settle and sends it back as idempotencyKey.
      const key = sdk.createIdempotencyKey();
      if (!isIdempotencyKey(key)) throw new Error("idempotency key failed its check");
      return key;
    },
    async settle(transfer) {
      const amount = decimalToAtomic(transfer.amount.symbol, transfer.amount.amount);
      if (amount === null) return { kind: "rejected", reason: "amount is not a whole number of atomic units" };
      try {
        // transfer already returns a status, so this adapter does not poll getStatus.
        const result = await agent.transfer(
          config.agentId,
          { asset: transfer.amount.asset, amount, recipient: transfer.recipient },
          { idempotencyKey: transfer.key },
        );
        if (!isWireStatus(result)) return { kind: "uncertain", correlationId: null };
        return mapWireStatus(result, transfer);
      } catch (error) {
        if (error instanceof sdk.AgentApiError) {
          return mapThrown({
            name: "AgentApiError",
            status: error.status,
            code: error.code,
            retryable: error.retryable,
          });
        }
        if (error instanceof sdk.AgentApiRequestError || error instanceof sdk.AgentApiResponseTooLargeError) {
          return mapThrown({ name: error.name });
        }
        return { kind: "uncertain", correlationId: null };
      }
    },
  };
}

function correlationOf(raw: string): CorrelationId | null {
  if (!isCorrelationId(raw)) return null;
  return raw;
}

function isWireStatus(value: object): value is WireStatus {
  if (!("status" in value) || typeof value.status !== "string") return false;
  if (!("correlation_id" in value) || typeof value.correlation_id !== "string") return false;
  if (!("failure_code" in value)) return false;
  return value.failure_code === null || typeof value.failure_code === "string";
}
