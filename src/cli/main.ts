import { parseDecimalAmount, parseJobId, type Price } from "../domain.ts";
import { loadConfig, type Config } from "../config.ts";
import type { AskOutcome, Progress } from "../consumer/index.ts";
import { createRuntime, type Runtime } from "../runtime.ts";
import { runDemo } from "./demo.ts";
import { configErrorText, failureText, jobText, progressLine, providersTable, railsLine, usageText } from "./render.ts";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const command = argv[0];
    if (command === "demo") return runDemo(env);
    if (command === "providers") return await providersCommand(env);
    if (command === "ask") return await askCommand(argv.slice(1), env);
    if (command === "resume") return await resumeCommand(argv.slice(1), env);
    if (command === "job") return await jobCommand(argv.slice(1), env);
    process.stderr.write(`${usageText()}\n`);
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : "inferpay failed";
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

async function providersCommand(env: NodeJS.ProcessEnv): Promise<number> {
  const booted = await boot(env);
  if (!booted) return 1;
  const listings = await booted.runtime.market.listings();
  process.stdout.write(`${providersTable(listings)}\n`);
  return 0;
}

async function askCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parseAsk(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n${usageText()}\n`);
    return 2;
  }
  const booted = await boot(env);
  if (!booted) return 1;
  const budget = budgetPrice(booted.config, parsed.budget);
  if (!budget) {
    process.stderr.write(`--budget needs a decimal amount such as 0.50\n`);
    return 2;
  }
  const outcome = await booted.runtime.consumer.ask(parsed.question, { budget }, printProgress);
  return finishAsk(outcome);
}

async function resumeCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const jobId = parseJobId(argv[0] ?? "");
  if (!jobId) {
    process.stderr.write(`resume needs a job id\n${usageText()}\n`);
    return 2;
  }
  const booted = await boot(env);
  if (!booted) return 1;
  const outcome = await booted.runtime.consumer.resume(jobId, printProgress);
  return finishAsk(outcome);
}

async function jobCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const jobId = parseJobId(argv[0] ?? "");
  if (!jobId) {
    process.stderr.write(`job needs a job id\n${usageText()}\n`);
    return 2;
  }
  const booted = await boot(env);
  if (!booted) return 1;
  const view = await booted.runtime.market.job(jobId);
  if (view === null) {
    process.stderr.write(`${failureText({ kind: "unknown-job", jobId })}\n`);
    return 1;
  }
  process.stdout.write(`${jobText(view)}\n`);
  return 0;
}

function finishAsk(outcome: AskOutcome): number {
  if (outcome.kind === "local") {
    process.stdout.write(`${outcome.text}\n`);
    return 0;
  }
  if (outcome.kind === "failed") {
    process.stderr.write(`${failureText(outcome.reason)}\n`);
    return 1;
  }
  return 0;
}

function printProgress(progress: Progress): void {
  process.stdout.write(`${progressLine(progress)}\n`);
}

async function boot(env: NodeJS.ProcessEnv): Promise<{ runtime: Runtime; config: Config } | null> {
  const config = loadConfig(env);
  if (!config.ok) {
    process.stderr.write(`${configErrorText(config.error)}\n`);
    return null;
  }
  const runtime = await createRuntime(config.value);
  process.stdout.write(`${railsLine(runtime.rails)}\n`);
  return { runtime, config: config.value };
}

function parseAsk(argv: readonly string[]): { question: string; budget: string } | { error: string } {
  const flag = argv.indexOf("--budget");
  if (flag <= 0) return { error: "ask needs a question and --budget" };
  const amount = argv[flag + 1];
  if (amount === undefined || amount.startsWith("--")) return { error: "ask needs a budget amount" };
  const question = argv.slice(0, flag).join(" ").trim();
  if (question.length === 0) return { error: "ask needs a question" };
  return { question, budget: amount };
}

function budgetPrice(config: Config, raw: string): Price | null {
  const amount = parseDecimalAmount(raw);
  const priced = config.pricing.values().next().value;
  if (!amount || priced === undefined) return null;
  return { asset: priced.price.asset, symbol: priced.price.symbol, amount };
}
