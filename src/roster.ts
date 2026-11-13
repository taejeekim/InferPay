import {
  parseAccountId,
  parseParentAccount,
  parseProviderId,
  type AccountId,
  type Brand,
  type ParentAccount,
  type ProviderId,
} from "./domain.ts";

const BOT_NAME = /^[a-z][a-z0-9-]*$/;

const BUYER = defineBuyer({
  id: "kyle",
  bots: ["researcher", "writer", "trader", "analyst", "clerk", "scout", "editor", "buyer", "reviewer", "assistant"],
  defaultBot: "researcher",
});

const SHOPS = [
  { id: "stella", providerId: "legal" },
  { id: "ban", providerId: "insurance" },
  { id: "david", providerId: "disclosure" },
] as const;

export type KyleBot = (typeof BUYER.bots)[number];

export type PersonId = (typeof BUYER.id) | (typeof SHOPS)[number]["id"];

export type BuyerSeat = Brand<{
  readonly kind: "buyer";
  readonly personId: (typeof BUYER.id);
  readonly parent: ParentAccount;
  readonly bot: KyleBot;
  readonly account: AccountId;
}, "BuyerSeat">;

export type ShopSeat = Brand<{
  readonly kind: "specialist";
  readonly personId: (typeof SHOPS)[number]["id"];
  readonly parent: ParentAccount;
  readonly providerId: ProviderId;
  readonly account: AccountId;
}, "ShopSeat">;

export type ForestRow = {
  readonly personId: PersonId;
  readonly parent: ParentAccount;
  readonly bot: string;
  readonly account: AccountId;
  readonly role: "default-payer" | "payer" | "specialist";
};

export type Roster = {
  readonly root: ParentAccount;
  readonly defaultBuyer: BuyerSeat;
  buyer(name: string): BuyerSeat | null;
  shop(providerId: ProviderId): ShopSeat | null;
  cover(providerIds: readonly ProviderId[]): Cover;
  forest(): readonly ForestRow[];
};

export type Cover =
  | { readonly ok: true; readonly byId: ReadonlyMap<ProviderId, ShopSeat> }
  | { readonly ok: false; readonly missing: readonly ProviderId[]; readonly extra: readonly ProviderId[] };

export type ResolveRoster =
  | { readonly ok: true; readonly roster: Roster }
  | {
      readonly ok: false;
      readonly fault: "underivable" | "duplicate-account" | "overlap";
      readonly detail: string;
    };

function defineBuyer<const B extends readonly [string, ...string[]]>(spec: {
  readonly id: "kyle";
  readonly bots: B;
  readonly defaultBot: B[number];
}): {
  readonly id: "kyle";
  readonly bots: B;
  readonly defaultBot: B[number];
} {
  return spec;
}

