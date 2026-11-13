import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { saltSchema, sealDataset, type Dataset, type Rule } from "../../commitment/index.ts";

const ruleSchema = z.object({
  id: z.string(),
  all: z.array(z.string().min(1)).min(1),
  label: z.string(),
  detail: z.string(),
  salt: saltSchema,
});

let cached: Dataset<Rule> | null = null;

export function loadPlaybook(): Dataset<Rule> {
  if (cached) return cached;
  const path = fileURLToPath(new URL("./data/playbook.json", import.meta.url));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("legal playbook is not json");
  }
  const parsed = z.array(ruleSchema).safeParse(raw);
  if (!parsed.success) throw new Error("legal playbook failed its check");
  cached = sealDataset(parsed.data.map(({ salt, ...rule }) => ({ entry: { kind: "rule", ...rule }, salt })));
  return cached;
}
