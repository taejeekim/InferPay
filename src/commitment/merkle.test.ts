import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildTree, canonical, leafHash, parseHash, rootFrom, type Hash } from "./merkle.ts";

const SALT = hash("11".repeat(32));

function hash(hex: string): Hash {
  const parsed = parseHash(hex);
  if (!parsed) throw new Error("fixture hash");
  return parsed;
}

function sha(...parts: readonly Buffer[]): Hash {
  return hash(createHash("sha256").update(Buffer.concat(parts)).digest("hex"));
}

function leaves(count: number): Hash[] {
  return Array.from({ length: count }, (_, index) => leafHash({ index }, SALT));
}

test("a leaf is sha256 over a zero byte, the salt, and the entry with its keys sorted", () => {
  const expected = sha(Buffer.from([0]), Buffer.from(SALT, "hex"), Buffer.from('{"a":[1,"x"],"b":{"c":null,"d":2}}', "utf8"));
  assert.equal(leafHash({ b: { d: 2, c: null }, a: [1, "x"] }, SALT), expected);
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
});

test("a single leaf is its own root and needs no path", () => {
  const [only] = leaves(1);
  assert.ok(only);
  const tree = buildTree([only]);
  assert.equal(tree.root, only);
  assert.deepEqual(tree.path(0), []);
  assert.equal(rootFrom(only, tree.path(0)), tree.root);
});

test("three leaves hash the first pair under a one byte and carry the third up unchanged", () => {
  const [a, b, c] = leaves(3);
  assert.ok(a && b && c);
  const pair = sha(Buffer.from([1]), Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  const root = sha(Buffer.from([1]), Buffer.from(pair, "hex"), Buffer.from(c, "hex"));
  const tree = buildTree([a, b, c]);
  assert.equal(tree.root, root);
  assert.deepEqual(tree.path(2), [{ side: "left", hash: pair }]);
  assert.deepEqual(tree.path(0), [{ side: "right", hash: b }, { side: "right", hash: c }]);
});

test("every leaf of every tree from one to nine leaves walks to the root", () => {
  for (let count = 1; count <= 9; count += 1) {
    const all = leaves(count);
    const tree = buildTree(all);
    assert.equal(tree.leaves, count);
    all.forEach((leaf, index) => assert.equal(rootFrom(leaf, tree.path(index)), tree.root, `${index} of ${count}`));
  }
});

test("a changed entry, salt, or path walks to a different root", () => {
  const entries = [{ topic: "a" }, { topic: "b" }, { topic: "c" }, { topic: "d" }, { topic: "e" }];
  const tree = buildTree(entries.map((entry) => leafHash(entry, SALT)));
  const path = tree.path(1);
  const honest = leafHash({ topic: "b" }, SALT);
  assert.equal(rootFrom(honest, path), tree.root);

  assert.notEqual(rootFrom(leafHash({ topic: "B" }, SALT), path), tree.root);
  assert.notEqual(rootFrom(leafHash({ topic: "b" }, hash("22".repeat(32))), path), tree.root);
  assert.notEqual(rootFrom(honest, path.slice(1)), tree.root);
  assert.notEqual(rootFrom(honest, path.map((step, index) => (index === 0 ? { ...step, side: "right" as const } : step))), tree.root);
  assert.notEqual(rootFrom(honest, path.map((step, index) => (index === 1 ? { ...step, hash: honest } : step))), tree.root);
  assert.notEqual(rootFrom(honest, tree.path(2)), tree.root);
});

test("an empty dataset has no commitment", () => {
  assert.throws(() => buildTree([]), /at least one entry/);
});
