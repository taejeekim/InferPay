import type { ModelId } from "../domain.ts";
import type { InferenceConfig } from "../config.ts";
import { createNearAi } from "./near-ai.ts";
import { createStubInference } from "./stub.ts";

export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: { readonly [key: string]: unknown };
  invoke(
    rawArgs: unknown,
  ): { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string };
};

export function tool<TArgs, TResult>(spec: {
  readonly name: string;
  readonly description: string;
  readonly parameters: { readonly [key: string]: unknown };
  readonly parseArgs: (raw: unknown) => TArgs | null;
  readonly run: (args: TArgs) => TResult;
}): Tool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    invoke(rawArgs) {
      const args = spec.parseArgs(rawArgs);
      if (args === null) return { ok: false, error: "arguments failed to parse" };
      return { ok: true, result: spec.run(args) };
    },
  };
}

export type InferenceTask<TOut> = {
  readonly name: string;
  readonly role: "consumer" | "provider";
  readonly system: string;
  readonly input: string;
  readonly tools: readonly Tool[];
  readonly parseOutput: (
    raw: string,
    toolResults: readonly { name: string; result: unknown }[],
  ) => TOut | null;
};

export type InferenceFailure = "unparseable-output" | "transport" | "no-fixture";

export type InferenceResult<TOut> =
  | { readonly ok: true; readonly value: TOut; readonly model: ModelId }
  | { readonly ok: false; readonly reason: InferenceFailure; readonly detail: string };

export interface Inference {
  readonly kind: "near-ai" | "stub";
  run<TOut>(task: InferenceTask<TOut>): Promise<InferenceResult<TOut>>;
}

export function createInference(config: InferenceConfig): Inference {
  if (config.kind === "stub") return createStubInference(config.fixtures);
  return createNearAi(config);
}
