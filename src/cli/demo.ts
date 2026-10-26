import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAYMENT_ENV } from "../config.ts";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../bin/inferpay.js");
const FILINGS_QUESTION = "Does Samsung Electronics' Q3 2025 operating profit in the earnings release match the quarterly report?";
const CAPEX_QUESTION = "What was Samsung's Q3 2025 capex?";
const JOB_PAY = /job (job_[0-9A-HJKMNP-TV-Z]{26}), key (\S+?), correlation \S+?\) transfer (called|skipped)/;

interface TextSink {
  write(chunk: string): void;
}

interface PayLine {
  readonly jobId: string;
  readonly key: string;
  readonly transfer: "called" | "skipped";
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runDemo(
  env: NodeJS.ProcessEnv,
  out: TextSink = sink(process.stdout),
  err: TextSink = sink(process.stderr),
): Promise<number> {
  const present = PAYMENT_ENV.filter((name) => filled(env[name]));
  if (present.length > 0) {
    err.write(`inferpay demo does not spend. Unset ${present.join(", ")} and run it again. For a live receipt, run inferpay ask with all four payment variables set.\n`);
    return 2;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "inferpay-demo-"));
  const base = childEnv(env, dataDir, "none");
  try {
    out.write("This demo uses the mock rail and the stub model. It does not transfer funds.\n");
    if (filled(env.NEAR_AI_API_KEY)) {
      out.write("NEAR_AI_API_KEY is set in this shell. This demo leaves it unset.\n");
    }

    const ask = await step(out, base, ["ask", FILINGS_QUESTION, "--budget", "0.50"]);
    const paid = payLine(ask.stdout);
    if (ask.code !== 0 || paid?.transfer !== "called") return stop(err, "the filings question did not settle");
    if (!ask.stdout.includes("payment=mock") || !ask.stdout.includes("inference=stub")) return stop(err, "the demo left the mock rail");
    if (!ask.stdout.includes("mismatch") || !ask.stdout.includes("79.0T") || !ask.stdout.includes("79.1T") || !ask.stdout.includes("-0.13%")) {
      return stop(err, "the revenue mismatch is missing");
    }
    if (!ask.stdout.includes("4/5")) return stop(err, "the filings grade is not 4/5");

    const resumed = await step(out, base, ["resume", paid.jobId]);
    const resumedPay = payLine(resumed.stdout);
    if (resumed.code !== 0 || resumedPay?.transfer !== "skipped" || resumedPay.key !== paid.key) {
      return stop(err, "resume of the settled job did not skip the same key");
    }

    const interrupted = await step(
      out,
      childEnv(env, dataDir, "uncertain-once"),
      ["ask", CAPEX_QUESTION, "--budget", "0.50"],
      "INFERPAY_MOCK_CHAOS=uncertain-once ",
    );
    const pending = payLine(interrupted.stdout);
    if (interrupted.code !== 0 || pending?.transfer !== "called" || !interrupted.stdout.includes("uncertain")) {
      return stop(err, "the interrupted payment did not stop before settlement");
    }

    const settled = await step(out, base, ["resume", pending.jobId]);
    const settledPay = payLine(settled.stdout);
    if (settled.code !== 0 || settledPay?.transfer !== "called" || settledPay.key !== pending.key || !settled.stdout.includes("5/5")) {
      return stop(err, "resume did not settle the interrupted payment once");
    }

    const skipped = await step(out, base, ["resume", pending.jobId]);
    const skippedPay = payLine(skipped.stdout);
    if (skipped.code !== 0 || skippedPay?.transfer !== "skipped" || skippedPay.key !== pending.key) {
      return stop(err, "a second resume of the interrupted payment called the rail");
    }

    const declined = await step(out, base, ["ask", "Summarize the Q3 filing", "--budget", "0.10"]);
    if (declined.code !== 0 || !declined.stdout.includes("declined") || !declined.stdout.includes("0.25 USDC") || !declined.stdout.includes("0.10 USDC")) {
      return stop(err, "a budget under the price did not decline");
    }

    const listed = await step(out, base, ["providers"]);
    if (listed.code !== 0 || !listed.stdout.includes("4.5 (2)")) return stop(err, "the provider listing did not keep both rated jobs");

    out.write([
      judge("revenue Q3 2025 is a mismatch, 79.0T against 79.1T, -0.13%"),
      judge("the settled job resumed with the same key and transfer skipped"),
      judge("the interrupted payment settled once, then the next resume skipped"),
      judge("budget 0.10 declined and the provider has 2 rated jobs"),
      judge("rails stayed payment=mock inference=stub"),
      "",
    ].join("\n"));
    return 0;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function childEnv(env: NodeJS.ProcessEnv, dataDir: string, chaos: "none" | "uncertain-once"): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, INFERPAY_DATA_DIR: dataDir };
  for (const name of PAYMENT_ENV) delete next[name];
  delete next.NEAR_AI_API_KEY;
  if (chaos === "none") delete next.INFERPAY_MOCK_CHAOS;
  else next.INFERPAY_MOCK_CHAOS = chaos;
  return next;
}

async function step(out: TextSink, env: NodeJS.ProcessEnv, args: readonly string[], prefix = ""): Promise<Run> {
  out.write(`$ ${prefix}npx inferpay ${quoteArgs(args)}\n`);
  const run = await runCli(args, env);
  writeChunk(out, run.stdout);
  writeChunk(out, run.stderr);
  return run;
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
    }, 20000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function payLine(text: string): PayLine | null {
  const match = JOB_PAY.exec(text);
  const jobId = match?.[1];
  const key = match?.[2];
  const transfer = match?.[3];
  if (!jobId || !key || (transfer !== "called" && transfer !== "skipped")) return null;
  return { jobId, key, transfer };
}

function quoteArgs(args: readonly string[]): string {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
}

function judge(text: string): string {
  return `judge     ${text}`;
}

function stop(err: TextSink, reason: string): number {
  err.write(`${reason}\n`);
  return 1;
}

function writeChunk(out: TextSink, chunk: string): void {
  if (chunk.length === 0) return;
  out.write(chunk.endsWith("\n") ? chunk : `${chunk}\n`);
}

function sink(stream: NodeJS.WritableStream): TextSink {
  return {
    write(chunk) {
      stream.write(chunk);
    },
  };
}

function filled(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
