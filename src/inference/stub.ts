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

// What the buyer model would report about itself, replayed word for word. The buy decision runs on these numbers for real.
function assessment(report: {
  readonly answer: string;
  readonly confidence: number;
  readonly missing: readonly string[];
  readonly coverage: { readonly [providerId: string]: number };
  readonly needs: { readonly [providerId: string]: readonly { readonly key: string; readonly clause?: string }[] };
}): Fixture {
  return { output: JSON.stringify(report), toolCalls: [] };
}

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
    tasks: {
      "consumer.assess": assessment({
        answer: "Press reports put it near KRW 12 trillion. I cannot confirm the filed figure.",
        confidence: 0.3,
        missing: ["the operating profit Samsung filed for Q3 2025"],
        coverage: { disclosure: 1 },
        needs: { disclosure: [{ key: "Samsung Electronics / Q3 2025 / operating profit" }] },
      }),
      "disclosure.answer": SAMSUNG_OPERATING_PROFIT,
    },
  },
  {
    question: "Does Samsung Electronics' Q3 2025 operating profit in the earnings release match the quarterly report?",
    tasks: {
      "consumer.assess": assessment({
        answer: "I cannot compare the two documents without their figures.",
        confidence: 0.1,
        missing: ["the earnings release figure", "the quarterly report figure"],
        coverage: { disclosure: 1 },
        needs: { disclosure: [{ key: "Samsung Electronics / Q3 2025 / operating profit" }] },
      }),
      "disclosure.answer": SAMSUNG_OPERATING_PROFIT,
    },
  },
  {
    question: "What was Samsung's Q3 2025 capex?",
    tasks: {
      // The model names a capex figure the shop's catalog does not list. Code drops that need, so the buyer does
      // not pay for an answer the shop cannot give.
      "consumer.assess": assessment({
        answer: "I do not know Samsung's Q3 2025 capex.",
        confidence: 0.15,
        missing: ["the capex Samsung filed for Q3 2025"],
        coverage: { disclosure: 0.8 },
        needs: { disclosure: [{ key: "Samsung Electronics / Q3 2025 / capex" }] },
      }),
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
    question: "What was Samsung's Q3 2025 revenue?",
    tasks: {
      "consumer.assess": assessment({
        answer: "Samsung reported about KRW 86 trillion in revenue for Q3 2025. I have not checked that against the filing.",
        confidence: 0.55,
        missing: ["the revenue Samsung filed for Q3 2025"],
        coverage: { disclosure: 1 },
        needs: { disclosure: [{ key: "Samsung Electronics / Q3 2025 / revenue" }] },
      }),
      "disclosure.answer": {
        output: "Samsung Electronics reported Q3 2025 revenue of KRW 86.1T.",
        toolCalls: [{
          name: "cross_validate_numbers",
          arguments: {
            claims: [{
              label: "revenue Q3 2025",
              company: "Samsung Electronics",
              period: "Q3 2025",
              metric: "revenue",
              claimed: 86.1,
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
      "consumer.assess": assessment({
        answer: "Unlimited indemnification is often rejected, but I cannot see your playbook.",
        confidence: 0.1,
        missing: ["the playbook's position on indemnification"],
        coverage: { legal: 1 },
        needs: { legal: [{ key: "uncapped-indemnity", clause: "unlimited indemnification clause" }] },
      }),
      "legal.answer": {
        output: "The unlimited indemnification clause fails the playbook.",
        toolCalls: [{
          name: "flag_clauses",
          arguments: {
            clauses: [{
              label: "indemnity",
              text: "unlimited indemnification clause",
              rule: "uncapped-indemnity",
            }],
          },
        }],
      },
    },
  },
  {
    question: "Does this policy cover an outpatient MRI?",
    tasks: {
      "consumer.assess": assessment({
        answer: "Many policies cover an outpatient MRI, but I cannot see this one.",
        confidence: 0.2,
        missing: ["this policy's schedule of covered procedures"],
        coverage: { insurance: 1 },
        needs: { insurance: [{ key: "outpatient-mri" }] },
      }),
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
      "consumer.assess": assessment({
        answer: "Most policies exclude cosmetic surgery, but I cannot see this one.",
        confidence: 0.35,
        missing: ["this policy's exclusions"],
        coverage: { insurance: 1 },
        needs: { insurance: [{ key: "cosmetic-surgery" }] },
      }),
      "insurance.answer": {
        output: "Cosmetic surgery is excluded under this policy.",
        toolCalls: [{
          name: "lookup_coverage",
          arguments: { claims: [{ label: "cosmetic surgery", topic: "cosmetic-surgery", claimed: "excluded" }] },
        }],
      },
    },
  },
  {
    question: "Does our NDA's three-year confidentiality term fail our playbook?",
    tasks: {
      "consumer.assess": assessment({
        answer: "A fixed three-year term is usually acceptable, but I cannot see your playbook.",
        confidence: 0.3,
        missing: ["the playbook's position on confidentiality terms"],
        coverage: { legal: 1 },
        needs: { legal: [{ key: "perpetual-nda", clause: "three-year confidentiality term" }] },
      }),
      // The playbook rejects only perpetual terms, so the honest verdict is clear: nothing for a lying shop to
      // gain but a rule violation it invents.
      "legal.answer": {
        output: "The three-year confidentiality term passes the playbook.",
        toolCalls: [{
          name: "flag_clauses",
          arguments: {
            clauses: [{ label: "confidentiality term", text: "three-year confidentiality term", rule: "perpetual-nda" }],
          },
        }],
      },
    },
  },
  {
    question: "What copay does this policy charge for an outpatient MRI?",
    tasks: {
      "consumer.assess": assessment({
        answer: "Outpatient MRI copays are often 10 to 30 percent, but I cannot see this policy.",
        confidence: 0.2,
        missing: ["this policy's MRI copay"],
        coverage: { insurance: 1 },
        needs: { insurance: [{ key: "outpatient-mri" }, { key: "mri-copay" }] },
      }),
      // The 10 percent copay is deliberate: the schedule says 20, so the shop's own check proves its model wrong.
      "insurance.answer": {
        output: "Outpatient MRI is covered with a 10 percent copay.",
        toolCalls: [{
          name: "lookup_coverage",
          arguments: {
            claims: [
              { label: "outpatient MRI", topic: "outpatient-mri", claimed: "covered" },
              { label: "MRI copay", topic: "mri-copay", claimed: "10" },
            ],
          },
        }],
      },
    },
  },
  {
    question: "What is the capital of France?",
    tasks: {
      "consumer.assess": assessment({
        answer: "Paris is the capital of France.",
        confidence: 0.99,
        missing: [],
        coverage: {},
        needs: {},
      }),
    },
  },
];

type PlanRecording = {
  readonly task: string;
  readonly budget: string;
  readonly parts: readonly { readonly question: string; readonly share: number }[];
};

// Each part is a recorded question above, so the per-part fixtures replay as they do for ask.
// On a fresh data directory the briefing answers part 1 locally, buys part 2 on a counter-offer and parts 3 and 4
// at list price; parts 2 and 4 are affordable only with the money earlier parts left. The policy check declines
// part 1 and buys part 2 on a counter-offer.
const PLANS: readonly PlanRecording[] = [
  {
    task: "Brief me for Monday: France's capital, our NDA's indemnity clause, outpatient MRI cover, and Samsung's Q3 2025 operating profit",
    budget: "0.10",
    parts: [
      { question: "What is the capital of France?", share: 0.2 },
      { question: "Does this NDA's unlimited indemnification clause fail our playbook?", share: 0.2 },
      { question: "Does this policy cover an outpatient MRI?", share: 0.3 },
      { question: "What was Samsung's Q3 2025 operating profit?", share: 0.3 },
    ],
  },
  {
    task: "Check what this policy covers for an outpatient MRI and for cosmetic surgery",
    budget: "0.04",
    parts: [
      { question: "Does this policy cover an outpatient MRI?", share: 0.5 },
      { question: "Does this policy cover cosmetic surgery?", share: 0.5 },
    ],
  },
];

// A live model often fences its JSON, so the recording does too and the parser has to cope.
function planFixture(plan: PlanRecording): Fixture {
  return { output: `\`\`\`json\n${JSON.stringify({ parts: plan.parts }, null, 2)}\n\`\`\``, toolCalls: [] };
}

const BY_QUESTION = new Map<string, Recording>([
  ...RECORDINGS.map((recording): [string, Recording] => [normalize(recording.question), recording]),
  ...PLANS.map((plan): [string, Recording] => [
    normalize(plan.task),
    { question: plan.task, tasks: { "consumer.plan": planFixture(plan) } },
  ]),
]);

// Providers receive the paid question as their input, so one key serves the buyer's assessment and the shop's answer.
function normalize(question: string): string {
  return question.trim().replace(/\s+/g, " ").toLowerCase().replace(/[?.!]+$/, "");
}

export function createStubInference(): Inference {
  return {
    kind: "stub",
    attested: () => [],
    async run(task) {
      const fixture = BY_QUESTION.get(normalize(task.input))?.tasks[task.name];
      if (fixture === undefined) {
        return { ok: false, reason: "no-fixture", detail: task.name === "consumer.plan" ? unrecordedTask() : unrecordedQuestion() };
      }
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
      return { ok: true, value, model: stubModel, attestation: [] };
    },
  };
}

function unrecordedTask(): string {
  const examples = PLANS.map((plan) => `  npx inferpay task "${plan.task}" --budget ${plan.budget}`).join("\n");
  return [
    "No NEAR moved. The stub replays only these recorded tasks:",
    examples,
    "Set NEAR_AI_API_KEY to give it any task.",
  ].join("\n");
}

function unrecordedQuestion(): string {
  const examples = RECORDINGS.map((recording) => `  npx inferpay ask "${recording.question}" --budget 0.10`).join("\n");
  return [
    "No NEAR moved. The stub replays only these recorded questions:",
    examples,
    "Set NEAR_AI_API_KEY to ask anything.",
  ].join("\n");
}
