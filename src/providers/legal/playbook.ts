import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type PlaybookRule = {
  readonly id: string;
  readonly all: readonly RegExp[];
  readonly label: string;
  readonly detail: string;
};

const ruleSchema = z.object({
  id: z.string(),
  all: z.array(z.string().min(1)).min(1),
  label: z.string(),
  detail: z.string(),
});

let cached: readonly PlaybookRule[] | null = null;

export function loadPlaybook(): readonly PlaybookRule[] {
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
  cached = parsed.data.map((rule) => ({ ...rule, all: rule.all.map((source) => new RegExp(source, "i")) }));
  return cached;
}
