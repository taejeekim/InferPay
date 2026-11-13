import { parseDecimalAmount, parseJobId, type Price } from "../domain.ts";
import { loadConfig, type Config } from "../config.ts";
import type { AskOutcome, Progress } from "../consumer/index.ts";
import { createRuntime, type Runtime } from "../runtime.ts";
import { configErrorText, failureText, jobText, localAnswerText, progressLine, providersTable, railsLine, unknownBotText, usageText, walletsTable } from "./render.ts";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const command = argv[0];
    if (command === "wallets") return await walletsCommand(env);
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

async function walletsCommand(env: NodeJS.ProcessEnv): Promise<number> {
  const booted = await boot(env);
  if (!booted) return 1;
  process.stdout.write(`${walletsTable(booted.config.roster)}\n`);
  return 0;
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
    process.stderr.write(`--budget needs a decimal amount such as 0.10\n`);
    return 2;
  }
  const buyer = parsed.from === null ? booted.config.roster.defaultBuyer : booted.config.roster.buyer(parsed.from);
  if (buyer === null) {
    process.stderr.write(`${unknownBotText(booted.config.roster, parsed.from ?? "")}\n${usageText()}\n`);
    return 2;
  }
  const outcome = await booted.runtime.consumer.ask(parsed.question, { budget, buyer }, printProgress(booted.runtime));
  return finishAsk(outcome);
}

async function resumeCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv.includes("--from")) {
    process.stderr.write(`resume does not take --from\n${usageText()}\n`);
    return 2;
  }
  const jobId = parseJobId(argv[0] ?? "");
  if (!jobId) {
    process.stderr.write(`resume needs a job id\n${usageText()}\n`);
    return 2;
  }
  const booted = await boot(env);
  if (!booted) return 1;
  const outcome = await booted.runtime.consumer.resume(jobId, printProgress(booted.runtime));
  return finishAsk(outcome);
}

async function jobCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv.includes("--from")) {
    process.stderr.write(`job does not take --from\n${usageText()}\n`);
    return 2;
  }
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
    process.stdout.write(`${localAnswerText(outcome.text)}\n`);
    return 0;
  }
  if (outcome.kind === "failed") {
    process.stderr.write(`${failureText(outcome.reason)}\n`);
    return 1;
  }
  return 0;
}

function printProgress(runtime: Runtime): (progress: Progress) => void {
  return (progress) => process.stdout.write(`${progressLine(progress, runtime.rails.payment)}\n`);
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

function parseAsk(argv: readonly string[]):
  | { readonly question: string; readonly budget: string; readonly from: string | null }
  | { readonly error: string } {
  const words: string[] = [];
  let budget: string | null = null;
  let from: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--budget" || token === "--from") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: token === "--budget" ? "ask needs a budget amount" : "ask needs a bot name" };
      }
      if (token === "--budget") {
        if (budget !== null) return { error: "ask takes --budget once" };
        budget = value;
      } else {
        if (from !== null) return { error: "ask takes --from once" };
        from = value;
      }
      index += 1;
      continue;
    }
    words.push(token);
  }
  if (budget === null) return { error: "ask needs a question and --budget" };
  const question = words.join(" ").trim();
  if (question.length === 0) return { error: "ask needs a question" };
  return { question, budget, from };
}

function budgetPrice(config: Config, raw: string): Price | null {
  const amount = parseDecimalAmount(raw);
  if (!amount) return null;
  return { asset: config.near.asset, symbol: config.near.symbol, amount };
}
