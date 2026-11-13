import type OpenAI from "openai";
import type { ModelId } from "../domain.ts";
import type { InferenceConfig } from "../config.ts";
import { createAttestor, type Attestor, type CallAttestation, type ReportEvidence } from "./attest.ts";
import type { Inference, InferenceResult, InferenceTask, RoleAttestation } from "./index.ts";

const NEAR_AI_BASE_URL = "https://cloud-api.near.ai/v1";
const MAX_ROUNDS = 4;

type Message = OpenAI.Chat.ChatCompletionMessageParam;

type Exchange = { requestBody: Uint8Array | null; responseBody: Uint8Array };

export function createNearAi(config: Extract<InferenceConfig, { kind: "near-ai" }>): Inference {
  const attestor = createAttestor({ baseUrl: NEAR_AI_BASE_URL, apiKey: config.apiKey.reveal() });
  const attested: RoleAttestation[] = [];
  return {
    kind: "near-ai",
    attested: () => [...attested],
    async run(task) {
      const sdk = await import("openai");
      let last: Exchange | null = null;
      const client = new sdk.default({
        apiKey: config.apiKey.reveal(),
        baseURL: NEAR_AI_BASE_URL,
        defaultHeaders: { "x-no-aliasing": "true" },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          const requestBody = typeof init?.body === "string" ? Buffer.from(init.body, "utf8") : null;
          last = { requestBody, responseBody: new Uint8Array(await response.clone().arrayBuffer()) };
          return response;
        },
      });
      const model = task.role === "consumer" ? config.consumerModel : config.providerModel;
      const record = async (completionId: string, report: ReportEvidence): Promise<CallAttestation> => {
        const exchange: Exchange = last ?? { requestBody: null, responseBody: new Uint8Array() };
        const attestation = await attestor.attest({ model, completionId, ...exchange }, report);
        attested.push({ role: task.role, attestation });
        return attestation;
      };
      return complete(client, attestor, record, model, task, config.apiKey.reveal());
    },
  };
}

async function complete<TOut>(
  client: OpenAI,
  attestor: Attestor,
  record: (completionId: string, report: ReportEvidence) => Promise<CallAttestation>,
  model: ModelId,
  task: InferenceTask<TOut>,
  apiKey: string,
): Promise<InferenceResult<TOut>> {
  const messages: Message[] = [
    { role: "system", content: task.system },
    { role: "user", content: task.input },
  ];
  const tools = task.tools.map(functionTool);
  const toolResults: { name: string; result: unknown }[] = [];
  const attestation: CallAttestation[] = [];
  try {
    // NEAR AI requires the report to be fetched before the completion it vouches for.
    const report = await attestor.preflight(model);
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = { model, messages };
      if (tools.length > 0) params.tools = tools;
      const completion = await client.chat.completions.create(params);
      attestation.push(await record(completion.id, report));
      const message = completion.choices[0]?.message;
      if (!message) return { ok: false, reason: "transport", detail: "near ai returned no message" };
      const calls = message.tool_calls ?? [];
      if (calls.length > 0) {
        messages.push({ role: "assistant", content: message.content, tool_calls: calls });
        for (const call of calls) {
          if (call.type !== "function") {
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "unsupported tool" }) });
            continue;
          }
          const found = task.tools.find((item) => item.name === call.function.name);
          let payload: unknown;
          try {
            payload = JSON.parse(call.function.arguments);
          } catch {
            payload = null;
          }
          const result = found ? invokeTool(found, payload) : { error: "unknown tool" };
          toolResults.push({ name: call.function.name, result });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
        continue;
      }
      const text = message.content ?? "";
      const value = task.parseOutput(text, toolResults);
      if (value === null) return { ok: false, reason: "unparseable-output", detail: "model output failed its check" };
      return { ok: true, value, model, attestation };
    }
    return { ok: false, reason: "unparseable-output", detail: "model did not finish" };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split(apiKey).join("[redacted]");
    return { ok: false, reason: "transport", detail: `near ai request failed: ${message}` };
  }
}

function functionTool(item: InferenceTask<unknown>["tools"][number]): OpenAI.Chat.ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: item.name,
      description: item.description,
      parameters: item.parameters,
    },
  };
}

function invokeTool(found: InferenceTask<unknown>["tools"][number], payload: unknown): unknown {
  const invoked = found.invoke(payload);
  if (!invoked.ok) return { error: invoked.error };
  return invoked.result;
}
