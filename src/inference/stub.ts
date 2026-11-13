import { parseModelId } from "../domain.ts";
import type { Inference } from "./index.ts";

const parsedStubModel = parseModelId("stub");
if (!parsedStubModel) throw new Error("stub model id failed its check");
const stubModel = parsedStubModel;

type Fixture = {
  readonly output: string;
  readonly toolCalls: readonly { readonly name: string; readonly arguments: unknown }[];
};

type Recording = {
  readonly question: string;
  readonly tasks: { readonly [taskName: string]: Fixture };
};

function route(providerId: string, reason: string): Fixture {
  return { output: JSON.stringify({ kind: "outsource", providerId, reason }), toolCalls: [] };
}

const LEGAL_ROUTE = route("legal", "needs the private clause playbook the consumer does not hold");
const INSURANCE_ROUTE = route("insurance", "needs the private policy schedule the consumer does not hold");
const DISCLOSURE_ROUTE = route("disclosure", "needs filing figures the consumer does not hold");

// The revenue claim of 86.0 against a filed 86.1 is deliberate. It shows the cross-check catching a model error.
const SAMSUNG_OPERATING_PROFIT: Fixture = {
  output: "Operating profit matches across both documents: KRW 12.2T.",
  toolCalls: [{
    name: "cross_validate_numbers",
    arguments: {
      claims: [
        {
          label: "operating profit Q3 2025",
          company: "Samsung Electronics",
          period: "Q3 2025",
          metric: "operating profit",
          claimed: 12.2,
          unit: "KRW T",
        },
        {
          label: "revenue Q3 2025",
          company: "Samsung Electronics",
          period: "Q3 2025",
          metric: "revenue",
          claimed: 86.0,
          unit: "KRW T",
        },
      ],
    },
  }],
};

const RECORDINGS: readonly Recording[] = [
  {
    question: "What was Samsung's Q3 2025 operating profit?",
    tasks: { "consumer.route": DISCLOSURE_ROUTE, "disclosure.answer": SAMSUNG_OPERATING_PROFIT },
  },
  {
    question: "Does Samsung Electronics' Q3 2025 operating profit in the earnings release match the quarterly report?",
    tasks: { "consumer.route": DISCLOSURE_ROUTE, "disclosure.answer": SAMSUNG_OPERATING_PROFIT },
  },
  {
    question: "What was Samsung's Q3 2025 capex?",
    tasks: {
      "consumer.route": DISCLOSURE_ROUTE,
      "disclosure.answer": {
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
    },
  },
  {
    question: "Does this NDA's unlimited indemnification clause fail our playbook?",
    tasks: {
      "consumer.route": LEGAL_ROUTE,
      "legal.answer": {
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
    },
  },
  {
    question: "Does this policy cover an outpatient MRI?",
    tasks: {
      "consumer.route": INSURANCE_ROUTE,
      "insurance.answer": {
        output: "Outpatient MRI is covered at a 20 percent copay.",
        toolCalls: [{
          name: "lookup_coverage",
          arguments: { claims: [{ label: "outpatient MRI", topic: "outpatient-mri", claimed: "covered" }] },
        }],
      },
    },
  },
  {
    question: "Does this policy cover cosmetic surgery?",
    tasks: {
      "consumer.route": INSURANCE_ROUTE,
      "insurance.answer": {
        output: "Cosmetic surgery is excluded under this policy.",
        toolCalls: [{
          name: "lookup_coverage",
          arguments: { claims: [{ label: "cosmetic surgery", topic: "cosmetic-surgery", claimed: "excluded" }] },
        }],
      },
    },
  },
];

const BY_QUESTION = new Map(RECORDINGS.map((recording) => [normalize(recording.question), recording]));

// Providers receive the paid question as their input, so one key serves routing and answering.
function normalize(question: string): string {
  return question.trim().replace(/\s+/g, " ").toLowerCase().replace(/[?.!]+$/, "");
}

export function createStubInference(): Inference {
  return {
    kind: "stub",
    async run(task) {
      const fixture = BY_QUESTION.get(normalize(task.input))?.tasks[task.name];
      if (fixture === undefined) return { ok: false, reason: "no-fixture", detail: unrecordedQuestion() };
      const toolResults: { name: string; result: unknown }[] = [];
      for (const call of fixture.toolCalls) {
        const found = task.tools.find((item) => item.name === call.name);
        if (!found) {
          toolResults.push({ name: call.name, result: { error: "unknown tool" } });
          continue;
        }
        const invoked = found.invoke(call.arguments);
        toolResults.push({ name: call.name, result: invoked.ok ? invoked.result : { error: invoked.error } });
      }
      const value = task.parseOutput(fixture.output, toolResults);
      if (value === null) return { ok: false, reason: "unparseable-output", detail: "output failed its check" };
      return { ok: true, value, model: stubModel };
    },
  };
}

function unrecordedQuestion(): string {
  const examples = RECORDINGS.map((recording) => `  npx inferpay ask "${recording.question}" --budget 0.10`).join("\n");
  return [
    "No NEAR moved. The stub replays only these recorded questions:",
    examples,
    "Set NEAR_AI_API_KEY to ask anything.",
  ].join("\n");
}
