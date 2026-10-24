import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type CoverageFact = {
  readonly topic: string;
  readonly value: string;
  readonly source: string;
};

const factSchema = z.object({
  topic: z.string(),
  value: z.string(),
  source: z.string(),
});

let cached: readonly CoverageFact[] | null = null;

export function loadCoverage(): readonly CoverageFact[] {
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
  cached = parsed.data;
  return cached;
}
