import { isIsoTime } from "./domain.ts";
import { createConsumerAgent, type ConsumerAgent } from "./consumer/index.ts";
import { createInference, type Inference, type RoleAttestation } from "./inference/index.ts";
import { createFileLedger, createMarketplace, type Marketplace } from "./market/index.ts";
import { createPaymentRail, type PaymentRail } from "./payment/index.ts";
import { bindProviders, PROVIDERS } from "./providers/index.ts";
import { lying } from "./providers/liar.ts";
import type { Registry } from "./registry/index.ts";
import type { Config } from "./config.ts";

export type Runtime = {
  readonly market: Marketplace;
  readonly consumer: ConsumerAgent;
  readonly rails: { readonly payment: PaymentRail["kind"]; readonly inference: Inference["kind"] };
  attested(): readonly RoleAttestation[];
};

// Loaded only on the testnet rail, so the mock rail never loads near-api-js.
async function chainRegistry(): Promise<Registry> {
  const [{ createNearClient }, { createChainRegistry }] = await Promise.all([import("./near/client.ts"), import("./registry/chain.ts")]);
  return createChainRegistry({ chain: createNearClient() });
}

// A test passes its own registry. Otherwise the rail decides: only near-testnet keeps a record on chain.
export async function createRuntime(config: Config, onChain?: Registry): Promise<Runtime> {
  const shops = PROVIDERS.map((provider) => (provider.describe.id === config.liar ? lying(provider) : provider));
  const bound = bindProviders(shops, config.roster, config.near);
  if (!bound.ok) {
    throw new Error(`providers do not match the roster. missing: ${bound.missing.join(", ")}. extra: ${bound.extra.join(", ")}`);
  }
  const rail = await createPaymentRail(config.payment);
  const registry = onChain ?? (config.payment.kind === "near-testnet" ? await chainRegistry() : null);
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
