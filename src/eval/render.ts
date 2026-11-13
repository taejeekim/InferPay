import type { PolicyName, Report } from "./measure.ts";

const POLICY_LABEL: Record<PolicyName, string> = {
  inferpay: "InferPay",
  "always-buy": "always buy",
  "never-buy": "never buy",
};

export function renderReport(report: Report): string {
  const { forgery, economics, reputation } = report;
  const shops = [...new Set(forgery.map((row) => row.shop))];
  const lines: string[] = [
    `rails: ${report.rails} | ${report.cliRuns} CLI runs | ${report.questions} recorded questions | keyless`,
    "",
    "1. Forgery detection. Each shop answers its questions at 0.10 NEAR, honest then with the liar hook.",
    row(["shop", "questions", "runs with a lie", "lies planted", "caught", "rated 1/5", "honest false flags"], FORGERY_WIDTHS),
  ];
  const total = { questions: 0, withLie: 0, planted: 0, caught: 0, one: 0, flags: 0 };
  for (const shop of [...shops, null]) {
    const mine = forgery.filter((item) => shop === null || item.shop === shop);
    const sums = {
      questions: mine.length,
      withLie: mine.filter((item) => item.planted > 0).length,
      planted: sum(mine.map((item) => item.planted)),
      caught: sum(mine.map((item) => item.caught)),
      one: mine.filter((item) => item.planted > 0 && item.lyingRating === 1).length,
      flags: sum(mine.map((item) => item.honestForged)),
    };
    if (shop === null) Object.assign(total, sums);
    lines.push(row([shop ?? "all", String(sums.questions), String(sums.withLie), String(sums.planted), `${sums.caught} of ${sums.planted}`, `${sums.one} of ${sums.withLie}`, String(sums.flags)], FORGERY_WIDTHS));
  }
  lines.push(
    "",
    "2. Decision economics. Eight recorded questions per budget, each from a fresh data directory.",
    row(["budget", "policy", "NEAR spent", "verified answers", "buyer alone", "no answer"], ECON_WIDTHS),
  );
  for (const item of economics.rows) {
    lines.push(row([item.budget, POLICY_LABEL[item.policy], item.spent, String(item.verified), String(item.alone), String(item.unanswered)], ECON_WIDTHS));
  }
  lines.push(
    `InferPay counter-offers accepted: ${economics.counterOffers}, saving ${economics.counterSaved} NEAR against list price.`,
    "",
    "3. Reputation response. One data directory, one shop, at 1.00 NEAR so its decide row always shows.",
    row(["shop state", "rep", "quality", "net (NEAR)"], REP_WIDTHS),
  );
  for (const item of reputation) lines.push(row([item.state, item.rep.toFixed(2), item.quality.toFixed(2), item.net], REP_WIDTHS));
  lines.push(
    "",
    "Notes",
    ...NOTES.flatMap(wrap),
  );
  return lines.join("\n");
}

const FORGERY_WIDTHS = [12, 10, 16, 13, 10, 10, 18] as const;
const ECON_WIDTHS = [8, 12, 12, 17, 12, 10] as const;
const REP_WIDTHS = [58, 6, 9, 11] as const;

function row(cells: readonly string[], widths: readonly number[]): string {
  return `  ${cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(" ")}`.trimEnd();
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

const NOTES = [
  "a. Recorded questions replayed by the stub, not a benchmark of model accuracy. The liar is a test hook that flips each check to the shop's favour and cannot change its committed root. Caught means the buyer printed FORGED for it.",
  "b. verified means at least one buyer-verified match or raised check supports the answer. Baselines reuse the decide block's options and list prices. always buy pays the best-covering affordable shop its list price and credits it the checks that shop returns when bought at 1.00 NEAR. Both baselines answer alone at confidence >= 0.50, else give no answer. always buy pays list price where InferPay judged it not worth paying, so it leaves fewer questions unanswered.",
  "c. Reputation rows are the shop's rep in the decide block of the next job; job two runs with the liar. Lies planted are checks whose asserted verdict differs from the honest run's, read from jobs/*.jsonl. A shop with no mismatch to flip has nothing to lie about, so its liar run equals its honest run.",
];

function wrap(note: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of note.split(" ")) {
    if (current !== "" && current.length + 1 + word.length > 98) {
      out.push(current);
      current = `   ${word}`;
    } else current = current === "" ? word : `${current} ${word}`;
  }
  return [...out, current];
}
