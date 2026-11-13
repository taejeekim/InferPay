import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { credentialsDir } from "../config.ts";
import type { Hash } from "../commitment/index.ts";
import { parseParentAccount, type AccountId, type ParentAccount } from "../domain.ts";
import { accountUrl, txUrl } from "../near/explorer.ts";
import { formatNear, nearOf } from "../payment/units.ts";
import { PROVIDERS } from "../providers/index.ts";
import { resolveRoster, type Roster } from "../roster.ts";

// Funding out of the faucet's 10 NEAR. A native NEAR transfer needs a full-access key, so a bot's on-chain spend
// cap is its own sub-account balance: the owner funds it with a small amount and it cannot spend more than that.
export const FUNDING = {
  bot: nearOf("0.6"),
  shop: nearOf("0.05"),
  personKeeps: nearOf("0.1"),
} as const;

// A create-account transaction burned about 0.0072 NEAR of gas on testnet in November 2026.
const GAS_PER_CREATE = nearOf("0.01");

export type TreeNode = {
  readonly account: AccountId;
  readonly parent: AccountId | null;
  readonly deposit: bigint;
  readonly depth: number;
};

export function accountTree(roster: Roster): readonly TreeNode[] {
  const rows = roster.forest();
  const persons = [...new Set(rows.map((row) => row.parent))];
  const nodes: TreeNode[] = [{ account: roster.root, parent: null, deposit: 0n, depth: 0 }];
  for (const person of persons) {
    const children = rows.filter((row) => row.parent === person);
    const childDeposit = (role: string): bigint => (role === "specialist" ? FUNDING.shop : FUNDING.bot);
    const deposit = children.reduce((sum, row) => sum + childDeposit(row.role), FUNDING.personKeeps);
    nodes.push({ account: person, parent: roster.root, deposit, depth: 1 });
    for (const row of children) nodes.push({ account: row.account, parent: person, deposit: childDeposit(row.role), depth: 2 });
  }
  return nodes;
}

export type Observed =
  | { readonly exists: false; readonly savedKey: boolean }
  | { readonly exists: true; readonly balance: bigint; readonly savedKey: "none" | "matches" | "mismatch" };

export type SetupStep =
  | { readonly kind: "faucet"; readonly account: AccountId; readonly key: "saved" | "new" }
  | { readonly kind: "create"; readonly account: AccountId; readonly parent: AccountId; readonly deposit: bigint; readonly key: "saved" | "new" }
  | { readonly kind: "verified"; readonly account: AccountId };

export type SetupPlan =
  | { readonly ok: true; readonly steps: readonly SetupStep[] }
  | { readonly ok: false; readonly problems: readonly string[] };