// Every person is a separate sub-account of the root. A NEAR parent has no control over a sub-account it created.
export function resolveRoster(root: ParentAccount): ResolveRoster {
  const kyleParent = personOf(BUYER.id, root);
  if (!kyleParent) return failRoster("underivable", notAnAccount(`${BUYER.id}.${root}`));
  const buyers: BuyerSeat[] = [];
  const byBot = new Map<string, BuyerSeat>();
  const shops: ShopSeat[] = [];
  const byProvider = new Map<ProviderId, ShopSeat>();
  const taken = new Map<string, string>();
  const take = (account: AccountId, label: string): ResolveRoster | null => {
    const prior = taken.get(account);
    if (prior !== undefined) return failRoster("duplicate-account", `${account} belongs to ${prior} and ${label}`);
    taken.set(account, label);
    return null;
  };

  let defaultBuyer: BuyerSeat | null = null;
  for (const bot of BUYER.bots) {
    const account = walletOf(bot, kyleParent);
    if (!account) return failRoster("underivable", notAnAccount(`${bot}.${kyleParent}`));
    const clash = take(account, bot);
    if (clash) return clash;
    const seat = sealBuyer({ kind: "buyer", personId: BUYER.id, parent: kyleParent, bot, account });
    buyers.push(seat);
    byBot.set(bot, seat);
    if (bot === BUYER.defaultBot) defaultBuyer = seat;
  }
  if (defaultBuyer === null) return failRoster("underivable", `default bot ${BUYER.defaultBot} was not sealed`);

  for (const shop of SHOPS) {
    const parent = personOf(shop.id, root);
    if (!parent) return failRoster("underivable", notAnAccount(`${shop.id}.${root}`));
    const providerId = parseProviderId(shop.providerId);
    if (!providerId) return failRoster("underivable", `shop provider ${shop.providerId} is not a provider id`);
    if (byBot.has(providerId)) return failRoster("overlap", `${providerId} names a Kyle bot and a shop`);
    if (byProvider.has(providerId)) return failRoster("overlap", `${providerId} is on more than one shop`);
    const account = walletOf(providerId, parent);
    if (!account) return failRoster("underivable", notAnAccount(`${providerId}.${parent}`));
    const clash = take(account, providerId);
    if (clash) return clash;
    const seat = sealShop({ kind: "specialist", personId: shop.id, parent, providerId, account });
    shops.push(seat);
    byProvider.set(providerId, seat);
  }

  const seats: readonly (BuyerSeat | ShopSeat)[] = [...buyers, ...shops];
  const payer = defaultBuyer;
  return {
    ok: true,
    roster: {
      root,
      defaultBuyer: payer,
      buyer(name) {
        return byBot.get(name) ?? null;
      },
      shop(providerId) {
        return byProvider.get(providerId) ?? null;
      },
      cover(providerIds) {
        const wanted = new Set<ProviderId>();
        const missing: ProviderId[] = [];
        for (const id of providerIds) {
          if (wanted.has(id)) continue;
          wanted.add(id);
          if (!byProvider.has(id)) missing.push(id);
        }
        const extra: ProviderId[] = [];
        for (const id of byProvider.keys()) {
          if (!wanted.has(id)) extra.push(id);
        }
        if (missing.length > 0 || extra.length > 0) return { ok: false, missing, extra };
        return { ok: true, byId: byProvider };
      },
      forest() {
        return seats.map((seat): ForestRow => {
          if (seat.kind === "buyer") {
            return {
              personId: seat.personId,
              parent: seat.parent,
              bot: seat.bot,
              account: seat.account,
              role: seat.account === payer.account ? "default-payer" : "payer",
            };
          }
          return {
            personId: seat.personId,
            parent: seat.parent,
            bot: seat.providerId,
            account: seat.account,
            role: "specialist",
          };
        });
      },
    },
  };
}

function failRoster(fault: "underivable" | "duplicate-account" | "overlap", detail: string): ResolveRoster {
  return { ok: false, fault, detail };
}

function notAnAccount(name: string): string {
  if (name.length > 64) {
    return `${name} is ${name.length} characters and a NEAR account allows at most 64. Use a shorter root account.`;
  }
  return `${name} is not a valid NEAR account id`;
}

function personOf(person: string, root: ParentAccount): ParentAccount | null {
  return parseParentAccount(`${person}.${root}`);
}

// Account ids are minted only here.
function walletOf(bot: string, ownerParent: ParentAccount): AccountId | null {
  if (!BOT_NAME.test(bot)) return null;
  return parseAccountId(`${bot}.${ownerParent}`);
}

function sealBuyer(seat: {
  readonly kind: "buyer";
  readonly personId: (typeof BUYER.id);
  readonly parent: ParentAccount;
  readonly bot: KyleBot;
  readonly account: AccountId;
}): BuyerSeat {
  return seat as BuyerSeat;
}

function sealShop(seat: {
  readonly kind: "specialist";
  readonly personId: (typeof SHOPS)[number]["id"];
  readonly parent: ParentAccount;
  readonly providerId: ProviderId;
  readonly account: AccountId;
}): ShopSeat {
  return seat as ShopSeat;
}
