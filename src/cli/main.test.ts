import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Receipt } from "../consumer/task.ts";
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
    assert.match(text, /^ {10}note {4}resume rebroadcasts the same signed transaction, so this transfer cannot be paid twice;$/m);
    assert.match(text, /^ {18}it settles once that transaction is found on chain, or is signed again once it has expired$/m);
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

test("job and resume name an id they cannot read as unknown", async () => {
  await withDataDir(async (root) => {
    for (const command of ["job", "resume"]) {
      const stderr = capture(process.stderr);
      try {
        assert.equal(await main([command, "job_nope"], { INFERPAY_DATA_DIR: root }), 2);
        assert.match(stderr.text(), /^Unknown job job_nope\. A job id is job_ and 26 letters and digits, as ask prints on its job line\.$/m);
      } finally {
        stderr.restore();
      }
    }
  });
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
    assert.match(first.out, /^rate {6}5\/5 {2}= 5$/m);
    const second = await ask(root, "Does this policy cover an outpatient MRI?", "0.10");
    assert.match(second.out, /insurance {3}ask 0\.02 {2}cover 1\.00 x rep 0\.80 = quality 0\.80 {2}net \+0\.060$/m);
  });
  await withDataDir(async (root) => {
    const question = "What was Samsung's Q3 2025 operating profit?";
    const first = await ask(root, question, "0.10", { INFERPAY_TEST_LIAR: "disclosure" });
    assert.match(first.out, /disclosure {2}ask 0\.02 {2}cover 1\.00 x rep 0\.70 = quality 0\.70 {2}net \+0\.050$/m);
    assert.match(first.out, /^rate {6}1\/5/m);
    const second = await ask(root, question, "0.10");
    assert.match(second.out, /disclosure {2}ask 0\.02 {2}cover 1\.00 x rep 0\.47 = quality 0\.47 {2}net \+0\.027$/m);
  });
});

