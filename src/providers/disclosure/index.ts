import { parseDecimalAmount, parseProviderId } from "../../domain.ts";
import { tool, type Inference } from "../../inference/index.ts";
import type { Fulfilment, PaidOrder, Provider } from "../types.ts";
import { needsPrompt, openNeeds } from "../open.ts";
import { catalogOf, parseAssertedChecks, type Figure } from "../../commitment/index.ts";
import { crossValidate, parseClaims } from "./crossValidate.ts";
import { loadFacts } from "./facts.ts";

const providerId = parseProviderId("disclosure");
if (!providerId) throw new Error("disclosure id failed its check");
const quoteNear = parseDecimalAmount("0.02");
if (!quoteNear) throw new Error("disclosure price failed its check");
const floorNear = parseDecimalAmount("0.018");
if (!floorNear) throw new Error("disclosure floor failed its check");

function claimParameters(facts: readonly Figure[]) {
  const values = (key: "company" | "period" | "metric" | "unit") => [...new Set(facts.map((fact) => fact[key]))];
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
          required: ["label", "company", "period", "metric", "claimed", "unit"],
          properties: {
            label: { type: "string" },
            company: { type: "string", enum: values("company") },
            period: { type: "string", enum: values("period") },
            metric: { type: "string", enum: values("metric") },
            claimed: { type: "number" },
            unit: { type: "string", enum: values("unit") },
          },
        },
      },
    },
  };
}

export const disclosure: Provider = {
  quoteNear,
  floorNear,
  describe: {
    id: providerId,
    name: "Disclosure analyst",
    specialty: "Disclosure analysis, number cross-check",
    routingHint:
      "Answers questions about company filings and earnings releases. Every cited figure is checked against filed disclosures.",
  },
  commitment: () => loadFacts().commitment,
  catalog: () => catalogOf(loadFacts().entries),
  fulfil(paid, deps) {
    return answerDisclosure(paid, deps.inference);
  },
};

async function answerDisclosure(paid: PaidOrder, inference: Inference): Promise<Fulfilment> {
  const data = loadFacts();
  const validate = tool({
    name: "cross_validate_numbers",
    description: "Check cited figures against filed disclosures. Pass every number the answer will cite.",
    parameters: claimParameters(data.entries),
    parseArgs: parseClaims,
    run: (args) => crossValidate(args, data),
  });
  const result = await inference.run({
    name: "disclosure.answer",
    role: "provider",
    system: [
      "You are a filings analyst.",
      "Call cross_validate_numbers with every figure you cite.",
      "Then answer in one sentence.",
      "Do not restate the tool's verdicts.",
      needsPrompt(paid.needs),
    ].join(" ").trim(),
    input: paid.question,
    tools: [validate],
    parseOutput: (raw, toolResults) => {
      const text = raw.trim();
      const last = [...toolResults].reverse().find((item) => item.name === "cross_validate_numbers");
      if (text.length === 0 || !last) return null;
      const checks = parseAssertedChecks(last.result);
      if (!checks) return null;
      return { text, checks };
    },
  });
  if (!result.ok) return { ok: false, reason: result.detail, retryable: result.reason === "transport" };
  return {
    ok: true,
    answer: {
      text: result.value.text,
      checks: openNeeds(result.value.checks, paid.needs, data),
      model: result.model,
      inference: inference.kind,
      attestation: result.attestation,
    },
  };
}
