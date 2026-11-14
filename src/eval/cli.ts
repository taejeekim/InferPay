import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli/main.ts";
import { LOCAL_FLOOR } from "../consumer/index.ts";
import { parseDecimalAmount, toUnits } from "../domain.ts";

export type Option = {
  readonly shop: string;
  readonly ask: bigint;
  readonly affordable: boolean;
  readonly cover: number;
  readonly rep: number;
  readonly quality: number;
  readonly net: string;
};

export type Outcome = "bought" | "local" | "declined";

export type Run = {
  readonly outcome: Outcome;
  readonly budget: bigint;
  readonly options: readonly Option[];
  readonly localConfident: boolean;
  readonly countered: boolean;
  readonly shop: string | null;
  readonly spent: bigint;
  // What the buyer printed for each check, and how many it marked FORGED.
  readonly buyerChecks: readonly { readonly status: string; readonly verdict: string }[];
  readonly forged: number;
  // What the shop asserted and the rating the buyer gave, read back from the job ledger.
  readonly assertedVerdicts: readonly string[];
  readonly rating: number | null;
};

type LedgerEvent = {
  readonly type: string;
  readonly order?: { readonly providerId: string };
  readonly receipt?: { readonly amount: { readonly amount: string } };
  readonly answer?: { readonly checks: readonly { readonly verdict: string }[] };
  readonly rating?: number;
};

let cliRuns = 0;
export const cliRunCount = (): number => cliRuns;

// The env object is built here and never from process.env, so a developer's .env cannot change the rails.
export async function runCli(argv: readonly string[], opts: { readonly dataDir: string; readonly liar?: string }): Promise<{ code: number; out: string; err: string }> {
  cliRuns += 1;
  const env: NodeJS.ProcessEnv = { INFERPAY_DATA_DIR: opts.dataDir, ...(opts.liar === undefined ? {} : { INFERPAY_TEST_LIAR: opts.liar }) };
  const chunks = { out: [] as string[], err: [] as string[] };
  const original = { out: process.stdout.write, err: process.stderr.write };
  const grab = (into: string[]) => ((chunk: string | Uint8Array) => {
    into.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = grab(chunks.out);
  process.stderr.write = grab(chunks.err);
  try {
    const code = await main(argv, env);
    return { code, out: chunks.out.join(""), err: chunks.err.join("") };
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
}

export async function withFreshDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "inferpay-eval-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The stub names its recorded questions when it refuses an unrecorded one, so the list is never copied here.
export async function recordedQuestions(): Promise<string[]> {
  const { err } = await withFreshDir((dir) => runCli(["ask", "eval probe: an unrecorded question", "--budget", "0.10"], { dataDir: dir }));
  const found = [...err.matchAll(/^ {2}npx inferpay ask "(.*)" --budget 0\.10$/gm)].map((match) => match[1] ?? "");
  if (found.length === 0) throw new Error("the stub listed no recorded questions");
  return found;
}

export async function ask(question: string, budget: string, opts: { readonly dataDir: string; readonly liar?: string }): Promise<Run> {
  const { out } = await runCli(["ask", question, "--budget", budget], opts);
  if (!/^decide /m.test(out)) throw new Error(`ask produced no decision for "${question}" at ${budget}:\n${out}`);
  const budgetUnits = units(budget);
  const options = [...out.matchAll(/^ {10}option {2}(\S+)\s+ask ([\d.]+)\s+(?:cover ([\d.]+) x rep ([\d.]+) = quality ([\d.]+)\s+net ([+-][\d.]+)|outside)/gm)].map((match): Option => ({
    shop: match[1] ?? "",
    ask: units(match[2] ?? ""),
    affordable: match[3] !== undefined,
    cover: Number(match[3] ?? 0),
    rep: Number(match[4] ?? 0),
    quality: Number(match[5] ?? 0),
    net: match[6] ?? "",
  }));
  const confidence = Number(out.match(/^ {10}local {3}confidence ([\d.]+)/m)?.[1] ?? "NaN");
  const jobId = out.match(/^ {10}job {5}(job_\w+)$/m)?.[1];
  const buyerChecks = [...out.matchAll(/^ {10}(verified|unrequested|WITHHELD|unproven|FORGED) +(.{14})/gm)].map((match) => ({ status: match[1] ?? "", verdict: (match[2] ?? "").trim() }));
  const forged = Number(out.match(/^checks .* (\d+) FORGED$/m)?.[1] ?? 0);
  const countered = /^decide {4}buy from \S+ at [\d.]+ NEAR \(counter-offer accepted\)$/m.test(out);
  if (jobId === undefined) {
    const local = /^decide {4}answer locally/m.test(out);
    return { outcome: local ? "local" : "declined", budget: budgetUnits, options, localConfident: Math.round(confidence * 100) >= LOCAL_FLOOR, countered, shop: null, spent: 0n, buyerChecks, forged, assertedVerdicts: [], rating: null };
  }
  const events = (await readFile(join(opts.dataDir, "jobs", `${jobId}.jsonl`), "utf8")).trim().split("\n").map((row) => JSON.parse(row) as LedgerEvent);
  const find = (type: string) => events.find((event) => event.type === type);
  return {
    outcome: "bought",
    budget: budgetUnits,
    options,
    localConfident: Math.round(confidence * 100) >= LOCAL_FLOOR,
    countered,
    shop: String(find("opened")?.order?.providerId),
    spent: units(String(find("payment-settled")?.receipt?.amount.amount)),
    buyerChecks,
    forged,
    assertedVerdicts: (find("fulfilled")?.answer?.checks ?? []).map((check) => check.verdict),
    rating: find("rated")?.rating ?? null,
  };
}

export function units(decimal: string): bigint {
  const amount = parseDecimalAmount(decimal);
  if (amount === null) throw new Error(`not a decimal amount: ${decimal}`);
  return toUnits(amount);
}

export const supports = (run: Run): boolean => run.buyerChecks.some((check) => check.status === "verified" && ["match", "raised", "clear"].includes(check.verdict));
