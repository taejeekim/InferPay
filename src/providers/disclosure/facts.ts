import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { saltSchema, sealDataset, type Dataset, type Figure } from "../../commitment/index.ts";

const factSchema = z.object({
  company: z.string(),
  period: z.string(),
  metric: z.string(),
  value: z.number(),
  unit: z.string(),
  source: z.string(),
  salt: saltSchema,
});

let cached: Dataset<Figure> | null = null;

export function loadFacts(): Dataset<Figure> {
  if (cached) return cached;
  const path = fileURLToPath(new URL("./data/samsung-q3-2025.json", import.meta.url));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("disclosure dataset is not json");
  }
  const parsed = z.array(factSchema).safeParse(raw);
  if (!parsed.success) throw new Error("disclosure dataset failed its check");
  cached = sealDataset(parsed.data.map(({ salt, ...fact }) => ({ entry: { kind: "figure", ...fact }, salt })));
  return cached;
}
