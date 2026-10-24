import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DisclosureFact } from "./crossValidate.ts";

const factSchema = z.object({
  company: z.string(),
  period: z.string(),
  metric: z.string(),
  value: z.number(),
  unit: z.string(),
  source: z.string(),
});

let cached: readonly DisclosureFact[] | null = null;

export function loadFacts(): readonly DisclosureFact[] {
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
  cached = parsed.data;
  return cached;
}
