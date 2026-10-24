import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  parseAccountId,
  parseAssetId,
  parseDecimalAmount,
  parseModelId,
  parseProviderId,
  secret,
  type AccountId,
  type ModelId,
  type Price,
  type ProviderId,
  type Secret,
} from "./domain.ts";

export type PaymentConfig =
  | { readonly kind: "mock"; readonly root: string; readonly chaos: "none" | "uncertain-once" }
  | {
      readonly kind: "near-intents";
      readonly apiKey: Secret;
      readonly agentId: string;
      readonly grantToken: Secret;
    };

export type InferenceConfig =
  | { readonly kind: "stub"; readonly fixtures: string }
  | {
      readonly kind: "near-ai";
      readonly apiKey: Secret;
      readonly consumerModel: ModelId;
      readonly providerModel: ModelId;
    };

export type Config = {
  readonly dataDir: string;
  readonly payment: PaymentConfig;
  readonly inference: InferenceConfig;
  readonly pricing: ReadonlyMap<ProviderId, { price: Price; payTo: AccountId }>;
};

export type ConfigError =
  | { readonly kind: "partial-payment-env"; readonly present: string[]; readonly missing: string[] }
  | { readonly kind: "invalid"; readonly variable: string; readonly detail: string };

const PAYMENT_ENV = [
  "NEAR_INTENTS_AGENT_API_KEY",
  "INFERPAY_AGENT_ID",
  "INFERPAY_GRANT_TOKEN",
  "INFERPAY_DISCLOSURE_PAY_TO",
];

const DEFAULT_USDC_ASSET = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
const DEFAULT_CONSUMER_MODEL = "z-ai/glm-5.2";
const DEFAULT_PROVIDER_MODEL = "zai-org/GLM-5.1-FP8";
const DISCLOSURE_AMOUNT = "0.25";

export function loadConfig(env: NodeJS.ProcessEnv): { ok: true; value: Config } | { ok: false; error: ConfigError } {
  const present = PAYMENT_ENV.filter((name) => filled(env[name]));
  const missing = PAYMENT_ENV.filter((name) => !filled(env[name]));
  if (present.length > 0 && missing.length > 0) {
    return { ok: false, error: { kind: "partial-payment-env", present: [...present], missing: [...missing] } };
  }

  const dataDir = resolve(filled(env.INFERPAY_DATA_DIR) ? String(env.INFERPAY_DATA_DIR) : ".inferpay");
  const asset = parseAssetId(filled(env.INFERPAY_USDC_ASSET) ? String(env.INFERPAY_USDC_ASSET) : DEFAULT_USDC_ASSET);
  if (!asset) return invalid("INFERPAY_USDC_ASSET", "asset id is empty");
  const amount = parseDecimalAmount(DISCLOSURE_AMOUNT);
  const providerId = parseProviderId("disclosure");
  if (!amount || !providerId) return invalid("INFERPAY_DISCLOSURE_PAY_TO", "built-in disclosure price failed its check");

  const livePayment = present.length === PAYMENT_ENV.length;
  const payToRaw = livePayment ? String(env.INFERPAY_DISCLOSURE_PAY_TO) : "disclosure.mock";
  const payTo = parseAccountId(payToRaw);
  if (!payTo) return invalid("INFERPAY_DISCLOSURE_PAY_TO", "account id has unexpected characters");

  const chaosRaw = env.INFERPAY_MOCK_CHAOS;
  let chaos: "none" | "uncertain-once" = "none";
  if (filled(chaosRaw) && chaosRaw !== "none") {
    if (chaosRaw !== "uncertain-once") return invalid("INFERPAY_MOCK_CHAOS", "expected uncertain-once or none");
    chaos = "uncertain-once";
  }

  const payment: PaymentConfig = livePayment
    ? {
        kind: "near-intents",
        apiKey: secret(String(env.NEAR_INTENTS_AGENT_API_KEY)),
        agentId: String(env.INFERPAY_AGENT_ID),
        grantToken: secret(String(env.INFERPAY_GRANT_TOKEN)),
      }
    : { kind: "mock", root: dataDir, chaos };

  const fixtures = fileURLToPath(new URL("./inference/fixtures/", import.meta.url));
  let inference: InferenceConfig = { kind: "stub", fixtures };
  if (filled(env.NEAR_AI_API_KEY)) {
    const consumerModel = parseModelId(filled(env.NEAR_AI_CONSUMER_MODEL) ? String(env.NEAR_AI_CONSUMER_MODEL) : DEFAULT_CONSUMER_MODEL);
    const providerModel = parseModelId(filled(env.NEAR_AI_PROVIDER_MODEL) ? String(env.NEAR_AI_PROVIDER_MODEL) : DEFAULT_PROVIDER_MODEL);
    if (!consumerModel) return invalid("NEAR_AI_CONSUMER_MODEL", "model id is empty");
    if (!providerModel) return invalid("NEAR_AI_PROVIDER_MODEL", "model id is empty");
    inference = {
      kind: "near-ai",
      apiKey: secret(String(env.NEAR_AI_API_KEY)),
      consumerModel,
      providerModel,
    };
  }

  const pricing = new Map<ProviderId, { price: Price; payTo: AccountId }>([
    [providerId, { price: { asset, symbol: "USDC", amount }, payTo }],
  ]);

  return { ok: true, value: { dataDir, payment, inference, pricing } };
}

function filled(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function invalid(variable: string, detail: string): { ok: false; error: ConfigError } {
  return { ok: false, error: { kind: "invalid", variable, detail } };
}
