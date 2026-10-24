import type { AccountId, Price, ProviderId } from "../domain.ts";
import { disclosure } from "./disclosure/index.ts";
import type { Provider, ProviderListing } from "./types.ts";

export const PROVIDERS = [disclosure] satisfies readonly Provider[];

export type BoundProvider = { readonly provider: Provider; readonly listing: ProviderListing };

export function bindProviders(
  providers: readonly Provider[],
  pricing: ReadonlyMap<ProviderId, { price: Price; payTo: AccountId }>,
): BoundProvider[] | { readonly missing: ProviderId[] } {
  const missing: ProviderId[] = [];
  const bound: BoundProvider[] = [];
  for (const provider of providers) {
    const price = pricing.get(provider.describe.id);
    if (!price) {
      missing.push(provider.describe.id);
      continue;
    }
    bound.push({
      provider,
      listing: {
        ...provider.describe,
        price: price.price,
        payTo: price.payTo,
      },
    });
  }
  if (missing.length > 0) return { missing };
  return bound;
}
