import { createHash } from "node:crypto";
import type { Brand } from "../domain.ts";

export type Hash = Brand<string, "Hash">;

// The side a sibling sits on when it is hashed with the node below it.
export type Step = { readonly side: "left" | "right"; readonly hash: Hash };

export type Tree = {
  readonly root: Hash;
  readonly leaves: number;
  path(index: number): readonly Step[];
};

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

const HASH = /^[0-9a-f]{64}$/;
// A leaf and an inner node hash under different prefixes, so an inner node can never be passed off as a leaf.
const LEAF = Uint8Array.of(0);
const NODE = Uint8Array.of(1);

export function isHash(value: string): value is Hash {
  return HASH.test(value);
}

export function parseHash(raw: string): Hash | null {
  return isHash(raw) ? raw : null;
}

// Keys sort, so two parties that hold the same entry always hash the same bytes.
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

// An unpaired node moves up a level unchanged, so a tree of any size has one root and no duplicated leaf.
export function buildTree(leaves: readonly Hash[]): Tree {
  if (leaves.length === 0) throw new Error("a commitment needs at least one entry");
  const levels: (readonly Hash[])[] = [leaves];
  for (let level = leaves; level.length > 1;) {
    const next: Hash[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1];
      if (left === undefined) throw new Error("merkle level lost a node");
      next.push(right === undefined ? left : nodeHash(left, right));
    }
    levels.push(next);
    level = next;
  }
  const root = levels.at(-1)?.[0];
  if (root === undefined) throw new Error("merkle tree has no root");
  return {
    root,
    leaves: leaves.length,
    path(index) {
      if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error("no such leaf");
      const steps: Step[] = [];
      let at = index;
      for (const level of levels.slice(0, -1)) {
        const sibling = level[at % 2 === 0 ? at + 1 : at - 1];
        if (sibling !== undefined) steps.push({ side: at % 2 === 0 ? "right" : "left", hash: sibling });
        at = Math.floor(at / 2);
      }
      return steps;
    },
  };
}

export function rootFrom(leaf: Hash, path: readonly Step[]): Hash {
  return path.reduce((node, step) => (step.side === "left" ? nodeHash(step.hash, node) : nodeHash(node, step.hash)), leaf);
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
