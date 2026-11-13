import { parseDecimalAmount, parseProviderId } from "../../domain.ts";
import { tool, type Inference } from "../../inference/index.ts";
import type { Fulfilment, PaidOrder, Provider } from "../types.ts";
import { lookupCoverage, parseFactChecks, parseFactClaims } from "./lookup.ts";
import { loadCoverage } from "./schedule.ts";

const providerId = parseProviderId("insurance");
if (!providerId) throw new Error("insurance id failed its check");
const quoteNear = parseDecimalAmount("0.02");
if (!quoteNear) throw new Error("insurance price failed its check");

function factParameters(topics: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["claims"],
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "topic", "claimed"],
          properties: {
            label: { type: "string" },
            topic: { type: "string", enum: topics },
            claimed: {
              type: "string",
              description: "The value you state: covered, excluded, or a bare number for a percent.",
            },
          },
        },
      },
    },
  };
}

export const insurance: Provider = {
  quoteNear,
  describe: {
    id: providerId,
    name: "Insurance coverage",
    specialty: "Private policy schedule: MRI, copay, exclusions",
    routingHint:
      "Answers coverage questions from a private policy schedule the caller does not hold. Use for MRI, copay, and exclusions.",
  },
  fulfil(paid, deps) {
    return answerInsurance(paid, deps.inference);
  },
};

async function answerInsurance(paid: PaidOrder, inference: Inference): Promise<Fulfilment> {
  const facts = loadCoverage();
  const lookup = tool({
    name: "lookup_coverage",
    description: "Check cited coverage claims against the private policy schedule. Pass every claim you cite.",
    parameters: factParameters(unique(facts.map((fact) => fact.topic))),
    parseArgs: parseFactClaims,
    run: (args) => lookupCoverage(args, facts),
  });
  const result = await inference.run({
    name: "insurance.answer",
    role: "provider",
    system: [
      "You are an insurance coverage specialist.",
      "Call lookup_coverage with every coverage claim you cite.",
      "Then answer in one sentence.",
      "Do not restate the tool's verdicts.",
    ].join(" "),
    input: paid.question,
    tools: [lookup],
    parseOutput: (raw, toolResults) => {
      const text = raw.trim();
      const last = [...toolResults].reverse().find((item) => item.name === "lookup_coverage");
      if (text.length === 0 || !last) return null;
      const checks = parseFactChecks(last.result);
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
