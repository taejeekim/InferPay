import type OpenAI from "openai";
import type { ModelId } from "../domain.ts";
import type { InferenceConfig } from "../config.ts";
import type { Inference, InferenceResult, InferenceTask } from "./index.ts";

const NEAR_AI_BASE_URL = "https://cloud-api.near.ai/v1";
const MAX_ROUNDS = 4;

type Message = OpenAI.Chat.ChatCompletionMessageParam;

export function createNearAi(config: Extract<InferenceConfig, { kind: "near-ai" }>): Inference {
  return {
    kind: "near-ai",
    async run(task) {
      const sdk = await import("openai");
      const client = new sdk.default({ apiKey: config.apiKey.reveal(), baseURL: NEAR_AI_BASE_URL });
      const model = task.role === "consumer" ? config.consumerModel : config.providerModel;
      return complete(client, model, task);
    },
  };
}

async function complete<TOut>(
  client: OpenAI,
  model: ModelId,
  task: InferenceTask<TOut>,
): Promise<InferenceResult<TOut>> {
  const messages: Message[] = [
    { role: "system", content: task.system },
    { role: "user", content: task.input },
  ];
  const tools = task.tools.map(functionTool);
  const toolResults: { name: string; result: unknown }[] = [];
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = { model, messages };
      if (tools.length > 0) params.tools = tools;
      const completion = await client.chat.completions.create(params);
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
      return { ok: true, value, model };
    }
    return { ok: false, reason: "unparseable-output", detail: "model did not finish" };
  } catch {
    return { ok: false, reason: "transport", detail: "near ai request failed" };
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
