import assert from "node:assert/strict";
import test from "node:test";
import { progressLine } from "../cli/render.ts";
import { catalogName, catalogOf, type CatalogItem, type Need } from "../commitment/index.ts";
import { assess } from "../consumer/assess.ts";
import { decide, settleCounter, type Decision } from "../consumer/decide.ts";
import { parseAssetId, parseDecimalAmount, parseModelId, parseProviderId, toUnits, type Price, type ProviderId } from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import type { Reputation } from "../market/index.ts";
import { sampleDatasets } from "./evidence.ts";

type SiteListing = { readonly id: string; readonly price: string; readonly reputation: { readonly ratings: number; readonly average: number } };
type SitePlan = { readonly kind: string; readonly offer?: string; readonly option?: { readonly providerId: string } };
type SiteDecide = {
  decide(input: {
    value: string;
    confidence: number;
    missing: readonly string[];
    coverage: Record<string, number>;
    needs: Record<string, readonly Need[]>;
    listings: readonly SiteListing[];
  }): SitePlan;
  settleCounter(plan: SitePlan, reply: "accepted" | "refused"): SitePlan;
  replyOf(offer: string, floor: string): "accepted" | "refused";
  decideLines(decision: SitePlan, needs: Record<string, readonly Need[]>): readonly string[];
};

const site = (await import(new URL("../../docs/js/decide.js", import.meta.url).href)) as SiteDecide;

const asset = (() => {
  const parsed = parseAssetId("near");
  if (!parsed) throw new Error("asset fixture");
  return parsed;
})();

function price(amount: string): Price {
  const parsed = parseDecimalAmount(amount);
  if (!parsed) throw new Error(`amount fixture ${amount}`);
  return { asset, symbol: "NEAR", amount: parsed };
}

function provider(id: string): ProviderId {
  const parsed = parseProviderId(id);
  if (!parsed) throw new Error(`provider fixture ${id}`);
  return parsed;
}

const QUESTION = "Does this NDA's unlimited indemnification clause fail our playbook?";

const CATALOGS: Record<string, readonly CatalogItem[]> = Object.fromEntries(
  Object.entries(sampleDatasets()).map(([id, dataset]) => [id, catalogOf(dataset.entries)]),
);

const NEEDS = {
  insurance: { kind: "fact", topic: "outpatient-mri" },
  copay: { kind: "fact", topic: "mri-copay" },
  disclosure: { kind: "figure", company: "Samsung Electronics", period: "Q3 2025", metric: "revenue" },
  legal: { kind: "rule", id: "uncapped-indemnity", clause: "unlimited indemnification clause" },
} as const satisfies Record<string, Need>;

type Shop = {
  readonly id: string;
  readonly ask: string;
  readonly floor: string;
  readonly coverage: number;
  readonly needs: readonly Need[];
  readonly ratings: number;
  readonly average: number;
};

function reputation(shop: Shop): Reputation {
  return shop.ratings === 0
    ? { kind: "unrated", completedJobs: 0 }
    : { kind: "rated", completedJobs: shop.ratings, ratings: shop.ratings, average: shop.average };
}

// A model that replies with fixed JSON, so the CLI's own assess parses the needs and applies its coverage rule.
function replying(raw: string): Inference {
  const model = parseModelId("fake");
  if (!model) throw new Error("model fixture");
  return {
    kind: "near-ai",
    async run(task) {
      const value = task.parseOutput(raw, []);
      if (value === null) return { ok: false, reason: "unparseable-output", detail: raw };
      return { ok: true, value, model, attestation: [] };
    },
    attested: () => [],
  };
}

async function typescript(value: string, confidence: number, shops: readonly Shop[]): Promise<string> {
  const raw = JSON.stringify({
    answer: "a guess",
    confidence: confidence / 100,
    missing: ["a fact"],
    coverage: Object.fromEntries(shops.map((shop) => [shop.id, shop.coverage / 100])),
    needs: Object.fromEntries(shops.map((shop) => [shop.id, shop.needs.map((need) => ({ key: catalogName(need), ...(need.kind === "rule" ? { clause: need.clause } : {}) }))])),
  });
  const catalogued = shops.map((shop) => ({ id: provider(shop.id), routingHint: "", catalog: CATALOGS[shop.id] ?? [] }));
  const assessed = await assess(replying(raw), QUESTION, catalogued);
  if (!assessed.ok) throw new Error(assessed.detail);
  assert.equal(assessed.needs.dropped.length, 0, "every fixture need is in its shop's catalog");
  const plan = decide({
    value: price(value),
    assessment: assessed.assessment,
    listings: shops.map((shop) => ({ id: provider(shop.id), price: price(shop.ask), reputation: reputation(shop) })),
  });
  let decision: Decision;
  if (plan.kind === "counter") {
    const shop = shops.find((item) => item.id === plan.option.providerId);
    if (!shop) throw new Error("counter to an unknown shop");
    decision = settleCounter(plan, toUnits(plan.offer.amount) >= toUnits(price(shop.floor).amount) ? "accepted" : "refused");
  } else {
    decision = plan;
  }
  return progressLine({ step: "decide", decision, needs: assessed.needs }, "mock");
}

