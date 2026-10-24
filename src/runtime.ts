import { isIsoTime } from "./domain.ts";
import { createConsumerAgent, type ConsumerAgent } from "./consumer/index.ts";
import { createInference, type Inference } from "./inference/index.ts";
import { createFileLedger, createMarketplace, type Marketplace } from "./market/index.ts";
import { createPaymentRail, type PaymentRail } from "./payment/index.ts";
import { bindProviders, PROVIDERS } from "./providers/index.ts";
import type { Config } from "./config.ts";

export type Runtime = {
  readonly market: Marketplace;
  readonly consumer: ConsumerAgent;
  readonly rails: { readonly payment: PaymentRail["kind"]; readonly inference: Inference["kind"] };
};

export async function createRuntime(config: Config): Promise<Runtime> {
  const bound = bindProviders(PROVIDERS, config.pricing);
  if (!Array.isArray(bound)) throw new Error(`missing price for ${bound.missing.join(", ")}`);
  const rail = await createPaymentRail(config.payment);
  const inference = createInference(config.inference);
  const market = createMarketplace({
    ledger: createFileLedger(config.dataDir),
    rail,
    inference,
    providers: bound,
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
  };
}
