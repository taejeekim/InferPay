import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
    assert.match(stdout.text(), /from    researcher\.kyle\.inferpay\.testnet/);
    assert.match(stdout.text(), /to      insurance\.ban\.inferpay\.testnet/);
    assert.match(stdout.text(), /via     mock receipt \(no NEAR moved\)/);
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
    assert.match(stdout.text(), /from    clerk\.kyle\.inferpay\.testnet/);
    assert.match(stdout.text(), /to      insurance\.ban\.inferpay\.testnet/);
    assert.match(stdout.text(), /via     mock receipt \(no NEAR moved\)/);
    assert.match(stdout.text(), /^ {10}job {5}job_[0-9A-Z]{26}$/m);
  } finally {
    stdout.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("an uncertain payment prints its job id and the retry-key note once, and resume settles it", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  const first = capture(process.stdout);
  let jobId: string | undefined;
  try {
    const code = await main(
      ["ask", "What was Samsung's Q3 2025 operating profit?", "--budget", "0.50"],
      { INFERPAY_DATA_DIR: root, INFERPAY_MOCK_CHAOS: "uncertain-once" },
    );
    assert.equal(code, 0);
    const text = first.text();
    assert.match(text, /uncertain {2}0\.02 NEAR/);
    assert.equal(text.match(/^ {10}job {5}job_/gm)?.length, 1);
    assert.match(text, /same key, so this transfer cannot be paid twice/);
    jobId = text.match(/^ {10}job {5}(job_\w+)$/m)?.[1];
  } finally {
    first.restore();
  }
  const second = capture(process.stdout);
  try {
    assert.ok(jobId);
    const code = await main(["resume", jobId], { INFERPAY_DATA_DIR: root, INFERPAY_MOCK_CHAOS: "uncertain-once" });
    assert.equal(code, 0);
    assert.match(second.text(), /settled {2}0\.02 NEAR/);
  } finally {
    second.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("off-script questions fail before any payment or job file", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    for (const question of ["Schedule a meeting on Monday", "Is Apple revenue up?", "What is the capital of Peru?"]) {
      const stdout = capture(process.stdout);
      const stderr = capture(process.stderr);
      let code: number;
      try {
        code = await main(["ask", question, "--budget", "0.10"], { INFERPAY_DATA_DIR: root });
      } finally {
        stdout.restore();
        stderr.restore();
      }
      assert.equal(code, 1, question);
      assert.doesNotMatch(stdout.text(), /settled/, question);
      assert.match(stderr.text(), /No NEAR moved/, question);
    }
    const written = await readdir(join(root, "jobs")).catch(() => []);
    assert.deepEqual(written, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the cosmetic surgery question routes to insurance and finds the exclusion", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  const stdout = capture(process.stdout);
  try {
    const code = await main(
      ["ask", "does this policy cover cosmetic surgery", "--budget", "0.10"],
      { INFERPAY_DATA_DIR: root },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /to      insurance\.ban\./);
    assert.match(stdout.text(), /excluded/);
  } finally {
    stdout.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("each recorded purchase at a 0.10 budget pays the covering shop its list price", async () => {
  const purchases: readonly (readonly [string, string, string])[] = [
    ["What was Samsung's Q3 2025 operating profit?", "disclosure", "0.02"],
    ["Does Samsung Electronics' Q3 2025 operating profit in the earnings release match the quarterly report?", "disclosure", "0.02"],
    ["What was Samsung's Q3 2025 capex?", "disclosure", "0.02"],
    ["Does this NDA's unlimited indemnification clause fail our playbook?", "legal", "0.03"],
    ["Does this policy cover an outpatient MRI?", "insurance", "0.02"],
    ["Does this policy cover cosmetic surgery?", "insurance", "0.02"],
  ];
  for (const [question, shop, price] of purchases) {
    await withDataDir(async (root) => {
      const { code, out } = await ask(root, question, "0.10");
      assert.equal(code, 0, question);
      assert.ok(out.includes(`decide    buy from ${shop} at ${price} NEAR (list price)`), question);
      assert.ok(out.includes(`pay       settled  ${price} NEAR`), question);
      assert.match(out, new RegExp(`^ {10}to {6}${shop}\\.`, "m"), question);
      assert.equal((await jobFiles(root)).length, 1, question);
    });
  }
});

test("the decide block shows the arithmetic behind a purchase", async () => {
  await withDataDir(async (root) => {
    const { out } = await ask(root, "Does this policy cover an outpatient MRI?", "0.10");
    for (const row of [
      "          value   0.10 NEAR, the budget: the most a right answer is worth",
      "          local   confidence 0.20 x value = worth 0.020 NEAR",
      "          missing this policy's schedule of covered procedures",
      "          option  insurance   ask 0.02  cover 1.00 x rep 0.70 = quality 0.70  net +0.050",
      "          option  legal       ask 0.03  cover 0.00 x rep 0.70 = quality 0.00  net -0.030",
      "          rule    net = quality x value - ask; buy when net >= local worth: 0.050 >= 0.020",
    ]) {
      assert.ok(out.includes(`${row}\n`), row);
    }
  });
});

test("a question the buyer can answer is answered locally with no payment and no job file", async () => {
  await withDataDir(async (root) => {
    const { code, out } = await ask(root, "What is the capital of France?", "0.10");
    assert.equal(code, 0);
    assert.match(out, /^decide {4}answer locally, pay nothing$/m);
    assert.match(out, /answer locally when confidence >= 0\.50: 0\.99 >= 0\.50$/m);
    assert.match(out, /^answer {4}Paris is the capital of France\.$/m);
    assert.doesNotMatch(out, /^pay /m);
    assert.deepEqual(await jobFiles(root), []);
  });
});

test("an accepted counter-offer pays the agreed price in the pay block, the ledger, and the receipt", async () => {
  await withDataDir(async (root) => {
    const { code, out } = await ask(root, "Does this policy cover an outpatient MRI?", "0.03");
    assert.equal(code, 0);
    assert.match(out, /^decide {4}buy from insurance at 0\.015 NEAR \(counter-offer accepted\)$/m);
    assert.match(out, /^ {10}reserve \(0\.70 - 0\.20\) x 0\.03 = 0\.015 NEAR/m);
    assert.match(out, /^ {10}counter 0\.015 NEAR against the ask of 0\.02 NEAR$/m);
    assert.match(out, /^ {10}reply {3}insurance accepted$/m);
    assert.match(out, /^pay {7}settled {2}0\.015 NEAR$/m);
    const [file] = await jobFiles(root);
    assert.ok(file);
    const events = (await readFile(join(root, "jobs", file), "utf8")).trim().split("\n").map((row) => JSON.parse(row));
    assert.equal(events.find((event) => event.type === "opened")?.quote.amount, "0.015");
    assert.equal(events.find((event) => event.type === "payment-settled")?.receipt.amount.amount, "0.015");
    const stdout = capture(process.stdout);
    try {
      assert.equal(await main(["job", file.replace(".jsonl", "")], { INFERPAY_DATA_DIR: root }), 0);
      assert.match(stdout.text(), /^opened .* quote 0\.015 NEAR {2}budget 0\.03 NEAR/m);
    } finally {
      stdout.restore();
    }
  });
});

test("a refused counter-offer pays nothing: an unsure buyer declines and a fairly sure buyer answers", async () => {
  await withDataDir(async (root) => {
    const { code, out } = await ask(root, "Does this policy cover an outpatient MRI?", "0.02");
    assert.equal(code, 0);
    assert.match(out, /^decide {4}decline, pay nothing \(counter-offer refused\)$/m);
    assert.match(out, /^ {10}counter 0\.01 NEAR against the ask of 0\.02 NEAR$/m);
    assert.match(out, /^ {10}reply {3}insurance refused, so the buyer walks away$/m);
    assert.match(out, /answer locally when confidence >= 0\.50: 0\.20 < 0\.50, so decline$/m);
    assert.doesNotMatch(out, /^(pay|answer) /m);
    assert.deepEqual(await jobFiles(root), []);
  });
  await withDataDir(async (root) => {
    const { code, out } = await ask(root, "What was Samsung's Q3 2025 revenue?", "0.10");
    assert.equal(code, 0);
    assert.match(out, /^decide {4}answer locally, pay nothing \(counter-offer refused\)$/m);
    assert.match(out, /^ {10}reply {3}disclosure refused, so the buyer walks away$/m);
    assert.match(out, /^answer {4}Samsung reported about KRW 86 trillion/m);
    assert.doesNotMatch(out, /^pay /m);
    assert.deepEqual(await jobFiles(root), []);
  });
});

test("a budget below every ask declines with no payment and no job file", async () => {
  await withDataDir(async (root) => {
    const { code, out } = await ask(root, "What was Samsung's Q3 2025 operating profit?", "0.01");
    assert.equal(code, 0);
    assert.match(out, /^decide {4}decline, pay nothing$/m);
    assert.match(out, /never pay above the budget: every ask is outside 0\.01 NEAR$/m);
    assert.doesNotMatch(out, /^(pay|answer) /m);
    assert.deepEqual(await jobFiles(root), []);
  });
});

test("a budget that is not a decimal amount above zero is refused before any decision", async () => {
  await withDataDir(async (root) => {
    for (const budget of ["0", "0.000", "-1", "Infinity", "NaN", "1e3", "ten"]) {
      const { code, out, err } = await ask(root, "Does this policy cover an outpatient MRI?", budget);
      assert.equal(code, 2, budget);
      assert.match(err, /--budget needs a decimal amount above zero/, budget);
      assert.doesNotMatch(out, /^decide /m, budget);
    }
    assert.deepEqual(await jobFiles(root), []);
  });
});

test("a shop's net rises after a good rating and falls after a poor one", async () => {
  await withDataDir(async (root) => {
    const first = await ask(root, "Does this policy cover an outpatient MRI?", "0.10");
    assert.match(first.out, /insurance {3}ask 0\.02 {2}cover 1\.00 x rep 0\.70 = quality 0\.70 {2}net \+0\.050$/m);
    assert.match(first.out, /^rate {6}5\/5$/m);
    const second = await ask(root, "Does this policy cover an outpatient MRI?", "0.10");
    assert.match(second.out, /insurance {3}ask 0\.02 {2}cover 1\.00 x rep 0\.80 = quality 0\.80 {2}net \+0\.060$/m);
  });
  await withDataDir(async (root) => {
    const first = await ask(root, "What was Samsung's Q3 2025 capex?", "0.10");
    assert.match(first.out, /disclosure {2}ask 0\.02 {2}cover 0\.80 x rep 0\.70 = quality 0\.56 {2}net \+0\.036$/m);
    assert.match(first.out, /^rate {6}3\/5 {2}\(1 claim the shop could not back; nothing verified, so at most 3\)$/m);
    const second = await ask(root, "What was Samsung's Q3 2025 capex?", "0.10");
    assert.match(second.out, /disclosure {2}ask 0\.02 {2}cover 0\.80 x rep 0\.63 = quality 0\.50 {2}net \+0\.030$/m);
  });
});

test("on the mock rail the buyer verifies each check against the listed root, and job prints the full proof", async () => {
  await withDataDir(async (root) => {
    const asked = await ask(root, "What was Samsung's Q3 2025 operating profit?", "0.10");
    assert.equal(asked.code, 0);
    assert.match(asked.out, /^checks {4}2 of 2 verified by the buyer against the shop's committed root$/m);
    assert.match(asked.out, /^ {10}verified {2}match {9}operating profit Q3 2025 {2}12\.2T KRW$/m);
    assert.match(asked.out, /^ {10}verified {2}mismatch {6}revenue Q3 2025 {11}86\.0T KRW {3}ref 86\.1T KRW \(-0\.12%\)$/m);
    assert.match(asked.out, /^ {10}from {6}the shop's listing, because the mock rail has no chain$/m);
    assert.match(asked.out, /^rate {6}4\/5 {2}\(1 mismatch among 2 verified checks\)$/m);
    const short = asked.out.match(/^ {10}root {6}([0-9a-f]{12})…([0-9a-f]{4}) {2}2 leaves/m);
    assert.ok(short);
    const jobId = asked.out.match(/^ {10}job {5}(job_\w+)$/m)?.[1];
    assert.ok(jobId);
    const stdout = capture(process.stdout);
    try {
      assert.equal(await main(["job", jobId], { INFERPAY_DATA_DIR: root }), 0);
      const full = stdout.text().match(/commitment ([0-9a-f]{64})$/m)?.[1];
      assert.ok(full);
      assert.ok(full.startsWith(short[1] ?? "x") && full.endsWith(short[2] ?? "x"));
      assert.match(stdout.text(), /^ {20}salt {6}[0-9a-f]{64}$/m);
      assert.match(stdout.text(), /^ {20}leaf {6}[0-9a-f]{64}$/m);
    } finally {
      stdout.restore();
    }
  });
});

async function withDataDir(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function ask(root: string, question: string, budget: string): Promise<{ code: number; out: string; err: string }> {
  const stdout = capture(process.stdout);
  const stderr = capture(process.stderr);
  try {
    const code = await main(["ask", question, "--budget", budget], { INFERPAY_DATA_DIR: root });
    return { code, out: stdout.text(), err: stderr.text() };
  } finally {
    stdout.restore();
    stderr.restore();
  }
}

async function jobFiles(root: string): Promise<string[]> {
  const names = await readdir(join(root, "jobs")).catch(() => []);
  return names.filter((name) => name.endsWith(".jsonl"));
}

test("the stub rail prints no attest line", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  const stdout = capture(process.stdout);
  try {
    const code = await main(["ask", "Does this policy cover an outpatient MRI?", "--budget", "0.10"], { INFERPAY_DATA_DIR: root });
    assert.equal(code, 0);
    assert.match(stdout.text(), /inference=stub/);
    assert.doesNotMatch(stdout.text(), /attest/);
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
