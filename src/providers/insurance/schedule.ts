import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { saltSchema, sealDataset, type Dataset, type Fact } from "../../commitment/index.ts";

const factSchema = z.object({
  topic: z.string(),
  value: z.string(),
  source: z.string(),
  salt: saltSchema,
});

let cached: Dataset<Fact> | null = null;

export function loadCoverage(): Dataset<Fact> {
  if (cached) return cached;
  const path = fileURLToPath(new URL("./data/coverage.json", import.meta.url));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("insurance dataset is not json");
  }
  const parsed = z.array(factSchema).safeParse(raw);
  if (!parsed.success) throw new Error("insurance dataset failed its check");
  cached = sealDataset(parsed.data.map(({ salt, ...fact }) => ({ entry: { kind: "fact", ...fact }, salt })));
  return cached;
}