test("on the mock rail the buyer verifies each check against the listed root, and job prints the full proof", async () => {
  await withDataDir(async (root) => {
    const asked = await ask(root, "What was Samsung's Q3 2025 operating profit?", "0.10");
    assert.equal(asked.code, 0);
    assert.match(asked.out, /^checks {4}1 of 1 needed key opened and verified against the shop's committed root, 1 unrequested$/m);
    assert.match(asked.out, /^ {10}verified {4}match {9}operating profit Q3 2025 {2}12\.2T KRW$/m);
    assert.match(asked.out, /^ {10}unrequested mismatch {6}revenue Q3 2025 {11}86\.0T KRW {3}ref 86\.1T KRW \(-0\.12%\)$/m);
    assert.match(asked.out, /^ {22}the buyer did not ask for this key, so it counts neither for nor against the shop$/m);
    assert.match(asked.out, /^ {10}from {6}the shop's listing, because the mock rail has no chain$/m);
    assert.match(asked.out, /^rate {6}5\/5 {2}= 5$/m);
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
      assert.match(stdout.text(), /^ {18}needs {6}Samsung Electronics \/ Q3 2025 \/ operating profit$/m);
      assert.match(stdout.text(), /^fulfilled .* 2 checks; 1 of 1 needed key opened, 0 withheld$/m);
      assert.match(stdout.text(), /^ {18}unrequested {2}mismatch {2}revenue Q3 2025$/m);
      assert.match(stdout.text(), /^ {20}salt {6}[0-9a-f]{64}$/m);
      assert.match(stdout.text(), /^ {20}leaf {6}[0-9a-f]{64}$/m);
    } finally {
      stdout.restore();
    }
  });
});

test("a need outside the shop's catalog is dropped before any payment, and a raised flag is about the clause in the question", async () => {
  await withDataDir(async (root) => {
    const capex = await ask(root, "What was Samsung's Q3 2025 capex?", "0.10");
    assert.match(capex.out, /^decide {4}decline, pay nothing$/m);
    assert.match(capex.out, /^ {10}dropped disclosure {2}Samsung Electronics \/ Q3 2025 \/ capex: not in its catalog$/m);
    assert.match(capex.out, /disclosure {2}ask 0\.02 {2}cover 0\.00 x rep 0\.70/m);
    assert.deepEqual(await jobFiles(root), []);
    const legal = await ask(root, "Does this NDA's unlimited indemnification clause fail our playbook?", "0.10");
    assert.match(legal.out, /^ {10}verified {4}raised {8}indemnity$/m);
    assert.match(legal.out, /^rate {6}5\/5 {2}= 5$/m);
    for (const row of `${capex.out}${legal.out}`.split("\n")) assert.ok(row.length <= 110, row);
  });
});

test("a shop that forges its evidence is caught on the mock rail and rated 1/5", async () => {
  await withDataDir(async (root) => {
    const env = { INFERPAY_DATA_DIR: root, INFERPAY_TEST_LIAR: "disclosure" };
    const stdout = capture(process.stdout);
    try {
      assert.equal(await main(["ask", "What was Samsung's Q3 2025 operating profit?", "--budget", "0.10"], env), 0);
      const text = stdout.text();
      assert.match(text, /^hook {6}INFERPAY_TEST_LIAR=disclosure: /m);
      assert.match(text, /^checks {4}1 of 1 needed key opened and verified against the shop's committed root, 1 FORGED$/m);
      assert.match(text, /^ {10}verified {4}match {9}operating profit Q3 2025 {2}12\.2T KRW$/m);
      assert.match(text, /^ {10}FORGED {6}match {9}revenue Q3 2025 {11}86\.0T KRW$/m);
      assert.match(text, /^ {22}the shop said match, but its evidence does not open to the committed root$/m);
      assert.match(text, /^rate {6}1\/5 {2}forged evidence sets the rating to 1$/m);
      assert.doesNotMatch(text, /^ {10}\S+ +mismatch/m);
    } finally {
      stdout.restore();
    }
    const next = await ask(root, "What was Samsung's Q3 2025 operating profit?", "0.10");
    assert.match(next.out, /disclosure {2}ask 0\.02 {2}cover 1\.00 x rep 0\.47 = quality 0\.47/);
    assert.match(next.out, /^decide {4}decline, pay nothing \(counter-offer refused\)$/m);
  });
  await withDataDir(async (root) => {
    const honest = await ask(root, "What was Samsung's Q3 2025 operating profit?", "0.10");
    assert.match(honest.out, /^rate {6}5\/5 /m);
    assert.doesNotMatch(honest.out, /FORGED|^hook/m);
  });
});

test("the liar hook names a shop, and a liar with nothing to forge says so and changes nothing", async () => {
  await withDataDir(async (root) => {
    const stderr = capture(process.stderr);
    try {
      assert.equal(await main(["providers"], { INFERPAY_DATA_DIR: root, INFERPAY_TEST_LIAR: "researcher" }), 1);
      assert.match(stderr.text(), /INFERPAY_TEST_LIAR is invalid\. expected a shop id: legal, insurance, disclosure/);
      assert.equal(await main(["providers"], { INFERPAY_DATA_DIR: root, INFERPAY_TEST_LIAR: "legal", INFERPAY_TEST_WITHHOLD: "legal" }), 1);
      assert.match(stderr.text(), /set INFERPAY_TEST_LIAR or INFERPAY_TEST_WITHHOLD, not both/);
    } finally {
      stderr.restore();
    }
    const stdout = capture(process.stdout);
    try {
      const env = { INFERPAY_DATA_DIR: root, INFERPAY_TEST_LIAR: "insurance" };
      assert.equal(await main(["ask", "Does this policy cover an outpatient MRI?", "--budget", "0.10"], env), 0);
      assert.match(stdout.text(), /^hook {6}insurance had nothing to forge here: every check it sent was already a match or a raised flag/m);
      assert.match(stdout.text(), /^checks {4}1 of 1 needed key opened and verified against the shop's committed root$/m);
      assert.match(stdout.text(), /^rate {6}5\/5 {2}= 5$/m);
    } finally {
      stdout.restore();
    }
  });
});

test("every shop has a recorded purchase where its lie is caught and rated 1/5", async () => {
  const cases = [
    ["disclosure", "What was Samsung's Q3 2025 operating profit?"],
    ["insurance", "What copay does this policy charge for an outpatient MRI?"],
    ["legal", "Does our NDA's three-year confidentiality term fail our playbook?"],
  ] as const;
  for (const [shop, question] of cases) {
    await withDataDir(async (root) => {
      const honest = await ask(root, question, "0.10");
      assert.doesNotMatch(honest.out, /FORGED/, shop);
      const lying = await ask(root, question, "0.10", { INFERPAY_TEST_LIAR: shop });
      assert.match(lying.out, new RegExp(`^hook {6}${shop} forged 1 check; the buyer should mark it FORGED and rate ${shop} 1/5$`, "m"), shop);
      assert.match(lying.out, /^checks .*, 1 FORGED$/m, shop);
      assert.match(lying.out, /^rate {6}1\/5 {2}forged evidence sets the rating to 1$/m, shop);
    });
  }
});

test("a shop that withholds the key it got wrong rates below the same shop owning up to it", async () => {
  await withDataDir(async (root) => {
    const question = "What copay does this policy charge for an outpatient MRI?";
    const honest = await ask(root, question, "0.10");
    assert.match(honest.out, /^ {10}verified {4}mismatch {6}MRI copay {7}10 {3}ref 20$/m);
    assert.match(honest.out, /^rate {6}4\/5 {2}= 5 - 1 x 1 mismatch = 4$/m);
    const hiding = await ask(root, question, "0.10", { INFERPAY_TEST_WITHHOLD: "insurance" });
    assert.match(hiding.out, /^hook {6}insurance dropped 1 check; /m);
    assert.match(hiding.out, /^checks {4}1 of 2 needed keys opened and verified against the shop's committed root, 1 WITHHELD$/m);
    assert.match(hiding.out, /^ {10}WITHHELD {18}mri-copay$/m);
    assert.match(hiding.out, /^rate {6}3\/5 {2}= 5 - 2 x 1 withheld = 3$/m);
  });
});

test("on the mock rail the rating stays in the ledger and providers says where reputation and each root came from", async () => {
  await withDataDir(async (root) => {
    const asked = await ask(root, "Does this policy cover an outpatient MRI?", "0.10");
    assert.match(asked.out, /^rate {6}5\/5 {2}= 5\n(?: {10}.*\n){4} {10}kept {6}in this machine's ledger, because the mock rail has no chain$/m);
    const stdout = capture(process.stdout);
    try {
      assert.equal(await main(["providers"], { INFERPAY_DATA_DIR: root }), 0);
      const text = stdout.text();
      assert.match(text, /^insurance .* 1 {5}5\.0 \(1\)$/m);
      assert.match(text, /^reputation {2}this machine's job ledger, because the mock rail has no chain$/m);
      assert.match(text, /^commitment {2}each root is from the shop's listing, because the mock rail has no chain$/m);
      assert.match(text, /^ {12}insurance {3}d26d1609271e…b68f {2}3 leaves$/m);
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

async function ask(root: string, question: string, budget: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  const stdout = capture(process.stdout);
  const stderr = capture(process.stderr);
  try {
    const code = await main(["ask", question, "--budget", budget], { ...env, INFERPAY_DATA_DIR: root });
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

const BRIEFING = "Brief me for Monday: France's capital, our NDA's indemnity clause, outpatient MRI cover, and Samsung's Q3 2025 operating profit";
const POLICY_CHECK = "Check what this policy covers for an outpatient MRI and for cosmetic surgery";

test("the briefing answers one part itself, carries its money forward, and buys the other three", async () => {
  const { code, out, receipt, jobs } = await runTask(BRIEFING, "0.10");
  assert.equal(code, 0);
  assert.match(out, /^part 2\/4 {2}Does this NDA's unlimited indemnification clause fail our playbook\?\n {10}allot {3}0\.02 NEAR share \+ 0\.02 NEAR carried = 0\.04 NEAR$/m);
  assert.match(out, /^ {10}allot {3}0\.03 NEAR share \+ 0\.026 NEAR carried = 0\.056 NEAR$/m);
  assert.match(out, /^ {10}1  the buyer itself {19}- {5}nothing {16}own answer, confidence 0\.99$/m);
  assert.match(out, /^ {10}2  legal\.stella\.inferpay\.testnet {6}0\.03  0\.024 NEAR on counter  1 verified; rated 5\/5$/m);
  assert.match(out, /^ {10}3  insurance\.ban\.inferpay\.testnet {5}0\.02  0\.02 NEAR at list {6}1 verified; rated 5\/5$/m);
  assert.match(out, /^ {10}4  disclosure\.david\.inferpay\.testnet  0\.02  0\.02 NEAR at list {6}1 verified; rated 5\/5$/m);
  assert.match(out, /^total {5}spent 0\.064 NEAR of the 0\.10 NEAR budget, 0\.036 NEAR left$/m);
  assert.match(out, /^fees {6}none: this rail reports no network fees$/m);
  assert.match(out, /^ {10}value {3}0\.04 NEAR, the part's allotment: the most a right answer is worth$/m);
  assert.doesNotMatch(out, /the budget: the most a right answer is worth/);
  assert.deepEqual(receipt.parts.map((row) => [row.outcome.kind, row.allotted.amount, row.spent.amount]), [
    ["answered-locally", "0.02", "0"],
    ["bought", "0.04", "0.024"],
    ["bought", "0.046", "0.02"],
    ["bought", "0.056", "0.02"],
  ]);
  assert.equal(jobs.length, 3, "the part answered locally opens no job");
  for (const row of receipt.parts) {
    if (row.outcome.kind === "bought") assert.ok(jobs.includes(`${row.outcome.jobId}.jsonl`));
  }
});

test("the tight policy check declines one part and stays inside its budget", async () => {
  const { code, out, receipt, jobs } = await runTask(POLICY_CHECK, "0.04");
  assert.equal(code, 0);
  assert.match(out, /^ {10}1  nobody +- +nothing +declined: counter-offer refused$/m);
  assert.match(out, /^total {5}spent 0\.014 NEAR of the 0\.04 NEAR budget, 0\.026 NEAR left$/m);
  assert.deepEqual(receipt.parts.map((row) => [row.outcome.kind, row.allotted.amount, row.spent.amount]), [
    ["declined", "0.02", "0"],
    ["bought", "0.04", "0.014"],
  ]);
  assert.equal(receipt.spent.amount, "0.014");
  assert.equal(receipt.left.amount, "0.026");
  assert.equal(jobs.length, 1);
});

test("an unrecorded task stops before any payment and lists the recorded tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  const stderr = capture(process.stderr);
  const stdout = capture(process.stdout);
  try {
    const code = await main(["task", "Plan my trip to Lisbon", "--budget", "0.10"], { INFERPAY_DATA_DIR: root });
    assert.equal(code, 1);
    assert.match(stderr.text(), /No NEAR moved\. The stub replays only these recorded tasks:/);
    assert.ok(stderr.text().includes(`npx inferpay task "${POLICY_CHECK}" --budget 0.04`));
    assert.deepEqual(await readdir(root), []);
  } finally {
    stderr.restore();
    stdout.restore();
    await rm(root, { recursive: true, force: true });
  }
});

async function runTask(task: string, budget: string): Promise<{ code: number; out: string; receipt: Receipt; jobs: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  const stdout = capture(process.stdout);
  try {
    const code = await main(["task", task, "--budget", budget], { INFERPAY_DATA_DIR: root });
    const out = stdout.text();
    const saved = /^saved {5}(.+)$/m.exec(out)?.[1];
    assert.ok(saved, "the receipt path is printed");
    assert.equal(dirname(saved), join(root, "tasks"));
    const receipt: Receipt = JSON.parse(await readFile(saved, "utf8"));
    assert.equal(basename(saved), `${receipt.taskId}.json`);
    assert.equal(receipt.task, task);
    const jobs = await readdir(join(root, "jobs"));
    return { code, out, receipt, jobs };
  } finally {
    stdout.restore();
    await rm(root, { recursive: true, force: true });
  }
}

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
