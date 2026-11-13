import { createHash } from "node:crypto";
import type { Brand } from "../domain.ts";

export type Hash = Brand<string, "Hash">;

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

// One sibling for each level, from the leaf up. Null stands for an empty subtree, whose hash anyone can compute.
export type Path = readonly (Hash | null)[];

export type Tree = {
  readonly root: Hash;
  path(slot: number): Path;
};

// Every key owns one of 2^32 slots, so a tree can hold at most one entry for a key and an empty slot proves the
// key has none. The path to a slot is always this long.
export const DEPTH = 32;

const HASH = /^[0-9a-f]{64}$/;
// A leaf, an inner node, an empty slot, and a key each hash under their own prefix, so none can pass for another.
const LEAF = Uint8Array.of(0);
const NODE = Uint8Array.of(1);
const VACANT = Uint8Array.of(2);
const KEY = Uint8Array.of(3);

export function isHash(value: string): value is Hash {
  return HASH.test(value);
}

export function parseHash(raw: string): Hash | null {
  return isHash(raw) ? raw : null;
}

// Keys sort, so two parties that hold the same value always hash the same bytes.
export function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as { readonly [key: string]: Json };
  const fields = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key] ?? null)}`);
  return `{${fields.join(",")}}`;
}

export function leafHash(entry: Json, salt: Hash): Hash {
  return sha256(LEAF, Buffer.from(salt, "hex"), Buffer.from(canonical(entry), "utf8"));
}

// The first four bytes of the key's hash. Both sides compute it, so a shop cannot choose where an entry sits.
export function slotOf(key: Json): number {
  return Buffer.from(sha256(KEY, Buffer.from(canonical(key), "utf8")), "hex").readUInt32BE(0);
}

// EMPTY[level] is the hash of a subtree of that height with nothing in it.
const EMPTY: readonly Hash[] = (() => {
  const hashes = [sha256(VACANT)];
  for (let level = 0; level < DEPTH; level += 1) {
    const below = hashes[level];
    if (below === undefined) throw new Error("empty subtree hash is missing");
    hashes.push(nodeHash(below, below));
  }
  return hashes;
})();

export function buildTree(leaves: ReadonlyMap<number, Hash>): Tree {
  if (leaves.size === 0) throw new Error("a commitment needs at least one entry");
  const levels: Map<number, Hash>[] = [new Map(leaves)];
  for (let level = 0; level < DEPTH; level += 1) {
    const below = levels[level] ?? new Map<number, Hash>();
    const above = new Map<number, Hash>();
    for (const index of below.keys()) {
      const parent = Math.floor(index / 2);
      if (above.has(parent)) continue;
      above.set(parent, nodeHash(below.get(parent * 2) ?? emptyAt(level), below.get(parent * 2 + 1) ?? emptyAt(level)));
    }
    levels.push(above);
  }
  const root = levels[DEPTH]?.get(0);
  if (root === undefined) throw new Error("merkle tree has no root");
  return {
    root,
    path(slot) {
      const path: (Hash | null)[] = [];
      for (let level = 0, index = slot; level < DEPTH; level += 1, index = Math.floor(index / 2)) {
        path.push(levels[level]?.get(index % 2 === 0 ? index + 1 : index - 1) ?? null);
      }
      return path;
    },
  };
}

// Walks from a slot to the root. A null leaf is an empty slot. The slot's bits decide each turn, so the caller,
// not the prover, fixes which side every sibling is on.
export function rootFrom(slot: number, leaf: Hash | null, path: Path): Hash | null {
  if (path.length !== DEPTH || !Number.isInteger(slot) || slot < 0 || slot >= 2 ** DEPTH) return null;
  let node = leaf ?? emptyAt(0);
  let index = slot;
  for (let level = 0; level < DEPTH; level += 1) {
    const sibling = path[level] ?? emptyAt(level);
    node = index % 2 === 0 ? nodeHash(node, sibling) : nodeHash(sibling, node);
    index = Math.floor(index / 2);
  }
  return node;
}

function emptyAt(level: number): Hash {
  const hash = EMPTY[level];
  if (hash === undefined) throw new Error("no empty subtree at that height");
  return hash;
}

function nodeHash(left: Hash, right: Hash): Hash {
  return sha256(NODE, Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sha256(...parts: readonly Uint8Array[]): Hash {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  const hex = hash.digest("hex");
  if (!isHash(hex)) throw new Error("sha256 did not return 64 hex characters");
  return hex;
}
