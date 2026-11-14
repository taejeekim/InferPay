import { z } from "zod";
import { factKey, figureKey, ruleKey, type Entry, type Key } from "./rules.ts";

// A key a shop holds an entry for, named without its value. A shop lists these so a buyer can say which it needs.
export type CatalogItem =
  | { readonly kind: "figure"; readonly company: string; readonly period: string; readonly metric: string }
  | { readonly kind: "fact"; readonly topic: string }
  | { readonly kind: "rule"; readonly id: string };

// A key the buyer requires the shop to open. A rule need also carries the clause, quoted from the question, that
// the buyer wants that rule tested against.
export type Need =
  | Extract<CatalogItem, { kind: "figure" | "fact" }>
  | { readonly kind: "rule"; readonly id: string; readonly clause: string };

export function catalogOf(entries: readonly Entry[]): readonly CatalogItem[] {
  return entries.map((entry): CatalogItem => {
    if (entry.kind === "figure") return { kind: "figure", company: entry.company, period: entry.period, metric: entry.metric };
    if (entry.kind === "fact") return { kind: "fact", topic: entry.topic };
    return { kind: "rule", id: entry.id };
  });
}

export function needKey(need: Need | CatalogItem): Key {
  if (need.kind === "figure") return figureKey(need);
  if (need.kind === "fact") return factKey(need);
  return ruleKey(need);
}

// The name a buyer's model copies from the catalog to say it needs that key.
export function catalogName(item: Need | CatalogItem): string {
  if (item.kind === "figure") return `${item.company} / ${item.period} / ${item.metric}`;
  if (item.kind === "fact") return item.topic;
  return item.id;
}

export const needSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("figure"), company: z.string(), period: z.string(), metric: z.string() }),
  z.object({ kind: z.literal("fact"), topic: z.string() }),
  z.object({ kind: z.literal("rule"), id: z.string(), clause: z.string().min(1) }),
]);
