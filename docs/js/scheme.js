// The commitment scheme of src/commitment, byte for byte, on WebCrypto so it runs unchanged in a browser and in
// Node. src/site/scheme.test.ts holds it to the TypeScript implementation.

export const SCHEME = "inferpay-keyed-merkle-sha256-v1";
export const DEPTH = 32;

const LEAF = 0;
const NODE = 1;
const VACANT = 2;
const KEY = 3;
const HASH = /^[0-9a-f]{64}$/;
const utf8 = new TextEncoder();

export function isHash(value) {
  return typeof value === "string" && HASH.test(value);
}

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const fields = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`);
  return `{${fields.join(",")}}`;
}

export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(prefix, ...parts) {
  const length = 1 + parts.reduce((sum, part) => sum + part.length, 0);
  const message = new Uint8Array(length);
  message[0] = prefix;
  let offset = 1;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", message)));
}

export function factKey(of) {
  return ["fact", of.topic.toLowerCase()];
}

function words(value) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function figureKey(of) {
  return ["figure", words(of.company), words(of.period), words(of.metric)];
}

export function entryKey(entry) {
  if (entry.kind === "figure") return figureKey(entry);
  if (entry.kind === "fact") return factKey(entry);
  return ["rule", entry.id];
}

function sameKey(a, b) {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

export async function keyHash(key) {
  return sha256(KEY, utf8.encode(canonical(key)));
}

export async function slotOf(key) {
  return parseInt((await keyHash(key)).slice(0, 8), 16);
}

// A salt that is not 64 hex characters cannot have come from the shop, and its bytes would be ambiguous.
export async function leafHash(entry, salt) {
  if (!isHash(salt)) return null;
  return sha256(LEAF, hexToBytes(salt), utf8.encode(canonical(entry)));
}

export async function nodeHash(left, right) {
  return sha256(NODE, hexToBytes(left), hexToBytes(right));
}

let empties = null;

// emptyHashes()[level] is the hash of a subtree of that height with nothing in it.
export async function emptyHashes() {
  if (empties) return empties;
  const hashes = [await sha256(VACANT)];
  for (let level = 0; level < DEPTH; level += 1) hashes.push(await nodeHash(hashes[level], hashes[level]));
  empties = hashes;
  return hashes;
}

// Each step of the walk from a slot to the root, so a page can show the computation and not only its result.
// Null when the path is not a full path or a sibling is not a hash.
export async function walk(slot, leaf, path) {
  if (!Array.isArray(path) || path.length !== DEPTH || !Number.isInteger(slot) || slot < 0 || slot >= 2 ** DEPTH) return null;
  const empty = await emptyHashes();
  let node = leaf ?? empty[0];
  let index = slot;
  const steps = [];
  for (let level = 0; level < DEPTH; level += 1) {
    const given = path[level];
    if (given !== null && !isHash(given)) return null;
    const sibling = given ?? empty[level];
    const side = index % 2 === 0 ? "left" : "right";
    node = side === "left" ? await nodeHash(node, sibling) : await nodeHash(sibling, node);
    steps.push({ level, side, sibling, siblingEmpty: given === null, node });
    index = Math.floor(index / 2);
  }
  return { root: node, steps };
}

export async function rootFrom(slot, leaf, path) {
  return (await walk(slot, leaf, path))?.root ?? null;
}

export async function opensTo(key, evidence) {
  const leaf = evidence.vacant === true ? null : await leafHash(evidence.entry, evidence.salt);
  if (evidence.vacant !== true && leaf === null) return null;
  return rootFrom(await slotOf(key), leaf, evidence.path);
}

function stated(value) {
  return value.trim().toLowerCase().replace(/\s*(%|percent)$/, "").replace(/\s+/g, " ");
}

export function judgeFact(claim, entry) {
  return stated(entry.value) === stated(claim.claimed) ? "match" : "mismatch";
}

// The buyer's verification of one fact check, as src/consumer/verify.ts runs it. The result names the status the
// buyer prints and, for a forgery, which step failed.
export async function verifyFact(check, committed) {
  const { claim, verdict, evidence } = check;
  if (verdict === "unverifiable") {
    if (evidence === null || evidence.vacant !== true) return { status: "unproven", why: "no-proof" };
    const opened = await opensTo(factKey(claim), evidence);
    if (opened !== committed) return { status: "forged", forgery: "wrong-root", opened };
    return { status: "verified", verdict: "absent", opened };
  }
  if (evidence === null || evidence.vacant === true) return { status: "forged", forgery: "no-evidence" };
  const { entry } = evidence;
  if (entry?.kind !== "fact" || typeof entry.topic !== "string" || !sameKey(factKey(claim), factKey(entry))) {
    return { status: "forged", forgery: "wrong-entry" };
  }
  const opened = await opensTo(entryKey(entry), evidence);
  if (opened !== committed) return { status: "forged", forgery: "wrong-root", opened };
  const recomputed = judgeFact(claim, entry);
  if (recomputed !== verdict) return { status: "forged", forgery: "wrong-verdict", recomputed, opened };
  return { status: "verified", verdict: recomputed, opened };
}
