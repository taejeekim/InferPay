import { parseDecimalAmount, parseProviderId } from "../../domain.ts";
import { tool, type Inference } from "../../inference/index.ts";
import type { Fulfilment, PaidOrder, Provider } from "../types.ts";
import { parseAssertedChecks } from "../../commitment/index.ts";
import { flagClauses, parseClauses } from "./flagClauses.ts";
import { loadPlaybook } from "./playbook.ts";

const providerId = parseProviderId("legal");
if (!providerId) throw new Error("legal id failed its check");
const quoteNear = parseDecimalAmount("0.03");
if (!quoteNear) throw new Error("legal price failed its check");
const floorNear = parseDecimalAmount("0.02");
if (!floorNear) throw new Error("legal floor failed its check");

const CLAUSE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["clauses"],
  properties: {
    clauses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "text"],
        properties: {
          label: { type: "string" },
          text: { type: "string", description: "The clause quoted word for word from the question." },
        },
      },
    },
  },
};

export const legal: Provider = {
  quoteNear,
  floorNear,
  describe: {
    id: providerId,
    name: "Legal playbook",
    specialty: "Contract clause review against a private playbook",
    routingHint:
      "Reviews NDAs and drafts. Flags clauses that fail a private playbook the caller does not hold.",
  },
  commitment: () => loadPlaybook().commitment,
  fulfil(paid, deps) {
    return answerLegal(paid, deps.inference);
  },
};

async function answerLegal(paid: PaidOrder, inference: Inference): Promise<Fulfilment> {
  const playbook = loadPlaybook();
  const flag = tool({
    name: "flag_clauses",
    description: "Check draft clauses against the private playbook. Pass every clause you cite.",
    parameters: CLAUSE_PARAMETERS,
    parseArgs: parseClauses,
    run: (args) => flagClauses(args, playbook),
  });
  const result = await inference.run({
    name: "legal.answer",
    role: "provider",
    system: [
      "You are a contracts reviewer.",
      "Call flag_clauses with every clause you cite.",
      "Then answer in one sentence.",
      "Do not restate the tool's verdicts.",
    ].join(" "),
    input: paid.question,
    tools: [flag],
    parseOutput: (raw, toolResults) => {
      const text = raw.trim();
      const last = [...toolResults].reverse().find((item) => item.name === "flag_clauses");
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
      checks: result.value.checks,
      model: result.model,
      inference: inference.kind,
      attestation: result.attestation,
    },
  };
}
