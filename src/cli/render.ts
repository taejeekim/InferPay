import type { ConfigError } from "../config.ts";
import type { Decision, Progress } from "../consumer/index.ts";
import type { FailReason, JobView, Listing } from "../market/index.ts";
import type { NumberCheck } from "../providers/types.ts";

export function railsLine(rails: { readonly payment: string; readonly inference: string }): string {
  return `rails: payment=${rails.payment} inference=${rails.inference}`;
}

export function progressLine(progress: Progress): string {
  switch (progress.step) {
    case "decide":
      return line("decide", decisionText(progress.decision));
    case "pay":
      return line("pay", payText(progress));
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
    ["ID", "SPECIALTY", "PRICE", "JOBS", "RATING"],
    ...listings.map((listing) => [
      listing.id,
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
        return `${label}${time}  ${event.order.providerId}  quote ${event.quote.amount} ${event.quote.symbol}  budget ${event.order.budget.amount} ${event.order.budget.symbol}`;
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
    return `Payment configuration is partial. Present: ${error.present.join(", ")}. Missing: ${error.missing.join(", ")}. Set all four payment variables, or unset them to use the mock rail.`;
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
    "inferpay providers",
    "inferpay ask <question> --budget <amount>",
    "inferpay resume <jobId>",
    "inferpay job <jobId>",
  ].join("\n");
}

function decisionText(decision: Decision): string {
  if (decision.kind === "outsource") return `outsource to ${decision.providerId} (${decision.reason})`;
  if (decision.kind === "decline") return `declined. ${decision.reason}`;
  return `answer locally (${decision.reason})`;
}

function payText(progress: Extract<Progress, { step: "pay" }>): string {
  const where = `(job ${progress.jobId}, key ${progress.key}, correlation ${progress.correlationId ?? "none"})`;
  const flag = `transfer ${progress.transfer}`;
  if (progress.status === "uncertain") {
    return `uncertain ${where} ${flag}. Nothing was charged twice.`;
  }
  if (progress.status === "pending") return `pending ${where} ${flag}`;
  if (progress.status === "rejected") return `rejected ${where} ${flag}`;
  const money = `${progress.amount.amount} ${progress.amount.symbol} -> ${progress.recipient}`;
  return `settled ${money} ${where} ${flag}`;
}

function rateText(rating: number, checks: readonly NumberCheck[]): string {
  const mismatches = checks.filter((check) => check.verdict === "mismatch").length;
  if (mismatches === 0) return `${rating}/5`;
  return `${rating}/5 (${mismatches} of ${checks.length} figures needed correction)`;
}

function checkLines(checks: readonly NumberCheck[]): string[] {
  return checks.map((check, index) => line(index === 0 ? "checks" : "", checkText(check)));
}

function checkText(check: NumberCheck): string {
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
