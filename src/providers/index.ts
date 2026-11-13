import { compareSameAsset, type AssetId, type Price, type ProviderId } from "../domain.ts";
import type { Roster } from "../roster.ts";
import { disclosure } from "./disclosure/index.ts";
import { insurance } from "./insurance/index.ts";
import { legal } from "./legal/index.ts";
import type { Provider, ProviderListing } from "./types.ts";

export const PROVIDERS = [disclosure, legal, insurance] satisfies readonly Provider[];

export type BoundProvider = { readonly provider: Provider; readonly listing: ProviderListing; readonly floor: Price };

// A shop sells at any offer from its floor up, and never charges more than its list price.
export function priceFor(bound: BoundProvider, offer: Price): Price | null {
  const againstFloor = compareSameAsset(offer, bound.floor);
  if (againstFloor === "different-asset" || againstFloor === -1) return null;
  if (compareSameAsset(offer, bound.listing.price) === 1) return bound.listing.price;
  return { ...bound.listing.price, amount: offer.amount };
}

export type Bindings =
  | { readonly ok: true; readonly providers: readonly BoundProvider[] }
  | { readonly ok: false; readonly missing: readonly ProviderId[]; readonly extra: readonly ProviderId[] };

export function bindProviders(
  providers: readonly Provider[],
  roster: Roster,
  near: { readonly asset: AssetId; readonly symbol: string },
): Bindings {
  const covered = roster.cover(providers.map((provider) => provider.describe.id));
  if (!covered.ok) return { ok: false, missing: covered.missing, extra: covered.extra };
  const bound: BoundProvider[] = [];
  for (const provider of providers) {
    const seat = covered.byId.get(provider.describe.id);
    if (!seat) throw new Error(`roster cover omitted ${provider.describe.id}`);
    bound.push({
      provider,
      listing: {
        ...provider.describe,
        price: { asset: near.asset, symbol: near.symbol, amount: provider.quoteNear },
        owner: seat.parent,
        payTo: seat.account,
        declared: provider.commitment(),
      },
      floor: { asset: near.asset, symbol: near.symbol, amount: provider.floorNear },
    });
  }
  return { ok: true, providers: bound };
}