function browser(value: string, confidence: number, shops: readonly Shop[]): string {
  const needs = Object.fromEntries(shops.map((shop) => [shop.id, shop.needs]));
  const plan = site.decide({
    value,
    confidence,
    missing: ["a fact"],
    coverage: Object.fromEntries(shops.map((shop) => [shop.id, shop.coverage])),
    needs,
    listings: shops.map((shop) => ({ id: shop.id, price: shop.ask, reputation: { ratings: shop.ratings, average: shop.average } })),
  });
  let decision = plan;
  if (plan.kind === "counter") {
    const shop = shops.find((item) => item.id === plan.option?.providerId);
    if (!shop || plan.offer === undefined) throw new Error("counter to an unknown shop");
    decision = site.settleCounter(plan, site.replyOf(plan.offer, shop.floor));
  }
  return site.decideLines(decision, needs).join("\n");
}

const REPUTATIONS = [
  { ratings: 0, average: 0 },
  { ratings: 1, average: 5 },
  { ratings: 2, average: 2.5 },
  { ratings: 5, average: 5 },
  { ratings: 3, average: 1 },
  { ratings: 7, average: 4.142857142857143 },
];

test("the page's decide block equals the CLI's over a grid of one-shop inputs", async () => {
  const outcomes = new Set<string>();
  let cases = 0;
  for (const value of ["0.01", "0.03", "0.05", "0.1", "1.5"]) {
    for (const confidence of [0, 10, 20, 30, 49, 50, 55, 80, 100]) {
      for (const coverage of [0, 50, 100]) {
        for (const needs of [[], [NEEDS.insurance], [NEEDS.insurance, NEEDS.copay]]) {
          for (const rep of REPUTATIONS) {
            for (const ask of ["0.012", "0.02", "0.03", "0.2"]) {
              for (const floor of ["0.005", "0.012", "0.018"]) {
                const shops = [{ id: "insurance", ask, floor, coverage, needs, ...rep }];
                const expected = await typescript(value, confidence, shops);
                assert.equal(browser(value, confidence, shops), expected, JSON.stringify({ value, confidence, shops }));
                outcomes.add(expected.split("\n")[0]?.replace(/ from \S+ at [\d.]+ NEAR/, "") ?? "");
                cases += 1;
              }
            }
          }
        }
      }
    }
  }
  assert.ok(cases > 9000);
  assert.deepEqual([...outcomes].sort(), [
    "decide    answer locally, pay nothing",
    "decide    answer locally, pay nothing (counter-offer refused)",
    "decide    buy (counter-offer accepted)",
    "decide    buy (list price)",
    "decide    decline, pay nothing",
    "decide    decline, pay nothing (counter-offer refused)",
  ]);
});

test("the page's decide block equals the CLI's with three shops, ties, needs, and asks over the budget", async () => {
  for (const value of ["0.02", "0.03", "0.1"]) {
    for (const confidence of [20, 30, 55]) {
      for (const [a, b] of [[100, 100], [100, 0], [50, 100], [0, 0]] as const) {
        for (const needed of [["disclosure", "legal", "insurance"], [], ["legal"]]) {
          const needs = (id: keyof typeof NEEDS): readonly Need[] => (needed.includes(id) ? [NEEDS[id]] : []);
          const shops: Shop[] = [
            { id: "disclosure", ask: "0.02", floor: "0.018", coverage: a, needs: needs("disclosure"), ratings: 2, average: 2.5 },
            { id: "legal", ask: "0.03", floor: "0.02", coverage: b, needs: needs("legal"), ratings: 0, average: 0 },
            { id: "insurance", ask: "0.02", floor: "0.012", coverage: b, needs: needs("insurance"), ratings: 1, average: 5 },
          ];
          assert.equal(browser(value, confidence, shops), await typescript(value, confidence, shops), JSON.stringify({ value, confidence, a, b, needed }));
        }
      }
    }
  }
});

test("a tie in net goes to the lower ask on the page as in the CLI", async () => {
  const shops: Shop[] = [
    { id: "legal", ask: "0.03", floor: "0.02", coverage: 100, needs: [NEEDS.legal], ratings: 1, average: 5 },
    { id: "disclosure", ask: "0.02", floor: "0.018", coverage: 100, needs: [NEEDS.disclosure], ratings: 0, average: 0 },
  ];
  const expected = await typescript("0.1", 20, shops);
  assert.match(expected, /^decide {4}buy from disclosure/);
  assert.equal(expected.match(/net \+0\.050/g)?.length, 2, "both shops net the same");
  assert.equal(browser("0.1", 20, shops), expected);
});
