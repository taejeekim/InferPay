import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseModelId } from "../domain.ts";
import type { Inference } from "./index.ts";

const fixtureSchema = z.object({
  output: z.string(),
  toolCalls: z.array(z.object({ name: z.string(), arguments: z.unknown() })),
});

const parsedStubModel = parseModelId("stub");
if (!parsedStubModel) throw new Error("stub model id failed its check");
const stubModel = parsedStubModel;

type Recording = {
  readonly task: string;
  readonly test: RegExp;
  readonly output: string;
  readonly toolCalls: readonly { readonly name: string; readonly arguments: unknown }[];
};

const RECORDINGS: readonly Recording[] = [
  {
    task: "consumer.route",
    test: /indemnif|nda|clause|playbook|legal/i,
    output: "{\"kind\":\"outsource\",\"providerId\":\"legal\",\"reason\":\"needs the private clause playbook the consumer does not hold\"}",
    toolCalls: [],
  },
  {
    task: "consumer.route",
    test: /mri|copay|insurance|coverage|policy schedule|outpatient/i,
    output: "{\"kind\":\"outsource\",\"providerId\":\"insurance\",\"reason\":\"needs the private policy schedule the consumer does not hold\"}",
    toolCalls: [],
  },
  {
    task: "consumer.route",
    test: /samsung|filing|q3\s*2025|operating profit|capex|revenue|earnings/i,
    output: "{\"kind\":\"outsource\",\"providerId\":\"disclosure\",\"reason\":\"needs filing figures the consumer does not hold\"}",
    toolCalls: [],
  },
  {
    task: "disclosure.answer",
    test: /capex/i,
    output: "Samsung Electronics Q3 2025 capex is not in the filed figures this provider holds.",
    toolCalls: [{
      name: "cross_validate_numbers",
      arguments: {
        claims: [{
          label: "capex Q3 2025",
          company: "Samsung Electronics",
          period: "Q3 2025",
          metric: "capex",
          claimed: 1,
          unit: "KRW T",
        }],
      },
    }],
  },
  {
    task: "disclosure.answer",
    test: /samsung|filing|q3\s*2025|operating profit|revenue|earnings/i,
    output: "Operating profit matches across both documents: KRW 12.1T.",
    toolCalls: [{
      name: "cross_validate_numbers",
      arguments: {
        claims: [
          {
            label: "operating profit Q3 2025",
            company: "Samsung Electronics",
            period: "Q3 2025",
            metric: "operating profit",
            claimed: 12.1,
            unit: "KRW T",
          },
          {
            label: "revenue Q3 2025",
            company: "Samsung Electronics",
            period: "Q3 2025",
            metric: "revenue",
            claimed: 79.0,
            unit: "KRW T",
          },
        ],
      },
    }],
  },
  {
    task: "legal.answer",
    test: /indemnif|nda|clause|playbook|legal/i,
    output: "The unlimited indemnification clause fails the playbook.",
    toolCalls: [{
      name: "flag_clauses",
      arguments: {
        clauses: [{
          label: "indemnity",
          text: "The receiving party shall provide unlimited indemnification for any claim.",
        }],
      },
    }],
  },
  {
    task: "insurance.answer",
    test: /cosmetic/i,
    output: "Cosmetic surgery is excluded under this policy.",
    toolCalls: [{
      name: "lookup_coverage",
      arguments: {
        claims: [{
          label: "cosmetic surgery",
          topic: "cosmetic-surgery",
          claimed: "excluded",
        }],
      },
    }],
  },
  {
    task: "insurance.answer",
    test: /mri|copay|outpatient|coverage|insurance|policy/i,
    output: "Outpatient MRI is covered at a 20 percent copay.",
    toolCalls: [{
      name: "lookup_coverage",
      arguments: {
        claims: [{
          label: "outpatient MRI",
          topic: "outpatient-mri",
          claimed: "covered",
        }],
      },
    }],
  },
];

const KNOWN_QUESTIONS = [
  "What was Samsung's Q3 2025 operating profit?",
  "Does this NDA's unlimited indemnification clause fail our playbook?",
  "Does this policy cover an outpatient MRI?",
];

export function createStubInference(fixtures: string): Inference {
  return {
    kind: "stub",
    async run(task) {
      const hash = createHash("sha256").update(task.input).digest("hex");
      const hashed = join(fixtures, task.name, `${hash}.json`);
      const fromFile = await readFirst([hashed]);
      const recording = RECORDINGS.find((item) => item.task === task.name && item.test.test(task.input));
      const rawText = fromFile ?? (recording === undefined ? null : JSON.stringify({
        output: recording.output,
        toolCalls: recording.toolCalls,
      }));
      if (rawText === null) return { ok: false, reason: "no-fixture", detail: missingFixture(task.name) };
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        return { ok: false, reason: "unparseable-output", detail: "fixture is not json" };
      }
      const fixture = fixtureSchema.safeParse(raw);
      if (!fixture.success) return { ok: false, reason: "unparseable-output", detail: "fixture failed its check" };
      const toolResults: { name: string; result: unknown }[] = [];
      for (const call of fixture.data.toolCalls) {
        const found = task.tools.find((item) => item.name === call.name);
        if (!found) {
          toolResults.push({ name: call.name, result: { error: "unknown tool" } });
          continue;
        }
        const invoked = found.invoke(call.arguments);
        toolResults.push({ name: call.name, result: invoked.ok ? invoked.result : { error: invoked.error } });
      }
      const value = task.parseOutput(fixture.data.output, toolResults);
      if (value === null) return { ok: false, reason: "unparseable-output", detail: "output failed its check" };
      return { ok: true, value, model: stubModel };
    },
  };
}

async function readFirst(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      return await readFile(path, "utf8");
    } catch {
      continue;
    }
  }
  return null;
}

function missingFixture(task: string): string {
  const examples = KNOWN_QUESTIONS.map((question) => `  npx inferpay ask "${question}" --budget 0.10`).join("\n");
  return `${task} has no recording for this question. Try one of:\n${examples}`;
}
