import type { ConfigError } from "../config.ts";
import { formatUnits, toUnits, type Price } from "../domain.ts";
import type { ForestRow, Roster } from "../roster.ts";
import { LOCAL_FLOOR, type Decision, type Needs, type Option, type PricedOption, type Progress } from "../consumer/index.ts";
import type { FailReason, JobView, Listing } from "../market/index.ts";
import {
  canonical,
  catalogName,
  entryKey,
  leafHash,
  slotOf,
  type AssertedCheck,
  type Evidence,
  type Hash,
  type Key,
  type Need,
  type PinnedCommitment,
} from "../commitment/index.ts";
import type { PaymentRail } from "../payment/index.ts";
import type { CallAttestation } from "../inference/attest.ts";
import { tally } from "../consumer/grade.ts";
import type { NoDeal } from "../consumer/decide.ts";
import type { PartOutcome, Receipt, ReceiptRow, TaskProgress } from "../consumer/task.ts";
import { claimKey, verifyChecks, type BuyerCheck, type Forgery } from "../consumer/verify.ts";
import type { AccountId } from "../domain.ts";
import { accountUrl, txUrl } from "../near/explorer.ts";
import type { RatingPost } from "../registry/index.ts";
import { commitmentKey } from "../registry/keys.ts";
import { formatNear } from "../payment/units.ts";

export function railsLine(rails: { readonly payment: string; readonly inference: string }): string {
  return `rails: payment=${rails.payment} inference=${rails.inference}`;
}

export function liarLine(shop: string): string {
  return line("hook", `INFERPAY_TEST_LIAR=${shop}: this shop reports every check in its own favour and forges the evidence`);
}

export function progressLine(progress: Progress, rail: PaymentRail["kind"]): string {
  switch (progress.step) {
    case "decide":
      return decideBlock(progress.decision, progress.needs);
    case "pay":
      return payBlock(progress, rail);
    case "answer":
      return [line("answer", progress.answer.text), ...attestLines("specialist", progress.answer.attestation)].join("\n");
    case "verify":
      return checksBlock(progress.checks, progress.commitment, rail).join("\n");
    case "rate":
      return [
        line("rate", rateText(progress.rating, progress.checks)),
        ...ratingRows(progress.onChain, progress.jobId, rail).map((row) => line("", row)),
      ].join("\n");
    case "pending":
      return line("pending", `${progress.jobId} is waiting on payment. Run: npx inferpay resume ${progress.jobId}`);
    default: {
      const unreachable: never = progress;
      return unreachable;
    }
  }
}

export function localAnswerText(text: string): string {
  return [line("answer", text), line("checks", "none, this is the buyer's own answer")].join("\n");
}

export function providersTable(listings: readonly Listing[], rail: PaymentRail["kind"]): string {
  const rows = [
    ["ID", "OWNER", "PAY TO", "SPECIALTY", "PRICE", "JOBS", "RATING"],
    ...listings.map((listing) => [
      listing.id,
      listing.owner,
      listing.payTo,
      listing.specialty,
      `${listing.price.amount} ${listing.price.symbol}`,
      String(listing.reputation.completedJobs),
      listing.reputation.kind === "unrated"
        ? "unrated"
        : `${listing.reputation.average.toFixed(1)} (${listing.reputation.ratings})`,
    ]),
  ];
  const noChain = rail === "mock" ? "because the mock rail has no chain" : "because this rail keeps no record on chain";
  const chain = listings.flatMap((listing) => {
    if (listing.commitment.status === "missing") return [listing.commitment.contract];
    return listing.commitment.source.kind === "chain" ? [listing.commitment.source.contract] : [];
  })[0];
  const idWidth = listings.reduce((max, listing) => Math.max(max, listing.id.length), 0) + 2;
  const footer = (name: string, value: string): string => `${name.padEnd(12)}${value}`;
  return [
    table(rows),
    "",
    footer("reputation", chain === undefined
      ? `this machine's job ledger, ${noChain}`
      : "ratings on NEAR testnet, each written by a buyer bot under <bot>/inferpay/ratings/<job> in SocialDB"),
    footer("commitment", chain === undefined
      ? `each root is from the shop's listing, ${noChain}`
      : `each root is on NEAR testnet under <shop>/inferpay/commitment in SocialDB ${chain}`),
    ...listings.map((listing) => footer("", `${listing.id.padEnd(idWidth)}${listedRoot(listing.commitment)}`)),
    footer("catalog", "the keys each shop holds an entry for, without their values; a buyer may require only these opened"),
    ...listings.map((listing) => footer("", `${listing.id.padEnd(idWidth)}${listing.catalog.map(catalogName).join("; ")}`)),
  ].join("\n");
}

