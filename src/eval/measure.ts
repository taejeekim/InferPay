import { formatUnits } from "../domain.ts";
import { ask, cliRunCount, recordedQuestions, supports, withFreshDir, type Run } from "./cli.ts";

const REFERENCE_BUDGET = "1.00";
export const BUDGETS = ["0.02", "0.03", "0.05", "0.10"] as const;

export type ForgeryRow = {
  readonly shop: string;
  readonly question: string;
  readonly planted: number;
  readonly caught: number;
  readonly lyingRating: number | null;
  // What the buyer paid the shop in the run with the liar hook.
  readonly lyingPaid: string;
  readonly honestForged: number;
};

// The same purchase from an honest shop and from one that drops every check not backing its answer.
export type OmissionRow = {
  readonly shop: string;
  readonly question: string;
  readonly honestRating: number | null;
  readonly honestPaid: string;
  readonly withheld: number;
  readonly withholdingRating: number | null;
  readonly withholdingPaid: string;
};

export type PolicyName = "inferpay" | "always-buy" | "never-buy";

export type PolicyRow = {
  readonly budget: string;
  readonly policy: PolicyName;
  readonly spent: string;
  readonly verified: number;
  readonly alone: number;
  readonly unanswered: number;
};

export type ReputationRow = { readonly state: string; readonly rep: number; readonly quality: number; readonly net: string };

type Reference = { readonly question: string; readonly run: Run };

export type Report = {
  readonly rails: string;
  readonly cliRuns: number;
  readonly questions: number;
  readonly forgery: readonly ForgeryRow[];
  readonly omission: readonly OmissionRow[];
  readonly economics: {
    readonly rows: readonly PolicyRow[];
    readonly counterOffers: number;
    readonly counterSaved: string;
  };
  readonly reputation: readonly ReputationRow[];
  readonly failures: readonly string[];
};

export async function measure(budgets: readonly string[] = BUDGETS): Promise<Report> {
  const startRuns = cliRunCount();
  const failures: string[] = [];
  const questions = await recordedQuestions();
  const forgery = await measureForgery(questions);
  const omission = await measureOmission(questions);
  const reference: Reference[] = [];
  for (const question of questions) reference.push({ question, run: await withFreshDir((dir) => ask(question, REFERENCE_BUDGET, { dataDir: dir })) });
  const economics = await measureEconomics(questions, budgets, reference, failures);
  const reputation = await measureReputation(forgery, reference);
  for (const row of forgery) {
    if (row.honestForged !== 0) failures.push(`false positive: ${row.shop} on "${row.question}" had ${row.honestForged} forged checks in an honest run`);
    if (row.caught !== row.planted) failures.push(`lie not caught exactly: ${row.shop} on "${row.question}" planted ${row.planted}, buyer marked ${row.caught} FORGED`);
    if (row.planted > 0 && row.lyingRating !== 1) failures.push(`lie rated ${row.lyingRating}/5, not 1/5: ${row.shop} on "${row.question}"`);
    if (row.planted > 0 && row.lyingPaid !== "0") failures.push(`a forger was paid ${row.lyingPaid} NEAR: ${row.shop} on "${row.question}"`);
  }
  for (const row of omission) {
    const lower = row.withholdingRating !== null && row.honestRating !== null && row.withholdingRating < row.honestRating;
    if (row.withheld > 0 && !lower) failures.push(`withholding did not cost: ${row.shop} on "${row.question}" rated ${row.withholdingRating}/5 against ${row.honestRating}/5 honest`);
    if (row.withheld === 0 && row.withholdingRating !== row.honestRating) failures.push(`withholding nothing changed the rating: ${row.shop} on "${row.question}"`);
    if (row.withheld > 0 && !(Number(row.withholdingPaid) < Number(row.honestPaid))) failures.push(`withholding did not cut the payout: ${row.shop} on "${row.question}"`);
  }
  return { rails: "payment=mock inference=stub", cliRuns: cliRunCount() - startRuns, questions: questions.length, forgery, omission, economics, reputation, failures };
}

async function measureForgery(questions: readonly string[]): Promise<ForgeryRow[]> {
  const rows: ForgeryRow[] = [];
  for (const question of questions) {
    const honest = await withFreshDir((dir) => ask(question, "0.10", { dataDir: dir }));
    if (honest.shop === null) continue;
    const shop = honest.shop;
    const lying = await withFreshDir((dir) => ask(question, "0.10", { dataDir: dir, liar: shop }));
    const planted = lying.assertedVerdicts.filter((verdict, index) => verdict !== honest.assertedVerdicts[index]).length;
    rows.push({ shop, question, planted, caught: lying.forged, lyingRating: lying.rating, lyingPaid: formatUnits(lying.spent), honestForged: honest.forged });
  }
  return rows;
}

