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

export function createStubInference(fixtures: string): Inference {
  return {
    kind: "stub",
    async run(task) {
      const hash = createHash("sha256").update(task.input).digest("hex");
      const path = join(fixtures, task.name, `${hash}.json`);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        return { ok: false, reason: "no-fixture", detail: `${task.name} has no fixture for this question` };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
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
