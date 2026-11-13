import { resolve } from "node:path";
import {
  parseAssetId,
  parseModelId,
  parseParentAccount,
  secret,
  type AssetId,
  type ModelId,
  type ParentAccount,
  type Secret,
} from "./domain.ts";
import { resolveRoster, type Roster } from "./roster.ts";

export type PaymentConfig =
  | { readonly kind: "mock"; readonly root: string; readonly chaos: "none" | "uncertain-once" }
  | {
      readonly kind: "near-intents";
      readonly apiKey: Secret;
      readonly agentId: string;
      readonly grantToken: Secret;
    };

export type InferenceConfig =
  | { readonly kind: "stub" }
  | {
      readonly kind: "near-ai";
      readonly apiKey: Secret;
      readonly consumerModel: ModelId;
      readonly providerModel: ModelId;
    };

export type Config = {
  readonly dataDir: string;
  readonly roster: Roster;
  readonly near: { readonly asset: AssetId; readonly symbol: "NEAR" };
  readonly payment: PaymentConfig;
  readonly inference: InferenceConfig;
};

export type ConfigError =
  | { readonly kind: "partial-payment-env"; readonly present: string[]; readonly missing: string[] }
  | { readonly kind: "invalid"; readonly variable: string; readonly detail: string };

const PAYMENT_ENV = [
  "NEAR_INTENTS_AGENT_API_KEY",
  "INFERPAY_AGENT_ID",
  "INFERPAY_GRANT_TOKEN",
  "INFERPAY_PARENT_ACCOUNT",
];

const DEFAULT_NEAR_ASSET = "nep141:wrap.near";
const DEFAULT_CONSUMER_MODEL = "z-ai/glm-5.2";
const DEFAULT_PROVIDER_MODEL = "zai-org/GLM-5.1-FP8";

export function loadConfig(env: NodeJS.ProcessEnv): { ok: true; value: Config } | { ok: false; error: ConfigError } {
  const present = PAYMENT_ENV.filter((name) => filled(env[name]));
  const missing = PAYMENT_ENV.filter((name) => !filled(env[name]));
  if (present.length > 0 && missing.length > 0) {
    return { ok: false, error: { kind: "partial-payment-env", present: [...present], missing: [...missing] } };
  }

  const dataDir = resolve(filled(env.INFERPAY_DATA_DIR) ? String(env.INFERPAY_DATA_DIR) : ".inferpay");
  const asset = parseAssetId(filled(env.INFERPAY_NEAR_ASSET) ? String(env.INFERPAY_NEAR_ASSET) : DEFAULT_NEAR_ASSET);
  if (!asset) return invalid("INFERPAY_NEAR_ASSET", "asset id is empty");

  const livePayment = present.length === PAYMENT_ENV.length;
  let kyleParent: ParentAccount | undefined;
  if (livePayment) {
    const parent = parseParentAccount(String(env.INFERPAY_PARENT_ACCOUNT));
    if (!parent) return invalid("INFERPAY_PARENT_ACCOUNT", "named account must contain a dot, such as alice.near");
    kyleParent = parent;
  }

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

  let inference: InferenceConfig = { kind: "stub" };
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

  const resolved = kyleParent === undefined ? resolveRoster() : resolveRoster({ kyleParent });
  if (!resolved.ok) return invalid(livePayment ? "INFERPAY_PARENT_ACCOUNT" : "roster", resolved.detail);

  return {
    ok: true,
    value: {
      dataDir,
      roster: resolved.roster,
      near: { asset, symbol: "NEAR" },
      payment,
      inference,
    },
  };
}

function filled(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function invalid(variable: string, detail: string): { ok: false; error: ConfigError } {
  return { ok: false, error: { kind: "invalid", variable, detail } };
}
