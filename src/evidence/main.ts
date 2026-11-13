import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseParentAccount } from "../domain.ts";
import { PROVIDERS } from "../providers/index.ts";
import { resolveRoster } from "../roster.ts";
import { matchCommitment, matchRating, matchRatingTx, matchTransfer, type Row } from "./match.ts";

type Records = {
  readonly network: string;
  readonly root: string;
  readonly rpcs: readonly string[];
  readonly socialDb: string;
  readonly transfers: readonly { what: string; hash: string; signer: string; receiver: string; near: string }[];
  readonly ratings: readonly { hash: string; rater: string; jobId: string; shop: string; stars: number; payment: string }[];
};

const records = JSON.parse(readFileSync(fileURLToPath(new URL("./records.json", import.meta.url)), "utf8")) as Records;

// A node that is busy or rate-limiting answers with an HTTP error or a body with neither a result nor a known
// "this does not exist" error. That says nothing about the chain, so the next node is asked instead of
// reporting a mismatch.
const ABSENT = new Set(["UNKNOWN_TRANSACTION", "UNKNOWN_ACCOUNT"]);

async function rpc(method: string, params: unknown): Promise<unknown> {
  const failures: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const url of records.rpcs) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          failures.push(`${url} answered HTTP ${response.status}`);
          continue;
        }
        const body = (await response.json()) as { result?: unknown; error?: { cause?: { name?: string } } };
        if (body.result !== undefined) return body.result;
        if (ABSENT.has(body.error?.cause?.name ?? "")) return null;
        failures.push(`${url} answered ${JSON.stringify(body.error).slice(0, 120)}`);
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  throw new Error(`no RPC node answered, so nothing was compared.\n  ${[...new Set(failures)].join("\n  ")}`);
}

function tx(hash: string, signer: string): Promise<unknown> {
  return rpc("tx", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" });
}

async function socialGet(keys: readonly string[]): Promise<unknown> {
  const result = (await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: records.socialDb,
    method_name: "get",
    args_base64: Buffer.from(JSON.stringify({ keys })).toString("base64"),
  })) as { result?: number[] } | null;
  if (!result?.result) return null;
  return JSON.parse(Buffer.from(result.result).toString("utf8"));
}

async function accountExists(account: string): Promise<boolean> {
  return (await rpc("query", { request_type: "view_account", finality: "final", account_id: account })) !== null;
}

async function collect(): Promise<Row[]> {
  const root = parseParentAccount(records.root);
  if (!root) throw new Error(`${records.root} is not a root account`);
  const resolved = resolveRoster(root);
  if (!resolved.ok) throw new Error(resolved.detail);
  const roster = resolved.roster;
  const rows: Row[] = [];

  const accounts = [records.root, ...new Set(roster.forest().flatMap((row) => [row.parent, row.account]))];
  const missing: string[] = [];
  for (const account of accounts) if (!(await accountExists(account))) missing.push(account);
  rows.push({
    kind: "accounts",
    what: `${accounts.length} named accounts exist under ${records.root}`,
    ok: missing.length === 0,
    detail: missing.length === 0 ? "all found" : `missing ${missing.join(", ")}`,
  });

  for (const transfer of records.transfers) rows.push(matchTransfer(transfer, await tx(transfer.hash, transfer.signer)));

  for (const provider of PROVIDERS) {
    const shop = roster.shop(provider.describe.id);
    if (!shop) throw new Error(`${provider.describe.id} has no shop account`);
    const onChain = await socialGet([`${shop.account}/inferpay/commitment`]);
    rows.push(matchCommitment(shop.account, provider.commitment(), onChain));
  }

  for (const rating of records.ratings) {
    rows.push(matchRatingTx(rating, records.socialDb, await tx(rating.hash, rating.rater)));
    rows.push(matchRating(rating, await socialGet([`${rating.rater}/inferpay/ratings/${rating.jobId}`])));
  }
  return rows;
}

let rows: Row[];
try {
  rows = await collect();
} catch (error) {
  process.stderr.write(`evidence: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
const failed = rows.filter((row) => !row.ok);
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ network: records.network, root: records.root, rows }, null, 2)}\n`);
} else {
  process.stdout.write(`evidence: every record below is re-read from ${records.network} by RPC\n\n`);
  for (const row of rows) {
    process.stdout.write(`${row.ok ? "match   " : "MISMATCH"}  ${row.kind.padEnd(10)}  ${row.what}\n`);
    process.stdout.write(`${" ".repeat(22)}${row.detail}\n`);
  }
  process.stdout.write(`\n${rows.length - failed.length} of ${rows.length} records match the chain\n`);
}
if (failed.length > 0) process.exitCode = 1;
