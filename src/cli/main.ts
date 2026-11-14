import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDecimalAmount, parseJobId, toUnits, type Price } from "../domain.ts";
import { loadConfig, type Config } from "../config.ts";
import type { AskOutcome, Progress } from "../consumer/index.ts";
import type { AccountId } from "../domain.ts";
import type { BuyerSeat } from "../roster.ts";
import { createRuntime, type Runtime } from "../runtime.ts";
import { testnetCommand } from "./testnet.ts";
import { attestLines, configErrorText, unknownJobText, failureText, hookLine, hookReportLine, jobText, localAnswerText, progressLine, providersTable, railsLine, receiptBlock, spendText, taskProgressLine, unknownBotText, usageText, walletsTable } from "./render.ts";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const command = argv[0];
    if (command === "wallets") return await walletsCommand(env);
    if (command === "providers") return await providersCommand(env);
    if (command === "ask") return await askCommand(argv.slice(1), env);
    if (command === "task") return await taskCommand(argv.slice(1), env);
    if (command === "resume") return await resumeCommand(argv.slice(1), env);
    if (command === "job") return await jobCommand(argv.slice(1), env);
    if (command === "testnet") return await testnetCommand(argv.slice(1), env);
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
  process.stdout.write(`${walletsTable(booted.config.roster, await liveBalances(booted.config))}\n`);
  return 0;
}

async function liveBalances(config: Config): Promise<ReadonlyMap<AccountId, bigint | null> | null> {
  if (config.payment.kind !== "near-testnet") return null;
  const { createNearClient } = await import("../near/client.ts");
  const client = createNearClient();
  const rows = config.roster.forest();
  const balances = await Promise.all(rows.map((row) => client.balance(row.account)));
  return new Map(rows.map((row, index) => [row.account, balances[index] ?? null]));
}

async function providersCommand(env: NodeJS.ProcessEnv): Promise<number> {
  const booted = await boot(env);
  if (!booted) return 1;
  const listings = await booted.runtime.market.listings();
  process.stdout.write(`${providersTable(listings, booted.runtime.rails.payment)}\n`);
  return 0;
}

async function askCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const order = await takeOrder("ask", argv, env);
  if (typeof order === "number") return order;
  const { booted, text, budget, buyer } = order;
  const outcome = await booted.runtime.consumer.ask(text, { budget, buyer }, printProgress(booted.runtime));
  const code = finishAsk(outcome);
  printBuyerAttestation(booted.runtime);
  return code;
}

async function taskCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const order = await takeOrder("task", argv, env);
  if (typeof order === "number") return order;
  const { booted, text, budget, buyer } = order;
  const rail = booted.runtime.rails.payment;
  const outcome = await booted.runtime.consumer.task(text, { budget, buyer }, (progress) => {
    process.stdout.write(`${taskProgressLine(progress, rail)}\n`);
  });
  if (outcome.kind === "unplanned") {
    process.stderr.write(`${failureText({ kind: "inference", detail: outcome.detail })}\n`);
    return 1;
  }
  const { receipt } = outcome;
  const dir = join(booted.config.dataDir, "tasks");
  await mkdir(dir, { recursive: true });
  const saved = join(dir, `${receipt.taskId}.json`);
  await writeFile(saved, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`\n${receiptBlock(receipt, saved)}\n`);
  printBuyerAttestation(booted.runtime);
  return receipt.parts.some((row) => row.outcome.kind === "failed") ? 1 : 0;
}

async function takeOrder(
  command: "ask" | "task",
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number | { booted: { runtime: Runtime; config: Config }; text: string; budget: Price; buyer: BuyerSeat }> {
  const parsed = parseOrder(command, argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n${usageText()}\n`);
    return 2;
  }
  const booted = await boot(env);
  if (!booted) return 1;
  const budget = budgetPrice(booted.config, parsed.budget);
  if (!budget) {
    process.stderr.write(`--budget needs a decimal amount above zero, such as 0.10\n`);
    return 2;
  }
  const buyer = parsed.from === null ? booted.config.roster.defaultBuyer : booted.config.roster.buyer(parsed.from);
  if (buyer === null) {
    process.stderr.write(`${unknownBotText(booted.config.roster, parsed.from ?? "")}\n${usageText()}\n`);
    return 2;
  }
  return { booted, text: parsed.text, budget, buyer };
}

function printBuyerAttestation(runtime: Runtime): void {
  const buyerCalls = runtime.attested().filter((item) => item.role === "consumer").map((item) => item.attestation);
  for (const row of attestLines("buyer", buyerCalls)) process.stdout.write(`${row}\n`);
}

async function resumeCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv.includes("--from")) {
    process.stderr.write(`resume does not take --from\n${usageText()}\n`);
    return 2;
  }
  const jobId = parseJobId(argv[0] ?? "");
  if (!jobId) {
    process.stderr.write(`${argv[0] === undefined ? "resume needs a job id" : unknownJobText(argv[0])}\n${usageText()}\n`);
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
    process.stderr.write(`${argv[0] === undefined ? "job needs a job id" : unknownJobText(argv[0])}\n${usageText()}\n`);
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
  if (outcome.kind === "local") process.stdout.write(`${localAnswerText(outcome.text)}\n`);
  if (outcome.spend !== null) process.stdout.write(`${spendText(outcome.spend)}\n`);
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
  const runtime = await createRuntime(config.value, undefined, (report) => process.stdout.write(`${hookReportLine(report)}\n`));
  process.stdout.write(`${railsLine(runtime.rails)}\n`);
  if (config.value.hook !== null) process.stdout.write(`${hookLine(config.value.hook)}\n`);
  return { runtime, config: config.value };
}

function parseOrder(command: "ask" | "task", argv: readonly string[]):
  | { readonly text: string; readonly budget: string; readonly from: string | null }
  | { readonly error: string } {
  const noun = command === "ask" ? "question" : "task";
  const words: string[] = [];
  let budget: string | null = null;
  let from: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--budget" || token === "--from") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: token === "--budget" ? `${command} needs a budget amount` : `${command} needs a bot name` };
      }
      if (token === "--budget") {
        if (budget !== null) return { error: `${command} takes --budget once` };
        budget = value;
      } else {
        if (from !== null) return { error: `${command} takes --from once` };
        from = value;
      }
      index += 1;
      continue;
    }
    words.push(token);
  }
  if (budget === null) return { error: `${command} needs a ${noun} and --budget` };
  const text = words.join(" ").trim();
  if (text.length === 0) return { error: `${command} needs a ${noun}` };
  return { text, budget, from };
}

function budgetPrice(config: Config, raw: string): Price | null {
  const amount = parseDecimalAmount(raw);
  if (!amount || toUnits(amount) === 0n) return null;
  return { asset: config.near.asset, symbol: config.near.symbol, amount };
}
