import { z } from "zod";
import type { ProviderId } from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import type { Listing } from "../market/index.ts";
import { percentOf, type Percent, type SelfAssessment } from "./decide.ts";

type Shop = Pick<Listing, "id" | "routingHint">;

const assessmentSchema = z.object({
  answer: z.string().trim().min(1),
  confidence: z.number(),
  missing: z.array(z.string()).default([]),
  coverage: z.record(z.string(), z.number()).default({}),
});

export async function assess(
  inference: Inference,
  question: string,
  shops: readonly Shop[],
): Promise<{ readonly ok: true; readonly assessment: SelfAssessment } | { readonly ok: false; readonly detail: string }> {
  const result = await inference.run({
    name: "consumer.assess",
    role: "consumer",
    system: assessSystem(shops),
    input: question,
    tools: [],
    parseOutput: (raw) => parseAssessment(raw, shops),
  });
  if (!result.ok) return { ok: false, detail: result.detail };
  return { ok: true, assessment: result.value };
}

function parseAssessment(raw: string, shops: readonly Shop[]): SelfAssessment | null {
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open === -1 || close < open) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(open, close + 1));
  } catch {
    return null;
  }
  const parsed = assessmentSchema.safeParse(data);
  if (!parsed.success) return null;
  const confidence = percentOf(parsed.data.confidence);
  if (confidence === null) return null;
  const coverage = new Map<ProviderId, Percent>();
  for (const shop of shops) {
    const share = parsed.data.coverage[shop.id];
    if (share === undefined) continue;
    const covered = percentOf(share);
    if (covered === null) return null;
    coverage.set(shop.id, covered);
  }
  const missing = parsed.data.missing.map((fact) => fact.trim()).filter((fact) => fact.length > 0);
  return { answer: parsed.data.answer, confidence, missing, coverage };
}

function assessSystem(shops: readonly Shop[]): string {
  return [
    "You are a buyer agent. Before any money moves, assess how well you can answer the question on your own.",
    "Reply with one JSON object and no other text:",
    '{"answer":"...","confidence":0.0,"missing":["..."],"coverage":{"shop-id":0.0}}',
    "answer: your best answer from what you know now, in one or two sentences.",
    "confidence: the probability from 0 to 1 that your answer is right. When the answer depends on a private document you cannot see, you are guessing, so keep it low.",
    "missing: the facts you would need but cannot know without private data. Use [] when you need none.",
    "coverage: for each shop below, the share from 0 to 1 of the missing facts that its private data covers. Use 0 when a shop does not help or when nothing is missing.",
    "Shops:",
    ...shops.map((shop) => `${shop.id} | ${shop.routingHint}`),
  ].join("\n");
}
