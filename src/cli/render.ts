import type { ConfigError } from "../config.ts";
import { formatUnits, type Price } from "../domain.ts";
import type { ForestRow, Roster } from "../roster.ts";
import { LOCAL_FLOOR, type Decision, type Option, type PricedOption, type Progress } from "../consumer/index.ts";
import type { FailReason, JobView, Listing } from "../market/index.ts";
import type { Check } from "../providers/types.ts";
import type { PaymentRail } from "../payment/index.ts";
import { penalizes } from "../consumer/grade.ts";

export function railsLine(rails: { readonly payment: string; readonly inference: string }): string {
  return `rails: payment=${rails.payment} inference=${rails.inference}`;
}

export function progressLine(progress: Progress, rail: PaymentRail["kind"]): string {
  switch (progress.step) {
    case "decide":
      return decideBlock(progress.decision);
    case "pay":
      return payBlock(progress, rail);
    case "answer":
      return [line("answer", progress.answer.text), ...checkLines(progress.answer.checks)].join("\n");
    case "rate":
      return line("rate", rateText(progress.rating, progress.answer.checks));
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

export function providersTable(listings: readonly Listing[]): string {
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
  return table(rows);
}

export function jobText(view: JobView): string {
  return view.events.map((event) => {
    const time = `${event.at.slice(11, 19)} UTC`;
    const label = event.type.padEnd(18);
    switch (event.type) {
      case "opened":
        return `${label}${time}  ${event.order.providerId}  quote ${event.quote.amount} ${event.quote.symbol}  budget ${event.order.budget.amount} ${event.order.budget.symbol}  ${event.order.payFrom} -> ${event.payTo}`;
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
        return `${label}${time}  ${event.answer.checks.length} checks`;
      case "rated":
        return `${label}${time}  ${event.rating}/5`;
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
    "inferpay resume <jobId>",
    "inferpay job <jobId>",
  ].join("\n");
}

export function unknownBotText(roster: Roster, raw: string): string {
  const names = roster.forest().filter((row) => row.role !== "specialist").map((row) => row.bot);
  return `Unknown bot ${raw}. Kyle's bots: ${names.join(", ")}.`;
}

export function walletsTable(roster: Roster): string {
  const rows = [
    ["PERSON", "PARENT", "BOT", "ACCOUNT", "ROLE"],
    ...roster.forest().map((row) => [row.personId, row.parent, row.bot, row.account, roleLabel(row.role)]),
  ];
  return table(rows);
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

function decideBlock(decision: Decision): string {
  const { value, local } = decision;
  const idWidth = decision.options.reduce((max, option) => Math.max(max, option.providerId.length), 0) + 2;
  return [
    line("decide", headline(decision)),
    field("value", `${money(value)}, the budget: the most a right answer is worth`),
    field("local", `confidence ${share(local.confidence)} x value = worth ${near(local.worth)} ${value.symbol}`),
    field("missing", local.missing.length === 0 ? "nothing" : local.missing.join("; ")),
    ...decision.options.map((option) => field("option", optionText(option, idWidth, value))),
    ...ruleRows(decision),
  ].join("\n");
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
    field("via", rail === "mock" ? "mock receipt (no NEAR moved)" : "Intents grant"),
    field("job", progress.jobId),
  ];
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

function field(name: string, value: string): string {
  return line("", `${name.padEnd(8)}${value}`);
}

function rateText(rating: number, checks: readonly Check[]): string {
  const penalties = checks.filter(penalizes).length;
  if (penalties === 0) return `${rating}/5`;
  return `${rating}/5 (${penalties} of ${checks.length} checks needed correction)`;
}

function checkLines(checks: readonly Check[]): string[] {
  return checks.map((check, index) => line(index === 0 ? "checks" : "", checkText(check)));
}

function checkText(check: Check): string {
  if (check.kind === "flag") {
    const label = check.label.padEnd(26);
    if (check.verdict === "raised") return `raised    ${label}${check.detail}`;
    return `clear     ${label}${check.detail}`;
  }
  if (check.kind === "fact") {
    const label = check.label.padEnd(26);
    if (check.verdict === "match") return `match     ${label}${check.claimed}   (${check.source})`;
    if (check.verdict === "mismatch") {
      return `mismatch  ${label}${check.claimed}   ref ${check.reference} (${check.source})`;
    }
    return `unverifiable  ${label}${check.claimed}`;
  }
  const label = check.label.padEnd(26);
  const claimed = formatFigure(check.claimed, check.unit);
  if (check.verdict === "match") return `match     ${label}${claimed}   (${check.source})`;
  if (check.verdict === "mismatch") {
    const signed = check.deltaPct < 0 ? check.deltaPct.toFixed(2) : `+${check.deltaPct.toFixed(2)}`;
    return `mismatch  ${label}${claimed}   ref ${formatFigure(check.reference, check.unit)} (${signed}%)`;
  }
  return `unverifiable  ${label}${claimed}`;
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
