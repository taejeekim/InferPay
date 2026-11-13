import { z } from "zod";
import type { FlagCheck } from "../types.ts";
import type { PlaybookRule } from "./playbook.ts";

type ClaimedClause = {
  readonly label: string;
  readonly text: string;
};

const clauseSchema = z.object({
  label: z.string(),
  text: z.string(),
});

export function parseClauses(raw: unknown): readonly ClaimedClause[] | null {
  const parsed = z.object({ clauses: z.array(clauseSchema) }).safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.clauses;
}

export function parseFlags(raw: unknown): readonly FlagCheck[] | null {
  const parsed = z.array(z.object({
    kind: z.literal("flag"),
    verdict: z.enum(["raised", "clear"]),
    label: z.string(),
    detail: z.string(),
  })).safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

export function flagClauses(
  clauses: readonly ClaimedClause[],
  rules: readonly PlaybookRule[],
): readonly FlagCheck[] {
  return clauses.map((clause) => {
    const hit = rules.find((rule) => rule.all.every((term) => term.test(clause.text)));
    if (!hit) {
      return {
        kind: "flag",
        verdict: "clear",
        label: clause.label,
        detail: "No playbook rule matched this clause.",
      };
    }
    return {
      kind: "flag",
      verdict: "raised",
      label: hit.label,
      detail: hit.detail,
    };
  });
}
