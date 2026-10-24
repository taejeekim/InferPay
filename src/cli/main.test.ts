import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "./main.ts";

test("an unknown --from is refused and names Kyle's bots", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  const stderr = capture(process.stderr);
  try {
    const code = await main(
      ["ask", "Does this policy cover an outpatient MRI?", "--budget", "0.10", "--from", "nope"],
      { INFERPAY_DATA_DIR: root },
    );
    assert.equal(code, 2);
    const text = stderr.text();
    assert.match(text, /Unknown bot nope\. Kyle's bots: researcher, writer, trader, analyst, clerk, scout, editor, buyer, reviewer, assistant\./);
  } finally {
    stderr.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("ask still runs when an old job file has no payFrom", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  const stdout = capture(process.stdout);
  try {
    const jobs = join(root, "jobs");
    await mkdir(jobs, { recursive: true });
    const line = JSON.stringify({
      type: "opened",
      at: "2026-10-24T08:04:51.690Z",
      order: {
        jobId: "job_01M5PF1VV9G5HSN4QWXHS8H1PW",
        providerId: "disclosure",
        question: "What was Samsung's Q3 2025 operating profit?",
        budget: {
          asset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
          symbol: "USDC",
          amount: "0.50",
        },
      },
      quote: {
        asset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
        symbol: "USDC",
        amount: "0.25",
      },
      payTo: "disclosure.mock",
    });
    await writeFile(join(jobs, "job_01M5PF1VV9G5HSN4QWXHS8H1PW.jsonl"), `${line}\n`);
    const code = await main(
      ["ask", "Does this policy cover an outpatient MRI?", "--budget", "0.10"],
      { INFERPAY_DATA_DIR: root },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /settled  0\.02 NEAR/);
    assert.match(stdout.text(), /from    researcher\.kyle\.near/);
    assert.match(stdout.text(), /to      insurance\.ban\.near/);
    assert.match(stdout.text(), /via     Intents grant/);
  } finally {
    stdout.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("ask pays the named Kyle bot", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  const stdout = capture(process.stdout);
  try {
    const code = await main(
      ["ask", "Does this policy cover an outpatient MRI?", "--budget", "0.10", "--from", "clerk"],
      { INFERPAY_DATA_DIR: root },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /settled  0\.02 NEAR/);
    assert.match(stdout.text(), /from    clerk\.kyle\.near/);
    assert.match(stdout.text(), /to      insurance\.ban\.near/);
    assert.match(stdout.text(), /via     Intents grant/);
  } finally {
    stdout.restore();
    await rm(root, { recursive: true, force: true });
  }
});

function capture(stream: NodeJS.WriteStream): { text(): string; restore(): void } {
  const chunks: string[] = [];
  const original = stream.write;
  stream.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof stream.write;
  return {
    text: () => chunks.join(""),
    restore() {
      stream.write = original;
    },
  };
}
