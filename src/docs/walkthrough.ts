import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../eval/cli.ts";

type Step = {
  readonly title: string;
  readonly before: string;
  readonly argv: (ids: ReadonlyMap<string, string>) => readonly string[];
  readonly hook?: { readonly liar?: string; readonly withhold?: string };
  // The step exists to show this. Generation fails when the output stops showing it.
  readonly shows: RegExp;
  readonly after?: string;
  // Remember the first job id this step prints, for a later step.
  readonly keepJobAs?: string;
};

const MRI = "Does this policy cover an outpatient MRI?";
const COPAY = "What copay does this policy charge for an outpatient MRI?";
const BRIEFING = "Brief me for Monday: France's capital, our NDA's indemnity clause, outpatient MRI cover, and Samsung's Q3 2025 operating profit";

const STEPS: readonly Step[] = [
  {
    title: "Buy an answer the buyer cannot work out alone",
    before: "The buyer rates its own confidence at 0.20, names the catalog key the answer depends on, and opens a job with the insurance shop at the list price. The shop delivers first and opens that key. The buyer verifies it against the shop's committed root, and only then pays.",
    argv: () => ["ask", MRI, "--budget", "0.10"],
    shows: /buy from insurance at 0\.02 NEAR \(list price\)[\s\S]*^job {7}job_\w+ opened[\s\S]*1 of 1 needed key opened and verified[\s\S]*^payout {4}0\.02 NEAR of the agreed 0\.02 NEAR[\s\S]*^pay {7}settled {2}0\.02 NEAR[\s\S]*rate {6}5\/5/m,
    after: "`--budget` is the most a right answer is worth. `local` is what answering alone is worth. `needs` are the keys the buyer requires the shop to open. Each `option` is a shop. The `rule` line shows the comparison with the numbers filled in.",
  },
  {
    title: "Answer alone and pay nothing",
    before: "The buyer is sure of the answer, and no shop's catalog holds a key the question needs.",
    argv: () => ["ask", "What is the capital of France?", "--budget", "0.10"],
    shows: /decide {4}answer locally, pay nothing/,
  },
  {
    title: "Counter once when the ask is over plan",
    before: "With a smaller budget, the list price is above what the answer is worth to the buyer. The buyer offers its reservation price once. The shop's private floor is below the offer, so the shop accepts.",
    argv: () => ["ask", MRI, "--budget", "0.03"],
    shows: /counter-offer accepted[\s\S]*reply {3}insurance accepted/,
    keepJobAs: "countered",
  },
  {
    title: "Walk away when the counter is refused",
    before: "Here the buyer is fairly sure of itself, so its reservation price is low. The offer is below the shop's floor, the shop refuses, and the buyer answers alone.",
    argv: () => ["ask", "What was Samsung's Q3 2025 revenue?", "--budget", "0.10"],
    shows: /answer locally, pay nothing \(counter-offer refused\)/,
  },
  {
    title: "Grade an honest shop that got a figure wrong",
    before: "In this recording the shop's model claims a 10 percent copay. The shop's own dataset says 20. The shop opens the entry anyway, the buyer sees the mismatch, and the rating drops by one star. The shop's summary still says 10 percent, but the buyer's `facts` come only from the entries it verified, so the buyer relies on 20. The shop opened both needed keys, so it is paid in full.",
    argv: () => ["ask", COPAY, "--budget", "0.10"],
    shows: /^summary {3}[^\n]*10 percent[\s\S]*mismatch[\s\S]*^facts[\s\S]*^ {10}mri-copay {2}= 20$[\s\S]*rate {6}4\/5/m,
  },
  {
    title: "Catch a shop that forges its evidence",
    before: "`INFERPAY_TEST_LIAR` is a test hook. The named shop rewrites the mismatch into a match and fabricates the evidence. It cannot change the root it already published, so the fabricated evidence does not open to that root. The buyer verifies before it pays, so the forger gets nothing.",
    argv: () => ["ask", COPAY, "--budget", "0.10"],
    hook: { liar: "insurance" },
    shows: /FORGED[\s\S]*^payout {4}nothing of the agreed 0\.02 NEAR[\s\S]*^pay {7}nothing sent[\s\S]*rate {6}1\/5/m,
  },
  {
    title: "Catch a shop that leaves a needed key out",
    before: "`INFERPAY_TEST_WITHHOLD` is the other test hook. The named shop drops the check that does not back its answer. The buyer named that key as needed, so the missing opening is marked `WITHHELD`. It costs the shop that key's share of the price and two stars, which is more than the honest mismatch cost.",
    argv: () => ["ask", COPAY, "--budget", "0.10"],
    hook: { withhold: "insurance" },
    shows: /WITHHELD[\s\S]*^payout {4}0\.01 NEAR of the agreed 0\.02 NEAR[\s\S]*rate {6}3\/5/m,
  },
  {
    title: "Give it a whole task and one budget",
    before: "The buyer splits the task into parts, gives each part a share of the budget, and carries what a part leaves unspent to the next part. It ends with one receipt that shows, per part, the agreed price, what the buyer paid after verifying, and the fees. On the mock rail no fee is charged; on testnet the fees come out of the same budget.",
    argv: () => ["task", BRIEFING, "--budget", "0.10"],
    shows: /plan {6}4 parts under one budget[\s\S]*receipt {3}task_[\s\S]*AGREED +PAID +FEES[\s\S]*total {5}prices [0-9.]+ NEAR \+ fees 0 NEAR = [0-9.]+ NEAR of the 0\.10 NEAR budget/,
  },
  {
    title: "Ask something with no recording",
    before: "Without a NEAR AI key the stub replays recorded questions only. Any other question stops before a job opens.",
    argv: () => ["ask", "Schedule a meeting on Monday", "--budget", "0.10"],
    shows: /No NEAR moved/,
  },
  {
    title: "List the shops",
    before: "Reputation comes from the ratings above. The catalog is what a buyer may require a shop to open.",
    argv: () => ["providers"],
    shows: /catalog/,
  },
  {
    title: "Read one job's log",
    before: "This is the job from the counter-offer step, in the order it happened. The `quote` is the agreed price. The lines under `delivered` are the shop's answer and the evidence for each check. `payout-decided` is what the buyer owed after verifying, and only then does the payment appear.",
    argv: (ids) => ["job", ids.get("countered") ?? ""],
    shows: /quote 0\.0[0-9]+ NEAR[\s\S]*^delivered[\s\S]*root {6}equals the commitment above[\s\S]*^payout-decided[\s\S]*^payment-settled/m,
  },
];