async function measureOmission(questions: readonly string[]): Promise<OmissionRow[]> {
  const rows: OmissionRow[] = [];
  for (const question of questions) {
    const honest = await withFreshDir((dir) => ask(question, "0.10", { dataDir: dir }));
    if (honest.shop === null) continue;
    const shop = honest.shop;
    const withholding = await withFreshDir((dir) => ask(question, "0.10", { dataDir: dir, withhold: shop }));
    rows.push({
      shop,
      question,
      honestRating: honest.rating,
      honestPaid: formatUnits(honest.spent),
      withheld: withholding.withheld,
      withholdingRating: withholding.rating,
      withholdingPaid: formatUnits(withholding.spent),
    });
  }
  return rows;
}

async function measureEconomics(questions: readonly string[], budgets: readonly string[], reference: readonly Reference[], failures: string[]): Promise<Report["economics"]> {
  const rows: PolicyRow[] = [];
  let counterOffers = 0;
  let saved = 0n;
  const runs = new Map<string, Run[]>();
  for (const budget of budgets) {
    const list: Run[] = [];
    for (const question of questions) list.push(await withFreshDir((dir) => ask(question, budget, { dataDir: dir })));
    runs.set(budget, list);
  }
  // A baseline purchase is credited the checks its shop returns when bought at a budget large enough that InferPay buys.
  const returned = new Map<string, boolean>();
  for (const { question, run } of reference) if (run.shop) returned.set(`${question}|${run.shop}`, supports(run));
  for (const budget of budgets) {
    const list = runs.get(budget) ?? [];
    const infer = { spent: 0n, verified: 0, alone: 0, unanswered: 0 };
    const always = { spent: 0n, verified: 0, alone: 0, unanswered: 0 };
    const never = { spent: 0n, verified: 0, alone: 0, unanswered: 0 };
    list.forEach((run, index) => {
      const question = questions[index] ?? "";
      if (run.spent > run.budget) failures.push(`InferPay spent ${formatUnits(run.spent)} above the ${budget} budget on "${question}"`);
      infer.spent += run.spent;
      if (run.outcome === "bought") {
        if (supports(run)) infer.verified += 1;
        if (run.countered) {
          counterOffers += 1;
          saved += (run.options.find((option) => option.shop === run.shop)?.ask ?? run.spent) - run.spent;
        }
      } else if (run.outcome === "local") infer.alone += 1;
      else infer.unanswered += 1;

      const best = run.options.filter((option) => option.affordable && option.cover > 0).sort((a, b) => b.cover - a.cover)[0];
      if (best) {
        always.spent += best.ask;
        const known = returned.get(`${question}|${best.shop}`);
        if (known === undefined) failures.push(`no recorded checks for ${best.shop} on "${question}", so the always-buy baseline is unmeasured`);
        if (known) always.verified += 1;
      } else if (run.localConfident) always.alone += 1;
      else always.unanswered += 1;

      if (run.localConfident) never.alone += 1;
      else never.unanswered += 1;
    });
    for (const [policy, tally] of [["inferpay", infer], ["always-buy", always], ["never-buy", never]] as const) {
      rows.push({ budget, policy, spent: formatUnits(tally.spent), verified: tally.verified, alone: tally.alone, unanswered: tally.unanswered });
    }
  }
  return { rows, counterOffers, counterSaved: formatUnits(saved) };
}

async function measureReputation(forgery: readonly ForgeryRow[], reference: readonly Reference[]): Promise<ReputationRow[]> {
  const lie = forgery.find((row) => row.planted > 0);
  const good = reference.find((item) => item.run.shop === lie?.shop && item.run.rating === 5);
  if (!lie || !good) throw new Error("the reputation scenario needs a shop that can lie and a job it earns 5/5 on");
  return withFreshDir(async (dir) => {
    const first = await ask(good.question, REFERENCE_BUDGET, { dataDir: dir });
    const afterGood = await ask(lie.question, REFERENCE_BUDGET, { dataDir: dir, liar: lie.shop });
    const afterForged = await ask(good.question, REFERENCE_BUDGET, { dataDir: dir });
    const pick = (state: string, run: Run): ReputationRow => {
      const option = run.options.find((candidate) => candidate.shop === lie.shop);
      if (!option) throw new Error(`no decide row for ${lie.shop}`);
      return { state: `${lie.shop}: ${state}`, rep: option.rep, quality: option.quality, net: option.net };
    };
    return [
      pick("before any job", first),
      pick(`after one honest job rated ${first.rating}/5`, afterGood),
      pick(`then a forged job rated ${afterGood.rating}/5`, afterForged),
    ];
  });
}