export function planSetup(tree: readonly TreeNode[], observed: ReadonlyMap<AccountId, Observed>, keysDir: string): SetupPlan {
  const steps: SetupStep[] = [];
  const problems: string[] = [];
  for (const node of tree) {
    const seen: Observed = observed.get(node.account) ?? { exists: false, savedKey: false };
    if (!seen.exists) {
      const key = seen.savedKey ? "saved" : "new";
      if (node.parent === null) steps.push({ kind: "faucet", account: node.account, key });
      else steps.push({ kind: "create", account: node.account, parent: node.parent, deposit: node.deposit, key });
      continue;
    }
    if (seen.savedKey === "none") problems.push(`${node.account} exists but ${keysDir} has no key for it`);
    else if (seen.savedKey === "mismatch") problems.push(`${node.account} exists but the key saved in ${keysDir} is not one of its access keys`);
    else steps.push({ kind: "verified", account: node.account });
  }
  for (const node of tree) {
    const seen = observed.get(node.account);
    if (seen === undefined || !seen.exists) continue;
    const owed = steps.reduce(
      (sum, step) => (step.kind === "create" && step.parent === node.account ? sum + step.deposit + GAS_PER_CREATE : sum),
      0n,
    );
    if (owed === 0n) continue;
    if (seen.balance < owed) {
      problems.push(`${node.account} holds ${formatNear(seen.balance)} NEAR and needs ${formatNear(owed)} NEAR to fund the accounts still missing under it`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, steps };
}

export function freshRoot(): ParentAccount {
  const root = parseParentAccount(`inferpay-${randomBytes(4).toString("hex")}.testnet`);
  if (!root) throw new Error("fresh root failed its check");
  return root;
}

export function chooseRoot(argv: readonly string[], env: NodeJS.ProcessEnv): { root: ParentAccount; source: string } | { error: string } {
  const flag = argv.indexOf("--root");
  if (flag >= 0) {
    const raw = argv[flag + 1] ?? "";
    const root = parseParentAccount(raw);
    if (!root || !root.endsWith(".testnet")) return { error: `--root needs a testnet account such as inferpay.testnet, got "${raw}"` };
    return { root, source: "--root" };
  }
  const recorded = env.INFERPAY_PAYMENT === "near-testnet" ? parseParentAccount(env.INFERPAY_ROOT_ACCOUNT ?? "") : null;
  if (recorded && recorded.endsWith(".testnet")) return { root: recorded, source: ".env (finishing the tree it records)" };
  return { root: freshRoot(), source: "new through the testnet faucet" };
}

export function updateEnvText(text: string, values: Readonly<Record<string, string>>): { text: string; changed: readonly string[] } {
  const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
  const changed: string[] = [];
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const name = match?.[1];
    if (name === undefined || !(name in values)) {
      out.push(line);
      continue;
    }
    if (done.has(name)) continue;
    done.add(name);
    const next = `${name}=${values[name]}`;
    if (line !== next) changed.push(next);
    out.push(next);
  }
  for (const [name, value] of Object.entries(values)) {
    if (done.has(name)) continue;
    changed.push(`${name}=${value}`);
    out.push(`${name}=${value}`);
  }
  return { text: `${out.join("\n")}\n`, changed };
}

export async function testnetCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv[0] !== "setup") {
    process.stderr.write("inferpay testnet setup [--root <name>.testnet]\n");
    return 2;
  }
  const chosen = chooseRoot(argv.slice(1), env);
  if ("error" in chosen) {
    process.stderr.write(`${chosen.error}\n`);
    return 2;
  }
  const resolved = resolveRoster(chosen.root);
  if (!resolved.ok) {
    process.stderr.write(`${resolved.detail}\n`);
    return 2;
  }
  const near = await import("../near/client.ts");
  const client = near.createNearClient();
  const keysDir = credentialsDir(env);
  const tree = accountTree(resolved.roster);
  const say = (label: string, rest: string): void => {
    process.stdout.write(`${label.padEnd(10)}${rest}\n`);
  };
  say("root", `${chosen.root}  (${chosen.source})`);
  say("keys", keysDir);

  const observed = new Map<AccountId, Observed>();
  for (const node of tree) {
    const credential = await near.loadCredential(keysDir, node.account);
    const balance = await client.balance(node.account);
    if (balance === null) {
      observed.set(node.account, { exists: false, savedKey: credential !== null });
      continue;
    }
    let savedKey: "none" | "matches" | "mismatch" = "none";
    if (credential !== null) savedKey = await client.hasKey(node.account, credential.publicKey) ? "matches" : "mismatch";
    observed.set(node.account, { exists: true, balance, savedKey });
  }
  const plan = planSetup(tree, observed, keysDir);
  if (!plan.ok) {
    for (const problem of plan.problems) say("problem", problem);
    return 1;
  }
  const toCreate = plan.steps.filter((step) => step.kind !== "verified").length;
  say("plan", `${toCreate} to create, ${plan.steps.length - toCreate} already exist with the saved key`);

  const transactions: { what: "create" | "commit"; account: AccountId; hash: string }[] = [];
  for (const step of plan.steps) {
    if (step.kind === "verified") continue;
    const credential = step.key === "saved" ? await near.loadCredential(keysDir, step.account) : near.newCredential(step.account);
    if (credential === null) throw new Error(`the key for ${step.account} disappeared from ${keysDir}`);
    // The key is on disk before the account exists, so a crash here leaves a key the next run reuses.
    if (step.key === "new") await near.saveCredential(keysDir, credential);
    if (step.kind === "faucet") {
      await client.createWithFaucet(step.account, credential.publicKey);
      await waitForAccount(client, step.account);
      say("faucet", `${step.account}  created with the faucet's 10 NEAR`);
      await recordEnv(chosen.root, say);
      continue;
    }
    const parent = await near.loadCredential(keysDir, step.parent);
    if (parent === null) throw new Error(`no key for ${step.parent} in ${keysDir}`);
    const sent = await client.send(parent, step.account, [
      near.actions.createAccount(),
      near.actions.transfer(step.deposit),
      near.actions.addFullAccessKey(credential.keyPair.getPublicKey()),
    ]);
    if (sent.result.kind !== "success") {
      throw new Error(`creating ${step.account} did not finish (${sent.result.kind}${"reason" in sent.result ? `: ${sent.result.reason}` : ""}). Run setup again; it resumes here.`);
    }
    transactions.push({ what: "create", account: step.account, hash: sent.tx.hash });
    say("create", `${step.account}  ${formatNear(step.deposit)} NEAR from ${step.parent}  tx ${sent.tx.hash}`);
  }
  await recordEnv(chosen.root, say);

  const { publishCommitments } = await import("../registry/chain.ts");
  const shops = PROVIDERS.flatMap((provider) => {
    const seat = resolved.roster.shop(provider.describe.id);
    return seat === null ? [] : [{ account: seat.account, parent: seat.parent, declared: provider.commitment() }];
  });
  await publishCommitments({ chain: client, credential: (account) => near.loadCredential(keysDir, account) }, shops, (step) => {
    const root = `root ${shortRoot(step.commitment.root)}`;
    if (step.kind === "current") {
      say("commit", `${step.account.padEnd(36)}${root}  already on chain since block ${step.block}`);
      return;
    }
    if (step.toppedUp > 0n) say("fund", `${step.account}  ${formatNear(step.toppedUp)} NEAR from its owner for the SocialDB deposit`);
    say("commit", `${step.account.padEnd(36)}${root}  published, ${step.why === "missing" ? "none in this scheme was on chain" : "the root changed"}`);
    // Printed as each one lands, so a run that stops at a later shop still shows what it sent.
    say("", txUrl(step.hash));
    transactions.push({ what: "commit", account: step.account, hash: step.hash });
  });

  process.stdout.write("\n");
  for (const node of tree) {
    const balance = await client.balance(node.account);
    const name = `${"  ".repeat(node.depth)}${node.account}`;
    process.stdout.write(`${name.padEnd(48)}${`${formatNear(balance ?? 0n)} NEAR`.padEnd(14)}${accountUrl(node.account)}\n`);
  }
  if (transactions.length > 0) {
    process.stdout.write("\nsetup transactions\n");
    for (const tx of transactions) process.stdout.write(`  ${tx.what} ${tx.account.padEnd(44)}${txUrl(tx.hash)}\n`);
  }
  process.stdout.write(`\nspend cap: a native NEAR transfer needs a full-access key, so each bot's on-chain spend cap is its own sub-account balance (${formatNear(FUNDING.bot)} NEAR at setup). It cannot spend more than that; the owner tops it up to raise the cap.\n`);
  return 0;
}

function shortRoot(root: Hash): string {
  return `${root.slice(0, 12)}…${root.slice(-4)}`;
}

async function recordEnv(root: ParentAccount, say: (label: string, rest: string) => void): Promise<void> {
  let text = "";
  try {
    text = await readFile(".env", "utf8");
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
  const next = updateEnvText(text, { INFERPAY_PAYMENT: "near-testnet", INFERPAY_ROOT_ACCOUNT: root });
  if (next.changed.length === 0) return;
  await writeFile(".env", next.text);
  for (const line of next.changed) say(".env", `wrote ${line}`);
}

async function waitForAccount(client: { balance(id: AccountId): Promise<bigint | null> }, account: AccountId): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await client.balance(account) !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${account} did not appear on testnet within 30 seconds. Run setup again.`);
}