export const NORMALISERS: readonly (readonly [RegExp, string])[] = [
  [/job_[0-9A-HJKMNP-TV-Z]{26}/g, "job_ID"],
  [/task_[0-9A-HJKMNP-TV-Z]{26}/g, "task_ID"],
  [/\d{2}:\d{2}:\d{2} UTC/g, "HH:MM:SS UTC"],
  [/mock_[0-9a-f-]{36}/g, "mock_KEY"],
  [/mock-[0-9a-f]{4}/g, "mock-CORR"],
];

export function normalise(text: string): string {
  return NORMALISERS.reduce((out, [pattern, to]) => out.replace(pattern, to), text);
}

function quote(arg: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(arg) ? arg : `"${arg}"`;
}

export async function generate(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "inferpay-walkthrough-"));
  const ids = new Map<string, string>();
  const parts: string[] = [
    "# Walkthrough",
    "",
    "Every block below is the real output of the command above it, run in this order from one fresh data directory with no keys set (`payment=mock inference=stub`). `node src/docs/walkthrough.ts --write` regenerates this file, and a test fails when the file and the CLI disagree. Job ids, task ids, and times differ on your machine. Reputation feeds the arithmetic, so the numbers depend on the order.",
    "",
  ];
  try {
    for (const [index, step] of STEPS.entries()) {
      const argv = step.argv(ids);
      const run = await runCli(argv, { dataDir, ...step.hook });
      const output = `${run.out}${run.err}`.replaceAll(dataDir, ".inferpay").trimEnd();
      if (!step.shows.test(output)) throw new Error(`step ${index + 1} (${step.title}) no longer shows ${step.shows}\n${output}`);
      if (step.keepJobAs !== undefined) {
        const job = /job_[0-9A-HJKMNP-TV-Z]{26}/.exec(output)?.[0];
        if (job === undefined) throw new Error(`step ${index + 1} printed no job id`);
        ids.set(step.keepJobAs, job);
      }
      const hook = step.hook?.liar !== undefined
        ? `INFERPAY_TEST_LIAR=${step.hook.liar} `
        : step.hook?.withhold !== undefined ? `INFERPAY_TEST_WITHHOLD=${step.hook.withhold} ` : "";
      parts.push(`## ${index + 1}. ${step.title}`, "", step.before, "", "```sh", `${hook}npx inferpay ${argv.map(quote).join(" ")}`, "```", "", "```text", output, "```", "");
      if (run.code !== 0) parts.push(`The command exits with code ${run.code}.`, "");
      if (step.after !== undefined) parts.push(step.after, "");
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const text = await generate();
  if (process.argv.includes("--write")) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(new URL("../../WALKTHROUGH.md", import.meta.url), text);
    process.stdout.write("wrote WALKTHROUGH.md\n");
  } else {
    process.stdout.write(text);
  }
}