function listedRoot(pinned: PinnedCommitment): string {
  if (pinned.status === "missing") return "none published";
  const { commitment, source } = pinned;
  const since = source.kind === "chain" ? `  since block ${source.block}` : "";
  return `${shortHash(commitment.root)}  ${plural(commitment.leaves, "leaf", "leaves")}${since}`;
}

export function jobText(view: JobView): string {
  const under = (row: string): string => `${"".padEnd(18)}${row}`;
  return view.events.map((event) => {
    const time = `${event.at.slice(11, 19)} UTC`;
    const label = event.type.padEnd(18);
    switch (event.type) {
      case "opened":
        return [
          `${label}${time}  ${event.order.providerId}  quote ${event.quote.amount} ${event.quote.symbol}  budget ${event.order.budget.amount} ${event.order.budget.symbol}  ${event.order.payFrom} -> ${event.payTo}`,
          ...pinnedRows(event.order.commitment).map(under),
          under(`needs      ${event.order.needs.length === 0 ? "none" : event.order.needs.map(needText).join("; ")}`),
        ].join("\n");
      case "payment-intended":
        return `${label}${time}  key ${event.key}`;
      case "payment-pending":
        return `${label}${time}  correlation ${event.correlationId ?? "none"}${event.uncertain ? " uncertain" : ""}`;
      case "payment-settled":
        return `${label}${time}  correlation ${event.receipt.correlationId}`;
      case "payment-rejected":
        return `${label}${time}  ${event.reason}`;
      case "fulfil-failed":
        return `${label}${time}  ${event.reason}`;
      case "fulfilled":
        return [
          `${label}${time}  ${event.answer.checks.length} checks`,
          ...attestLines("specialist", event.answer.attestation).map(under),
          ...verifyChecks(event.answer.checks, view.order.commitment, view.order.question).flatMap(proofRows).map(under),
        ].join("\n");
      case "rated":
        return `${label}${time}  ${event.rating}/5`;
      case "rating-posted":
        return [`${label}${time}  tx ${event.tx}`, under(txUrl(event.tx))].join("\n");
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  }).join("\n");
}

export function configErrorText(error: ConfigError): string {
  if (error.kind === "partial-payment-env") {
    return `Payment configuration is partial. Present: ${error.present.join(", ")}. Missing: ${error.missing.join(", ")}. Set all three payment variables, or unset them to use the mock rail.`;
  }
  return `${error.variable} is invalid. ${error.detail}`;
}

export function failureText(reason: FailReason): string {
  switch (reason.kind) {
    case "unknown-provider":
      return `Unknown provider ${reason.providerId}.`;
    case "unknown-job":
      return `Unknown job ${reason.jobId}.`;
    case "over-budget":
      return `Offer ${reason.offer.amount} ${reason.offer.symbol} is above budget ${reason.budget.amount} ${reason.budget.symbol}.`;
    case "stale-commitment":
      return `${reason.providerId} turned the order down before payment: its dataset no longer seals to the root it published. The shop publishes again with: npx inferpay testnet setup`;
    case "offer-refused":
      return `${reason.providerId} refused ${reason.offer.amount} ${reason.offer.symbol}.`;
    case "order-conflict":
      return `Job ${reason.jobId} was opened with a different order.`;
    case "job-busy":
      return `Job ${reason.jobId} is already running.`;
    case "corrupt-ledger":
      return `Job ${reason.jobId} ledger is corrupt. ${reason.detail}`;
    case "payment-rejected":
      return `Payment was rejected. ${reason.reason}`;
    case "provider-failed":
      return `Provider failed. ${reason.reason}`;
    case "inference":
      return `Inference failed. ${reason.detail}`;
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

export function usageText(): string {
  return [
    "inferpay wallets",
    "inferpay providers",
    "inferpay ask <question> --budget <amount> [--from <bot>]",
    "inferpay task <task> --budget <amount> [--from <bot>]",
    "inferpay resume <jobId>",
    "inferpay job <jobId>",
    "inferpay testnet setup [--root <name>.testnet]",
    "",
    "test hooks, set in the environment:",
    "  INFERPAY_TEST_LIAR=<shop id>   that shop reports every check in its own favour and forges the evidence;",
    "                                 the buyer should mark the check FORGED and rate the shop 1/5",
    "  INFERPAY_TEST_CRASH=<point>    near-testnet only: exit at that point, then run inferpay resume <jobId>;",
    "                                 after-sign or after-broadcast stops the payment,",
    "                                 after-rating-sign or after-rating-broadcast stops the on-chain rating",
  ].join("\n");
}

export function unknownBotText(roster: Roster, raw: string): string {
  const names = roster.forest().filter((row) => row.role !== "specialist").map((row) => row.bot);
  return `Unknown bot ${raw}. Kyle's bots: ${names.join(", ")}.`;
}

export function walletsTable(roster: Roster, balances: ReadonlyMap<AccountId, bigint | null> | null): string {
  if (balances === null) {
    return table([
      ["PERSON", "PARENT", "BOT", "ACCOUNT", "ROLE"],
      ...roster.forest().map((row) => [row.personId, row.parent, row.bot, row.account, roleLabel(row.role)]),
    ]);
  }
  const rows = [
    ["PERSON", "PARENT", "BOT", "ACCOUNT", "ROLE", "BALANCE"],
    ...roster.forest().map((row) => {
      const balance = balances.get(row.account) ?? null;
      return [row.personId, row.parent, row.bot, row.account, roleLabel(row.role), balance === null ? "not created" : `${formatNear(balance)} NEAR`];
    }),
  ];
  const cap = "spend cap: a native NEAR transfer needs a full-access key, so each bot's on-chain spend cap is its own sub-account balance.";
  return `${table(rows)}\n\n${cap}`;
}

function roleLabel(role: ForestRow["role"]): string {
  switch (role) {
    case "default-payer":
      return "default payer";
    case "payer":
      return "payer";
    case "specialist":
      return "specialist";
    default: {
      const unreachable: never = role;
      return unreachable;
    }
  }
}

function decideBlock(decision: Decision, needs: Needs): string {
  const { value, local } = decision;
  const idWidth = decision.options.reduce((max, option) => Math.max(max, option.providerId.length), 0) + 2;
  return [
    line("decide", headline(decision)),
    field("value", `${money(value)}, the budget: the most a right answer is worth`),
    field("local", `confidence ${share(local.confidence)} x value = worth ${near(local.worth)} ${value.symbol}`),
    field("missing", local.missing.length === 0 ? "nothing" : local.missing.join("; ")),
    ...needsRows(needs, idWidth),
    ...decision.options.map((option) => field("option", optionText(option, idWidth, value))),
    ...ruleRows(decision),
  ].join("\n");
}

// The keys the buyer will require each shop to open, from that shop's catalog. A shop with none covers nothing.
function needsRows(needs: Needs, idWidth: number): string[] {
  const rows = [...needs.byShop].map(([shop, list]) => field("needs", `${shop.padEnd(idWidth)}${list.map(needText).join("; ")}`));
  if (rows.length === 0) rows.push(field("needs", "no key from any shop's catalog"));
  for (const drop of needs.dropped) {
    const why = drop.why === "not-in-catalog" ? "not in its catalog" : "no clause quoted from the question";
    rows.push(field("dropped", `${drop.shop.padEnd(idWidth)}${drop.key}: ${why}`));
  }
  if (needs.dropped.length > 0) rows.push(field("", "a dropped key is never ordered, and a shop left with no needed key counts as cover 0"));
  return rows;
}

export function needText(need: Need): string {
  return need.kind === "rule" ? `${need.id} on "${need.clause}"` : catalogName(need);
}

function headline(decision: Decision): string {
  switch (decision.kind) {
    case "buy": {
      const how = decision.negotiation === "list-price" ? "list price" : "counter-offer accepted";
      return `buy from ${decision.option.providerId} at ${money(decision.agreed)} (${how})`;
    }
    case "answer-locally":
      return `answer locally, pay nothing${refusedNote(decision)}`;
    case "decline":
      return `decline, pay nothing${refusedNote(decision)}`;
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

function refusedNote(decision: Exclude<Decision, { kind: "buy" }>): string {
  return decision.because.kind === "counter-refused" ? " (counter-offer refused)" : "";
}

function optionText(option: Option, idWidth: number, value: Price): string {
  const head = `${option.providerId.padEnd(idWidth)}ask ${option.ask.amount}  `;
  if (option.kind === "unaffordable") return `${head}outside the ${money(value)} budget`;
  const quality = `cover ${share(option.coverage)} x rep ${share(option.reputation)} = quality ${share(option.quality)}`;
  return `${head}${quality}  net ${option.net < 0n ? "" : "+"}${near(option.net)}`;
}

function ruleRows(decision: Decision): string[] {
  const { value, local } = decision;
  const buyRule = (option: PricedOption): string => {
    const verdict = option.net >= local.worth ? ">=" : "<";
    return field("rule", `net = quality x value - ask; buy when net >= local worth: ${near(option.net)} ${verdict} ${near(local.worth)}`);
  };
  const reservation = (option: PricedOption): string => (
    `(${share(option.quality)} - ${share(local.confidence)}) x ${value.amount} = ${near(option.reservation)} ${value.symbol}`
  );
  const counterRows = (option: PricedOption, offer: Price, reply: string): string[] => [
    field("reserve", `${reservation(option)}, where buying equals the local worth`),
    field("counter", `${money(offer)} against the ask of ${money(option.ask)}`),
    field("reply", `${option.providerId} ${reply}`),
  ];
  if (decision.kind === "buy") {
    if (decision.negotiation === "list-price") return [buyRule(decision.option)];
    return [buyRule(decision.option), ...counterRows(decision.option, decision.agreed, "accepted")];
  }
  const clears = local.confidence >= LOCAL_FLOOR;
  const floor = share(LOCAL_FLOOR);
  const localRule = field(
    "rule",
    `answer locally when confidence >= ${floor}: ${share(local.confidence)} ${clears ? ">=" : "<"} ${floor}${clears ? "" : ", so decline"}`,
  );
  const because = decision.because;
  switch (because.kind) {
    case "nothing-affordable":
      return [field("rule", `never pay above the budget: every ask is outside ${money(value)}`), localRule];
    case "no-coverage":
      return [field("rule", "buy only from a shop that covers a missing fact: no shop within the budget does"), localRule];
    case "no-price-worth-paying":
      return [
        buyRule(because.option),
        field("rule", `counter only when the reservation is above zero: ${reservation(because.option)}`),
        localRule,
      ];
    case "counter-refused":
      return [
        buyRule(because.option),
        ...counterRows(because.option, because.offer, "refused, so the buyer walks away"),
        localRule,
      ];
    default: {
      const unreachable: never = because;
      return unreachable;
    }
  }
}

function money(price: Price): string {
  return `${price.amount} ${price.symbol}`;
}

function share(percent: number): string {
  return (percent / 100).toFixed(2);
}

// Three decimals line the columns up. Up to six show when a budget needs them.
function near(units: bigint): string {
  const [whole, frac] = formatUnits(units).split(".");
  return `${whole ?? "0"}.${(frac ?? "").slice(0, 6).padEnd(3, "0")}`;
}

function payBlock(progress: Extract<Progress, { step: "pay" }>, rail: PaymentRail["kind"]): string {
  const money = `${progress.amount.amount} ${progress.amount.symbol}`;
  const rows = [
    line("pay", `${progress.status}  ${money}`),
    field("from", progress.payer),
    field("to", progress.recipient),
    field("via", viaText(rail)),
    field("job", progress.jobId),
  ];
  if (rail === "near-testnet" && progress.correlationId) rows.push(field("tx", txUrl(progress.correlationId)));
  if (progress.status === "pending" || progress.status === "uncertain") {
    rows.push(field("key", progress.key));
    if (progress.correlationId) rows.push(field("corr", progress.correlationId));
  }
  if (progress.status === "uncertain") rows.push(field("note", "resume retries with the same key, so this transfer cannot be paid twice"));
  if (progress.transfer === "skipped" && progress.status === "settled") {
    rows.push(field("note", "already paid, transfer skipped"));
  }
  return rows.join("\n");
}

function viaText(rail: PaymentRail["kind"]): string {
  switch (rail) {
    case "mock":
      return "mock receipt (no NEAR moved)";
    case "near-intents":
      return "Intents grant";
    case "near-testnet":
      return "NEAR testnet transfer";
    default: {
      const unreachable: never = rail;
      return unreachable;
    }
  }
}

// Says only what was checked: the signer is in NEAR AI's report and the hashes match. The TDX and GPU
// quotes that make the report trustworthy are NEAR AI's claim here, not something this CLI re-verified.
export function attestLines(role: "buyer" | "specialist", calls: readonly CallAttestation[]): string[] {
  if (calls.length === 0) return [];
  const verified = calls.filter((call) => call.verdict === "verified");
  const rows = [line("attest", `${role} ${verified.length}/${calls.length} calls verified`)];
  const signers = new Set(verified.map((call) => `signed by ${call.signer}, a key in NEAR AI's attestation report for ${call.model}`));
  rows.push(...[...signers].map((text) => line("", text)));
  if (verified.length > 0) {
    rows.push(line("", "request and response hashes match; report echoed our nonce; TDX and GPU quotes not re-verified locally"));
  }
  const failures = new Set(calls.flatMap((call) => (call.verdict === "unverified" ? [`unverified ${call.reason}: ${call.detail}`] : [])));
  rows.push(...[...failures].map((text) => line("", text)));
  return rows;
}

function field(name: string, value: string): string {
  return line("", `${name.padEnd(8)}${value}`);
}

function rateText(rating: number, checks: readonly BuyerCheck[]): string {
  const counts = tally(checks);
  if (counts.forged > 0) return `${rating}/5  (forged evidence sets the rating to 1)`;
  const reasons: string[] = [];
  if (counts.mismatches > 0) reasons.push(`${plural(counts.mismatches, "mismatch", "mismatches")} among ${plural(counts.verified, "verified check", "verified checks")}`);
  if (counts.unbacked > 0) reasons.push(`${plural(counts.unbacked, "claim", "claims")} the shop could not back`);
  if (counts.supporting === 0) reasons.push("nothing verified in the answer's favour, so at most 3");
  return reasons.length === 0 ? `${rating}/5` : `${rating}/5  (${reasons.join("; ")})`;
}

function ratingRows(onChain: RatingPost | null, jobId: string, rail: PaymentRail["kind"]): string[] {
  const row = (name: string, value: string): string => `${name.padEnd(STATUS)}${value}`;
  if (onChain === null) {
    const why = rail === "mock" ? "because the mock rail has no chain" : "because this rail keeps no rating on chain";
    return [row("kept", `in this machine's ledger, ${why}`)];
  }
  switch (onChain.kind) {
    case "posted":
      return [
        row("on chain", `SocialDB ${onChain.contract}, written by the buyer bot under its own account`),
        row("key", onChain.key),
        row("tx", txUrl(onChain.tx)),
      ];
    case "pending":
      return [row("on chain", `not yet: ${onChain.detail}`), row("", `the rating is in the local ledger. Run: npx inferpay resume ${jobId}`)];
    case "failed":
      return [row("on chain", `not posted: ${onChain.reason}`)];
    default: {
      const unreachable: never = onChain;
      return unreachable;
    }
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const STATUS = 10;
const VERDICT = 14;

export function checksBlock(checks: readonly BuyerCheck[], pinned: PinnedCommitment, rail: PaymentRail["kind"]): string[] {
  if (checks.length === 0) return [line("checks", "none: the shop sent nothing to verify")];
  const counts = tally(checks);
  const headline = [`${counts.verified} of ${checks.length} verified by the buyer against the shop's committed root`];
  if (counts.unproven > 0) headline.push(`${counts.unproven} unproven`);
  if (counts.forged > 0) headline.push(`${counts.forged} FORGED`);
  const width = checks.reduce((max, check) => Math.max(max, checkLabel(check).length), 0) + 2;
  return [
    line("checks", headline.join(", ")),
    ...checks.flatMap((check) => checkRows(check, width)).map((row) => line("", row)),
    ...commitmentRows(pinned, rail).map((row) => line("", row)),
  ];
}

function checkLabel(check: BuyerCheck): string {
  if (check.status === "verified") return check.claim.label;
  return check.check.claim.label;
}

function checkRows(check: BuyerCheck, width: number): string[] {
  const head = (status: string, verdict: string, rest: string): string => (
    `${status.padEnd(STATUS)}${verdict.padEnd(VERDICT)}${checkLabel(check).padEnd(width)}${rest}`.trimEnd()
  );
  const under = (text: string): string => `${"".padEnd(STATUS)}${text}`;
  if (check.status === "unproven") {
    return [head("unproven", check.check.verdict, claimedText(check.check)), under(unprovenText(check))];
  }
  if (check.status === "forged") {
    return [head("FORGED", check.check.verdict, claimedText(check.check)), under(forgeryText(check.forgery, check.check))];
  }
  if (check.verdict === "absent") {
    const claimed = check.kind === "number" ? formatFigure(check.claim.claimed, check.claim.unit) : check.kind === "fact" ? check.claim.claimed : "";
    return [head("verified", "no entry", claimed), under("the slot for this key in the shop's committed tree is empty: the shop holds nothing on it")];
  }
  if (check.kind === "flag") {
    if (check.verdict === "raised") return [head("verified", "raised", ""), under(check.entry.detail)];
    return [head("verified", "clear", ""), under(`the playbook rule ${check.entry.id} does not apply to "${check.claim.text}"`)];
  }
  if (check.kind === "fact") {
    const ref = check.verdict === "mismatch" ? `   ref ${check.entry.value}` : "";
    return [head("verified", check.verdict, `${check.claim.claimed}${ref}`), under(check.entry.source)];
  }
  const claimed = formatFigure(check.claim.claimed, check.claim.unit);
  if (check.verdict === "match") return [head("verified", check.verdict, claimed), under(check.entry.source)];
  const signed = check.deltaPct < 0 ? check.deltaPct.toFixed(2) : `+${check.deltaPct.toFixed(2)}`;
  return [
    head("verified", check.verdict, `${claimed}   ref ${formatFigure(check.entry.value, check.entry.unit)} (${signed}%)`),
    under(check.entry.source),
  ];
}

function claimedText(check: AssertedCheck): string {
  if (check.kind === "number") return formatFigure(check.claim.claimed, check.claim.unit);
  if (check.kind === "fact") return check.claim.claimed;
  return "";
}

function unprovenText(check: Extract<BuyerCheck, { status: "unproven" }>): string {
  if (check.why === "no-commitment") return "the shop's word only: it has published no root to check this against";
  if (check.why === "unquoted") return "the rule is real, but the clause is not quoted from the question, so it shows nothing about what was asked";
  if (check.check.kind === "flag") return "the shop's word only: it says no playbook rule matched, and that carries no proof";
  return "the shop's word only: it sent no proof that it holds no entry for this";
}

function forgeryText(forgery: Forgery, check: AssertedCheck): string {
  switch (forgery.kind) {
    case "no-evidence":
      return `the shop said ${check.verdict} and sent no evidence`;
    case "wrong-root":
      return `the shop said ${check.verdict}, but its evidence does not open to the committed root`;
    case "wrong-entry":
      return `the shop said ${check.verdict}, but the entry it proved is not about this claim`;
    case "wrong-verdict":
      return `the shop said ${check.verdict}, but the entry it proved gives ${forgery.recomputed}`;
    default: {
      const unreachable: never = forgery;
      return unreachable;
    }
  }
}

function commitmentRows(pinned: PinnedCommitment, rail: PaymentRail["kind"]): string[] {
  const row = (name: string, value: string): string => `${name.padEnd(STATUS)}${value}`;
  if (pinned.status === "missing") {
    return [row("root", `none: ${pinned.account} has published no commitment in SocialDB ${pinned.contract}`)];
  }
  const { commitment, source } = pinned;
  const root = row("root", `${shortHash(commitment.root)}  ${plural(commitment.leaves, "leaf", "leaves")}  ${commitment.scheme}`);
  if (source.kind === "listing") {
    const why = rail === "mock" ? "because the mock rail has no chain" : "because this rail publishes no commitment";
    return [root, row("from", `the shop's listing, ${why}`)];
  }
  return [
    root,
    row("from", `NEAR testnet, written at block ${source.block} and read before paying`),
    row("key", `${commitmentKey(source.account)} in SocialDB ${source.contract}`),
    row("link", accountUrl(source.account)),
  ];
}

function pinnedRows(pinned: PinnedCommitment): string[] {
  if (pinned.status === "missing") return [`commitment none on chain for ${pinned.account}`];
  const { commitment, source } = pinned;
  const from = source.kind === "listing"
    ? "from the shop's listing"
    : `from ${commitmentKey(source.account)} in SocialDB ${source.contract}, block ${source.block}`;
  return [`commitment ${commitment.root}`, `           ${plural(commitment.leaves, "leaf", "leaves")}, ${commitment.scheme}, ${from}`];
}

// Every value a reader needs to recompute the leaf and walk it to the root by hand.
function proofRows(check: BuyerCheck): string[] {
  if (check.status === "verified") {
    const key = check.verdict === "absent" ? claimKey(check) : entryKey(check.entry);
    const evidence: Evidence = check.verdict === "absent" ? { vacant: true, path: check.path } : check;
    return [
      `verified  ${check.verdict === "absent" ? "no entry" : check.verdict}  ${checkLabel(check)}`,
      ...evidenceRows(key, evidence),
      "  root      equals the commitment above",
    ];
  }
  const rows = [`${check.status === "forged" ? "FORGED" : "unproven"}  ${check.check.verdict}  ${checkLabel(check)}`];
  rows.push(`  ${check.status === "forged" ? forgeryText(check.forgery, check.check) : unprovenText(check)}`);
  const { evidence } = check.check;
  if (evidence !== null) rows.push(...evidenceRows("vacant" in evidence ? claimKey(check.check) : entryKey(evidence.entry), evidence));
  if (check.status === "forged" && check.forgery.kind === "wrong-root") rows.push(`  opens to  ${check.forgery.opensTo ?? "nothing: the path is not a full path"}`);
  return rows;
}


function evidenceRows(key: Key, evidence: Evidence): string[] {
  const siblings = evidence.path.flatMap((hash, level) => (hash === null ? [] : [`  ${`level ${level}`.padEnd(10)}${hash}`]));
  const leaf = "vacant" in evidence
    ? ["  leaf      empty slot"]
    : [`  entry     ${canonical(evidence.entry)}`, `  salt      ${evidence.salt}`, `  leaf      ${leafHash(evidence.entry, evidence.salt)}`];
  return [
    `  key       ${canonical(key)}`,
    `  slot      ${slotOf(key)}`,
    ...leaf,
    ...siblings,
    `  path      ${evidence.path.length} levels, ${evidence.path.length - siblings.length} of them empty subtrees`,
  ];
}

function shortHash(hash: Hash): string {
  return `${hash.slice(0, 12)}…${hash.slice(-4)}`;
}

function formatFigure(value: number, unit: string): string {
  const tokens = unit.trim().split(/\s+/).filter((token) => token.length > 0);
  const scales = new Set(["k", "m", "b", "t"]);
  const scale = tokens.filter((token) => scales.has(token.toLowerCase())).join("").toUpperCase();
  const base = tokens.filter((token) => !scales.has(token.toLowerCase())).join(" ");
  const shown = Number.isInteger(value) ? value.toFixed(1) : String(value);
  return `${shown}${scale} ${base}`.trim();
}

function line(label: string, rest: string): string {
  return `${label.padEnd(10)}${rest}`;
}

function table(rows: readonly (readonly string[])[]): string {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths = Array.from({ length: width }, (_, index) => (
    rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), 0)
  ));
  return rows.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd()).join("\n");
}

export function taskProgressLine(progress: TaskProgress, rail: PaymentRail["kind"]): string {
  switch (progress.step) {
    case "plan":
      return planBlock(progress);
    case "part":
      return [
        "",
        line(`part ${progress.index + 1}/${progress.count}`, progress.part.question),
        field("allot", `${money(progress.base)} share + ${money(progress.carried)} carried = ${money(progress.allotted)}`),
      ].join("\n");
    case "part-done":
      return partDoneRows(progress).join("\n");
    default:
      return progressLine(progress, rail);
  }
}

function planBlock(progress: Extract<TaskProgress, { step: "plan" }>): string {
  const { budget, parts, bases } = progress;
  const rows = parts.map((part, index) => [
    String(index + 1),
    `${part.share}%`,
    bases[index] === undefined ? "" : money(bases[index]),
    part.question,
  ]);
  return [
    line("plan", `${plural(parts.length, "part", "parts")} under one budget of ${money(budget)}, each given its share of it`),
    ...table(rows).split("\n").map((row) => line("", row)),
    field("carry", "parts run in order, and what a part leaves unspent is added to the next part's allotment,"),
    field("", `so a cheap part can fund a dearer one and the task never pays more than ${money(budget)}`),
  ].join("\n");
}

function partDoneRows(progress: Extract<TaskProgress, { step: "part-done" }>): string[] {
  const { row, index, count } = progress;
  const rows: string[] = [];
  if (row.outcome.kind === "answered-locally") rows.push(localAnswerText(row.outcome.answer));
  if (row.outcome.kind === "failed") rows.push(line("failed", failureText(row.outcome.reason)));
  const unspent = toUnits(row.allotted.amount) - toUnits(row.spent.amount);
  const where = index + 1 < count ? `carried to part ${index + 2}` : "kept: this was the last part";
  rows.push(line("unspent", `${money(row.allotted)} - ${money(row.spent)} spent = ${formatUnits(unspent)} ${row.allotted.symbol}, ${where}`));
  return rows;
}

export function receiptBlock(receipt: Receipt, saved: string): string {
  const header = ["#", "DONE BY", "LIST", "PAID", "CHECK"];
  const cells = receipt.parts.map((row, index) => [String(index + 1), ...receiptCells(row)]);
  const [head, ...lines] = table([header, ...cells]).split("\n");
  const pad = "".padEnd(String(receipt.parts.length).length + 2);
  const detail = (name: string, value: string): string => line("", `${pad}${name.padEnd(7)}${value}`);
  return [
    line("receipt", receipt.taskId),
    field("task", receipt.task),
    line("", head ?? ""),
    ...receipt.parts.flatMap((row, index) => [
      line("", lines[index] ?? ""),
      detail("asked", row.part.question),
      ...receiptDetails(row).map(([name, value]) => detail(name, value)),
    ]),
    line("total", `spent ${money(receipt.spent)} of the ${money(receipt.budget)} budget, ${money(receipt.left)} left`),
    line("saved", saved),
  ].join("\n");
}

function receiptCells(row: ReceiptRow): [string, string, string, string] {
  const { outcome, spent } = row;
  const paid = toUnits(spent.amount) === 0n ? "nothing" : money(spent);
  switch (outcome.kind) {
    case "bought":
      return [
        outcome.account,
        outcome.listPrice.amount,
        `${money(spent)} ${outcome.negotiation === "list-price" ? "at list" : "on counter"}`,
        boughtCheck(outcome),
      ];
    case "answered-locally":
      return ["the buyer itself", "-", paid, `own answer, confidence ${share(outcome.confidence)}`];
    case "declined":
      return ["nobody", "-", paid, `declined: ${declineText(outcome.because)}`];
    case "pending":
      return ["-", "-", `${paid} held`, "PENDING: payment not settled"];
    case "failed":
      return ["-", "-", paid, "FAILED"];
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

function receiptDetails(row: ReceiptRow): (readonly [string, string])[] {
  const { outcome } = row;
  switch (outcome.kind) {
    case "bought":
      return outcome.tx === null ? [["job", outcome.jobId]] : [["job", outcome.jobId], ["tx", txUrl(outcome.tx)]];
    case "pending":
      return [["job", outcome.jobId], ["resume", `npx inferpay resume ${outcome.jobId}`]];
    case "failed":
      return [["why", failureText(outcome.reason).split("\n")[0] ?? ""]];
    default:
      return [];
  }
}

function boughtCheck(outcome: Extract<PartOutcome, { kind: "bought" }>): string {
  const parts = [`${outcome.verified} verified`];
  if (outcome.mismatches > 0) parts.push(plural(outcome.mismatches, "mismatch", "mismatches"));
  if (outcome.unproven > 0) parts.push(`${outcome.unproven} unproven`);
  if (outcome.forged > 0) parts.push(`${outcome.forged} FORGED`);
  return `${parts.join(", ")}; rated ${outcome.stars}/5`;
}

function declineText(because: NoDeal["kind"]): string {
  switch (because) {
    case "nothing-affordable":
      return "every ask above its allotment";
    case "no-coverage":
      return "no shop covers it";
    case "no-price-worth-paying":
      return "no price worth paying";
    case "counter-refused":
      return "counter-offer refused";
    default: {
      const unreachable: never = because;
      return unreachable;
    }
  }
}
