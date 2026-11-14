// Reads InferPay's state from NEAR testnet with plain JSON-RPC, so the same module runs in a browser and in Node
// (src/site/read-chain.ts). The account layout follows src/roster.ts and the SocialDB keys src/registry/keys.ts.

import { reputationQuality } from "./decide.js";
import { isHash } from "./scheme.js";

export const RPC = "https://test.rpc.fastnear.com";
export const SOCIAL_DB = "v1.social08.testnet";
export const DEFAULT_ROOT = "inferpay.testnet";

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const JOB_ID = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
const BOTS = ["researcher", "writer", "trader", "analyst", "clerk", "scout", "editor", "buyer", "reviewer", "assistant"];
const SHOPS = [
  { person: "stella", providerId: "legal" },
  { person: "ban", providerId: "insurance" },
  { person: "david", providerId: "disclosure" },
];

export function isAccountId(value) {
  return typeof value === "string" && value.length >= 2 && value.length <= 64 && ACCOUNT_ID.test(value);
}

// Every account under a root, or the first name that is not a valid account id.
export function rosterOf(root) {
  const names = [`kyle.${root}`, ...BOTS.map((bot) => `${bot}.kyle.${root}`), ...SHOPS.flatMap((shop) => [`${shop.person}.${root}`, `${shop.providerId}.${shop.person}.${root}`])];
  const bad = isAccountId(root) && root.includes(".") ? names.find((name) => !isAccountId(name)) : root;
  if (bad !== undefined) return { ok: false, invalid: bad };
  return {
    ok: true,
    root,
    bots: BOTS.map((bot) => ({ bot, account: `${bot}.kyle.${root}`, defaultPayer: bot === "researcher" })),
    shops: SHOPS.map((shop) => ({ providerId: shop.providerId, account: `${shop.providerId}.${shop.person}.${root}` })),
  };
}

function nodeAt(raw, path) {
  let node = raw;
  for (const key of path) {
    if (!isNode(node)) return null;
    node = node[key];
  }
  return isNode(node) ? node : null;
}

function isNode(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leafAt(raw, path) {
  const node = nodeAt(raw, path);
  if (node === null || typeof node[""] !== "string" || typeof node[":block"] !== "number") return null;
  return { value: node[""], block: node[":block"] };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isCount = (value) => Number.isInteger(value) && value >= 0;

// A shop's commitment, or null where it published none or published something that is not one.
export function readCommitment(raw, account) {
  const leaf = leafAt(raw, [account, "inferpay", "commitment"]);
  const parsed = leaf === null ? null : parseJson(leaf.value);
  if (!isNode(parsed) || parsed.scheme !== "inferpay-keyed-merkle-sha256-v1" || !isHash(parsed.root)) return null;
  if (!Number.isInteger(parsed.leaves) || parsed.leaves <= 0) return null;
  return { scheme: parsed.scheme, root: parsed.root, leaves: parsed.leaves, block: leaf.block };
}

// Anyone can write anything under an account they hold, so a value that is not a rating is skipped.
export function readRatings(raw, raters) {
  const ratings = [];
  for (const rater of raters) {
    const jobs = nodeAt(raw, [rater, "inferpay", "ratings"]);
    if (jobs === null) continue;
    for (const jobId of Object.keys(jobs)) {
      const leaf = leafAt(jobs, [jobId]);
      const value = leaf === null ? null : parseJson(leaf.value);
      if (!JOB_ID.test(jobId) || !isNode(value)) continue;
      const { shop, stars, payment, root, verified, unproven, forged } = value;
      if (!isAccountId(shop) || ![1, 2, 3, 4, 5].includes(stars) || typeof payment !== "string") continue;
      if (!(root === null || isHash(root)) || !isCount(verified) || !isCount(unproven) || !isCount(forged)) continue;
      ratings.push({ jobId, rater, shop, stars, payment, root, verified, unproven, forged, block: leaf.block });
    }
  }
  return ratings;
}

// The reputation src/market computes from on-chain ratings, and the smoothed quality the buyer's decision uses.
export function reputationOf(ratings, shop) {
  const stars = ratings.filter((rating) => rating.shop === shop).map((rating) => rating.stars);
  const average = stars.length === 0 ? null : stars.reduce((sum, star) => sum + star, 0) / stars.length;
  return { ratings: stars.length, average, quality: reputationQuality({ ratings: stars.length, average: average ?? 0 }) };
}

export function formatNear(yocto, digits = 4) {
  const scale = 10n ** 24n;
  const fraction = (yocto % scale).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return fraction.length > 0 ? `${yocto / scale}.${fraction}` : `${yocto / scale}`;
}

async function rpc(fetcher, params) {
  const response = await fetcher(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "inferpay-site", method: "query", params }),
  });
  if (!response.ok) throw new Error(`${RPC} answered HTTP ${response.status}`);
  return response.json();
}

async function socialGet(fetcher, keys) {
  const args = btoa(JSON.stringify({ keys, options: { with_block_height: true } }));
  const reply = await rpc(fetcher, { request_type: "call_function", finality: "final", account_id: SOCIAL_DB, method_name: "get", args_base64: args });
  if (reply.error || !Array.isArray(reply.result?.result)) throw new Error(`SocialDB get failed: ${JSON.stringify(reply.error ?? reply.result?.error ?? reply)}`);
  return { value: JSON.parse(new TextDecoder().decode(Uint8Array.from(reply.result.result))), block: reply.result.block_height };
}

// A bot's balance in yoctoNEAR, or null when the account does not exist.
async function balanceOf(fetcher, account) {
  const reply = await rpc(fetcher, { request_type: "view_account", finality: "final", account_id: account });
  if (reply.result?.amount !== undefined) return BigInt(reply.result.amount);
  const cause = reply.error?.cause?.name;
  if (cause === "UNKNOWN_ACCOUNT" || /does not exist/.test(String(reply.result?.error ?? ""))) return null;
  throw new Error(`view_account ${account} failed: ${JSON.stringify(reply.error ?? reply)}`);
}

// One SocialDB read for every commitment and rating, and one view_account per bot, all at the final block.
export async function readState(roster, fetcher = fetch) {
  const raters = roster.bots.map((bot) => bot.account);
  const keys = [...roster.shops.map((shop) => `${shop.account}/inferpay/commitment`), ...raters.map((rater) => `${rater}/inferpay/ratings/*`)];
  const [social, balances] = await Promise.all([socialGet(fetcher, keys), Promise.all(raters.map((account) => balanceOf(fetcher, account)))]);
  // A rating's block is when the bot wrote it; the job id is a ULID, so it breaks a tie by when the job opened.
  const ratings = readRatings(social.value, raters).sort((a, b) => b.block - a.block || (a.jobId < b.jobId ? 1 : -1));
  return {
    root: roster.root,
    block: social.block,
    readAt: new Date().toISOString(),
    shops: roster.shops.map((shop) => ({ ...shop, commitment: readCommitment(social.value, shop.account), reputation: reputationOf(ratings, shop.account) })),
    bots: roster.bots.map((bot, index) => ({ ...bot, balance: balances[index] ?? null })),
    ratings,
  };
}
