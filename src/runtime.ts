import { join } from "node:path";
import { isIsoTime, type AccountId, type ProviderId } from "./domain.ts";
import { createConsumerAgent, type ConsumerAgent } from "./consumer/index.ts";
import { createInference, type Inference, type RoleAttestation } from "./inference/index.ts";
import { createFileLedger, createMarketplace, type Marketplace } from "./market/index.ts";
import { createPaymentRail, type PaymentRail } from "./payment/index.ts";
import { bindProviders, PROVIDERS } from "./providers/index.ts";
import { rigged, type HookMode } from "./providers/liar.ts";
import type { Registry } from "./registry/index.ts";
import type { Config, PaymentConfig } from "./config.ts";

export type Runtime = {
  readonly market: Marketplace;
  readonly consumer: ConsumerAgent;
  readonly rails: { readonly payment: PaymentRail["kind"]; readonly inference: Inference["kind"] };
  attested(): readonly RoleAttestation[];
};

// Loaded only on the testnet rail, so the mock rail never loads near-api-js.
async function chainRegistry(payment: Extract<PaymentConfig, { kind: "near-testnet" }>, raters: readonly AccountId[]): Promise<Registry> {
  const [near, { createChainRegistry }] = await Promise.all([import("./near/client.ts"), import("./registry/chain.ts")]);
  const chain = near.createNearClient();
  return createChainRegistry({
    chain,
    raters,
    outbox: {
      file: join(payment.root, "near-testnet-ratings.jsonl"),
      chain,
      credential: (account) => near.loadCredential(payment.credentialsDir, account),
      crash: payment.ratingCrash,
      onCrash(point, tx) {
        process.stderr.write(`INFERPAY_TEST_CRASH=${point.replace("after-", "after-rating-")}: exiting with rating transaction ${tx.hash} stored\n`);
        process.exit(137);
      },
    },
  });
}

export type HookReport = { readonly shop: ProviderId; readonly mode: HookMode; readonly changed: number };

// A test passes its own registry. Otherwise the rail decides: only near-testnet keeps a record on chain. onHook
// hears what a rigged shop did to each answer it sent.
export async function createRuntime(config: Config, onChain?: Registry, onHook?: (report: HookReport) => void): Promise<Runtime> {
  const { hook } = config;
  const shops = PROVIDERS.map((provider) => (
    hook !== null && provider.describe.id === hook.shop
      ? rigged(provider, hook.mode, (changed) => onHook?.({ shop: hook.shop, mode: hook.mode, changed }))
      : provider
  ));
  const bound = bindProviders(shops, config.roster, config.near);
  if (!bound.ok) {
    throw new Error(`providers do not match the roster. missing: ${bound.missing.join(", ")}. extra: ${bound.extra.join(", ")}`);
  }
  const rail = await createPaymentRail(config.payment);
  const raters = config.roster.forest().filter((row) => row.role !== "specialist").map((row) => row.account);
  const registry = onChain ?? (config.payment.kind === "near-testnet" ? await chainRegistry(config.payment, raters) : null);
  const inference = createInference(config.inference);
  const market = createMarketplace({
    ledger: createFileLedger(config.dataDir),
    rail,
    inference,
    providers: bound.providers,
    registry,
    clock() {
      const now = new Date().toISOString();
      if (!isIsoTime(now)) throw new Error("clock produced a bad timestamp");
      return now;
    },
  });
  return {
    market,
    consumer: createConsumerAgent({ market, inference }),
    rails: { payment: rail.kind, inference: inference.kind },
    attested: () => inference.attested(),
  };
}
