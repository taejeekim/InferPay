import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseAssetId,
  parseModelId,
  parseParentAccount,
  parseProviderId,
  secret,
  type AssetId,
  type ModelId,
  type ProviderId,
  type Secret,
} from "./domain.ts";
import { resolveRoster, type Roster } from "./roster.ts";

export type PaymentConfig =
  | { readonly kind: "mock"; readonly root: string; readonly chaos: "none" | "uncertain-once" }
  | {
      readonly kind: "near-testnet";
      readonly root: string;
      readonly credentialsDir: string;
      readonly crash: "after-sign" | "after-broadcast" | null;
      // The same two crash points for the transaction that posts a rating.
      readonly ratingCrash: "after-sign" | "after-broadcast" | null;
    }
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
  // A test hook: one shop that cheats, so a run can show the buyer catching it. forge rewrites checks into its
  // favour with forged evidence; withhold drops every check that does not back its answer.
  readonly hook: { readonly shop: ProviderId; readonly mode: "forge" | "withhold" } | null;
};

export type ConfigError =
  | { readonly kind: "partial-payment-env"; readonly present: string[]; readonly missing: string[] }
  | { readonly kind: "invalid"; readonly variable: string; readonly detail: string };

const PAYMENT_ENV = [
  "NEAR_INTENTS_AGENT_API_KEY",
  "INFERPAY_AGENT_ID",
  "INFERPAY_GRANT_TOKEN",
];

const CRASH_POINTS = ["after-sign", "after-broadcast", "after-rating-sign", "after-rating-broadcast"];

const DEFAULT_NEAR_ASSET = "nep141:wrap.near";
const DEFAULT_ROOT_ACCOUNT = "inferpay.testnet";
const DEFAULT_CONSUMER_MODEL = "z-ai/glm-5.3-flash";
const DEFAULT_PROVIDER_MODEL = "z-ai/glm-5.3-flash";

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
  const choice = env.INFERPAY_PAYMENT;
  if (filled(choice) && choice !== "near-testnet" && choice !== "mock") {
    return invalid("INFERPAY_PAYMENT", "expected near-testnet or mock");
  }
  const testnet = choice === "near-testnet";
  if (testnet && livePayment) {
    return invalid("INFERPAY_PAYMENT", "near-testnet pays on testnet, so unset the NEAR Intents variables or unset INFERPAY_PAYMENT");
  }
  if (livePayment && !filled(env.INFERPAY_ROOT_ACCOUNT)) {
    return invalid("INFERPAY_ROOT_ACCOUNT", "live payment needs a mainnet root account you own, such as inferpay.near");
  }
  const root = parseParentAccount(filled(env.INFERPAY_ROOT_ACCOUNT) ? String(env.INFERPAY_ROOT_ACCOUNT) : DEFAULT_ROOT_ACCOUNT);
  if (!root) return invalid("INFERPAY_ROOT_ACCOUNT", "must be a lowercase NEAR account of 2 to 64 characters that contains a dot, such as inferpay.near");
  if (livePayment && root.endsWith(".testnet")) {
    return invalid("INFERPAY_ROOT_ACCOUNT", "NEAR Intents is mainnet only, so the root cannot end in .testnet");
  }
  if (testnet && !root.endsWith(".testnet")) {
    return invalid("INFERPAY_ROOT_ACCOUNT", "near-testnet pays on testnet, so the root must end in .testnet. Run: npx inferpay testnet setup");
  }
  const crashRaw = env.INFERPAY_TEST_CRASH;
  if (filled(crashRaw) && !CRASH_POINTS.includes(crashRaw)) {
    return invalid("INFERPAY_TEST_CRASH", `expected one of ${CRASH_POINTS.join(", ")}`);
  }
  const crash = crashRaw === "after-sign" || crashRaw === "after-broadcast" ? crashRaw : null;
  const ratingCrash = crashRaw === "after-rating-sign" ? "after-sign" : crashRaw === "after-rating-broadcast" ? "after-broadcast" : null;

  const chaosRaw = env.INFERPAY_MOCK_CHAOS;
  let chaos: "none" | "uncertain-once" = "none";
  if (filled(chaosRaw) && chaosRaw !== "none") {
    if (chaosRaw !== "uncertain-once") return invalid("INFERPAY_MOCK_CHAOS", "expected uncertain-once or none");
    chaos = "uncertain-once";
  }

  let payment: PaymentConfig = { kind: "mock", root: dataDir, chaos };
  if (livePayment) {
    payment = {
      kind: "near-intents",
      apiKey: secret(String(env.NEAR_INTENTS_AGENT_API_KEY)),
      agentId: String(env.INFERPAY_AGENT_ID),
      grantToken: secret(String(env.INFERPAY_GRANT_TOKEN)),
    };
  } else if (testnet) {
    payment = { kind: "near-testnet", root: dataDir, credentialsDir: credentialsDir(env), crash, ratingCrash };
  }

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

  const resolved = resolveRoster(root);
  if (!resolved.ok) return invalid("INFERPAY_ROOT_ACCOUNT", resolved.detail);

  if (filled(env.INFERPAY_TEST_LIAR) && filled(env.INFERPAY_TEST_WITHHOLD)) {
    return invalid("INFERPAY_TEST_WITHHOLD", "set INFERPAY_TEST_LIAR or INFERPAY_TEST_WITHHOLD, not both");
  }
  let hook: Config["hook"] = null;
  for (const [variable, mode] of [["INFERPAY_TEST_LIAR", "forge"], ["INFERPAY_TEST_WITHHOLD", "withhold"]] as const) {
    const raw = env[variable];
    if (!filled(raw)) continue;
    const shop = parseProviderId(raw);
    if (shop === null || resolved.roster.shop(shop) === null) {
      const shops = resolved.roster.forest().filter((row) => row.role === "specialist").map((row) => row.bot);
      return invalid(variable, `expected a shop id: ${shops.join(", ")}`);
    }
    hook = { shop, mode };
  }

  return {
    ok: true,
    value: {
      dataDir,
      roster: resolved.roster,
      near: { asset, symbol: "NEAR" },
      payment,
      inference,
      hook,
    },
  };
}

export function credentialsDir(env: NodeJS.ProcessEnv): string {
  if (filled(env.INFERPAY_NEAR_CREDENTIALS_DIR)) return env.INFERPAY_NEAR_CREDENTIALS_DIR;
  return join(homedir(), ".near-credentials", "testnet");
}

function filled(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function invalid(variable: string, detail: string): { ok: false; error: ConfigError } {
  return { ok: false, error: { kind: "invalid", variable, detail } };
}
