import { z } from "zod";
import type { ProviderId } from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import type { Listing } from "../market/index.ts";
import { catalogName, quotedFrom, type CatalogItem, type Need } from "../commitment/index.ts";
import { percentOf, type Percent, type SelfAssessment } from "./decide.ts";

type Shop = Pick<Listing, "id" | "routingHint" | "catalog"> & { readonly commitment: Pick<Listing["commitment"], "status"> };

// What the buyer will require each shop to open, after code has checked the model's picks against each catalog.
export type Needs = {
  readonly byShop: ReadonlyMap<ProviderId, readonly Need[]>;
  readonly dropped: readonly Dropped[];
};

// A key the model named that code refused. It never reaches an order.
export type Dropped = {
  readonly shop: ProviderId;
  readonly key: string;
  // no-commitment: the shop has no root the buyer could read, so no opening of any key could be verified.
  readonly why: "not-in-catalog" | "clause-not-quoted" | "no-commitment";
};

export type Assessed = { readonly assessment: SelfAssessment; readonly needs: Needs };

const needsSchema = z.record(z.string(), z.array(z.object({ key: z.string(), clause: z.string().optional() })));

const assessmentSchema = z.object({
  answer: z.string().transform(oneLine).pipe(z.string().min(1)),
  confidence: z.number(),
  missing: z.array(z.string()).default([]),
  coverage: z.record(z.string(), z.number()).default({}),
  needs: needsSchema.default({}),
});

export async function assess(
  inference: Inference,
  question: string,
  shops: readonly Shop[],
): Promise<({ readonly ok: true } & Assessed) | { readonly ok: false; readonly detail: string }> {
  const result = await inference.run({
    name: "consumer.assess",
    role: "consumer",
    system: assessSystem(shops),
    input: question,
    tools: [],
    parseOutput: (raw) => parseAssessment(raw, question, shops),
  });
  if (!result.ok) return { ok: false, detail: result.detail };
  return { ok: true, ...result.value };
}

function parseAssessment(raw: string, question: string, shops: readonly Shop[]): Assessed | null {
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open === -1 || close < open) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(open, close + 1));
  } catch {
    return null;
  }
  const parsed = assessmentSchema.safeParse(data);
  if (!parsed.success) return null;
  const confidence = percentOf(parsed.data.confidence);
  if (confidence === null) return null;
  const byShop = new Map<ProviderId, readonly Need[]>();
  const dropped: Dropped[] = [];
  const coverage = new Map<ProviderId, Percent>();
  for (const shop of shops) {
    const named = parsed.data.needs[shop.id] ?? [];
    const picked = shop.commitment.status === "published"
      ? pickNeeds(shop, named, question)
      : { needs: [], dropped: named.map(({ key }): Dropped => ({ shop: shop.id, key: oneLine(key), why: "no-commitment" })) };
    dropped.push(...picked.dropped);
    if (picked.needs.length > 0) byShop.set(shop.id, picked.needs);
    const share = parsed.data.coverage[shop.id];
    if (share === undefined) continue;
    const covered = percentOf(share);
    if (covered === null) return null;
    // A shop that holds none of the keys the answer needs covers none of it, whatever share the model guessed.
    if (picked.needs.length > 0) coverage.set(shop.id, covered);
  }
  const missing = parsed.data.missing.map(oneLine).filter((fact) => fact.length > 0);
  return { assessment: { answer: parsed.data.answer, confidence, missing, coverage }, needs: { byShop, dropped } };
}

function pickNeeds(
  shop: Shop,
  named: readonly { readonly key: string; readonly clause?: string | undefined }[],
  question: string,
): { needs: Need[]; dropped: Dropped[] } {
  const needs: Need[] = [];
  const dropped: Dropped[] = [];
  const seen = new Set<string>();
  for (const { key, clause } of named) {
    const item = shop.catalog.find((candidate) => sameName(catalogName(candidate), key));
    if (item === undefined) {
      dropped.push({ shop: shop.id, key: oneLine(key), why: "not-in-catalog" });
      continue;
    }
    const need = needFor(item, oneLine(clause ?? ""), question);
    if (need === null) {
      dropped.push({ shop: shop.id, key: catalogName(item), why: "clause-not-quoted" });
      continue;
    }
    const id = JSON.stringify(need);
    if (seen.has(id)) continue;
    seen.add(id);
    needs.push(need);
  }
  return { needs, dropped };
}

// A rule is tested against a clause, so a rule need without a clause from the question asks for nothing.
function needFor(item: CatalogItem, clause: string, question: string): Need | null {
  if (item.kind !== "rule") return item;
  if (!quotedFrom(question, clause)) return null;
  return { kind: "rule", id: item.id, clause };
}

function sameName(a: string, b: string): boolean {
  return oneLine(a).toLowerCase() === oneLine(b).toLowerCase();
}

// The CLI prints these in one column, so a line break from the model would split the block.
export function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function assessSystem(shops: readonly Shop[]): string {
  return [
    "You are a buyer agent. Before any money moves, assess how well you can answer the question on your own.",
    "Reply with one JSON object and no other text:",
    '{"answer":"...","confidence":0.0,"missing":["..."],"coverage":{"shop-id":0.0},"needs":{"shop-id":[{"key":"...","clause":"..."}]}}',
    "answer: your best answer from what you know now, in one or two sentences.",
    "confidence: the probability from 0 to 1 that your answer is right. When the answer depends on a private document you cannot see, you are guessing, so keep it low.",
    "missing: the facts you would need but cannot know without private data. Use [] when you need none.",
    "coverage: for each shop below, the share from 0 to 1 of the missing facts that its private data covers. Use 0 when a shop does not help or when nothing is missing.",
    "needs: for each shop, the keys from its catalog that a right answer depends on. If you buy, the shop must open every key you name, so name each key the answer needs and no other. Copy each key exactly as its catalog lists it. Leave a shop out when its catalog holds nothing the question needs.",
    "clause: only for a key from a catalog of playbook rules. The clause that rule should be tested against, quoted word for word from the question. Leave it out for every other key.",
    "Shops, one per line as id | what it does | catalog:",
    ...shops.map((shop) => `${shop.id} | ${shop.routingHint} | ${catalogText(shop.catalog)}`),
  ].join("\n");
}

function catalogText(catalog: readonly CatalogItem[]): string {
  const kind = catalog.every((item) => item.kind === "rule") ? "catalog of playbook rules" : "catalog";
  return `${kind}: ${catalog.map(catalogName).join("; ")}`;
}
