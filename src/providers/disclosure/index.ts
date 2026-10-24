import { parseProviderId } from "../../domain.ts";
import { tool, type Inference } from "../../inference/index.ts";
import type { Fulfilment, PaidOrder, Provider } from "../types.ts";
import { crossValidate, parseChecks, parseClaims, TOLERANCE_PCT } from "./crossValidate.ts";
import { loadFacts } from "./facts.ts";

const providerId = parseProviderId("disclosure");
if (!providerId) throw new Error("disclosure id failed its check");

const CLAIM_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "company", "period", "metric", "claimed", "unit"],
        properties: {
          label: { type: "string" },
          company: { type: "string" },
          period: { type: "string" },
          metric: { type: "string" },
          claimed: { type: "number" },
          unit: { type: "string" },
        },
      },
    },
  },
};

export const disclosure: Provider = {
  describe: {
    id: providerId,
    name: "Disclosure analyst",
    specialty: "Disclosure analysis, number cross-check",
    routingHint:
      "Answers questions about company filings and earnings releases. Every cited figure is checked against filed disclosures.",
  },
  fulfil(paid, deps) {
    return answerDisclosure(paid, deps.inference);
  },
};

async function answerDisclosure(paid: PaidOrder, inference: Inference): Promise<Fulfilment> {
  const facts = loadFacts();
  const validate = tool({
    name: "cross_validate_numbers",
    description: "Check cited figures against filed disclosures. Pass every number the answer will cite.",
    parameters: CLAIM_PARAMETERS,
    parseArgs: parseClaims,
    run: (args) => crossValidate(args, facts, TOLERANCE_PCT),
  });
  const result = await inference.run({
    name: "disclosure.answer",
    role: "provider",
    system: [
      "You are a filings analyst.",
      "Call cross_validate_numbers with every figure you cite.",
      "Then answer in one sentence.",
      "Do not restate the tool's verdicts.",
    ].join(" "),
    input: paid.question,
    tools: [validate],
    parseOutput: (raw, toolResults) => {
      const text = raw.trim();
      const last = [...toolResults].reverse().find((item) => item.name === "cross_validate_numbers");
      if (text.length === 0 || !last) return null;
      const checks = parseChecks(last.result);
      if (!checks) return null;
      return { text, checks };
    },
  });
  if (!result.ok) return { ok: false, reason: result.detail, retryable: result.reason === "transport" };
  return {
    ok: true,
    answer: {
      text: result.value.text,
      checks: result.value.checks,
      model: result.model,
      inference: inference.kind,
    },
  };
}
