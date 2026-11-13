import type { ConfigError } from "../config.ts";
import type { ForestRow, Roster } from "../roster.ts";
import type { Decision, Progress } from "../consumer/index.ts";
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
      return `Quote ${reason.quote.amount} ${reason.quote.symbol} is above budget ${reason.budget.amount} ${reason.budget.symbol}.`;
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
  if (decision.kind === "outsource") {
    return [line("decide", `outsource to ${decision.providerId}`), field("why", decision.reason)].join("\n");
  }
  if (decision.kind === "decline") {
    return [line("decide", "declined"), field("why", decision.reason)].join("\n");
  }
  return [line("decide", "answer locally"), field("why", decision.reason)].join("\n");
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
