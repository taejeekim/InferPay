import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildTree, canonical, DEPTH, leafHash, parseHash, rootFrom, slotOf, type Hash } from "./merkle.ts";

const SALT = hash("11".repeat(32));

function hash(hex: string): Hash {
  const parsed = parseHash(hex);
  if (!parsed) throw new Error("fixture hash");
  return parsed;
}

function sha(...parts: readonly Buffer[]): Hash {
  return hash(createHash("sha256").update(Buffer.concat(parts)).digest("hex"));
}

function node(left: Hash, right: Hash): Hash {
  return sha(Buffer.from([1]), Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

// The definition, written out with nothing shared with the code under test: an empty slot is sha256 of a two
// byte, and each level hashes the node with its sibling, the node on the left when its index is even.
function walk(slot: number, leaf: Hash, siblings: ReadonlyMap<number, Hash>): Hash {
  let empty = sha(Buffer.from([2]));
  let at = leaf;
  let index = slot;
  for (let level = 0; level < 32; level += 1) {
    const sibling = siblings.get(level) ?? empty;
    at = index % 2 === 0 ? node(at, sibling) : node(sibling, at);
    empty = node(empty, empty);
    index = Math.floor(index / 2);
  }
  return at;
}

function tree(count: number) {
  const leaves = new Map(Array.from({ length: count }, (_, index) => [slotOf(["topic", String(index)]), leafHash({ index }, SALT)] as const));
  assert.equal(leaves.size, count);
  return { leaves, built: buildTree(leaves) };
}

test("a leaf is sha256 over a zero byte, the salt, and the entry with its keys sorted", () => {
  const expected = sha(Buffer.from([0]), Buffer.from(SALT, "hex"), Buffer.from('{"a":[1,"x"],"b":{"c":null,"d":2}}', "utf8"));
  assert.equal(leafHash({ b: { d: 2, c: null }, a: [1, "x"] }, SALT), expected);
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
});

test("a key's slot is the first four bytes of sha256 over a three byte and the key", () => {
  const digest = createHash("sha256").update(Buffer.concat([Buffer.from([3]), Buffer.from('["fact","mri"]', "utf8")])).digest();
  assert.equal(slotOf(["fact", "mri"]), digest.readUInt32BE(0));
  assert.notEqual(slotOf(["fact", "mri"]), slotOf(["fact", "copay"]));
});

test("a single leaf walks to the root through 32 empty subtrees", () => {
  const { leaves, built } = tree(1);
  const [[slot, leaf]] = [...leaves] as [[number, Hash]];
  const path = built.path(slot);
  assert.equal(path.length, DEPTH);
  assert.ok(path.every((sibling) => sibling === null));
  assert.equal(built.root, walk(slot, leaf, new Map()));
  assert.equal(rootFrom(slot, leaf, path), built.root);
});

test("every leaf of every tree from one to nine leaves walks to the same root as the definition gives", () => {
  for (let count = 1; count <= 9; count += 1) {
    const { leaves, built } = tree(count);
    for (const [slot, leaf] of leaves) {
      const path = built.path(slot);
      assert.equal(rootFrom(slot, leaf, path), built.root, `${slot} of ${count}`);
      const siblings = new Map(path.flatMap((sibling, level) => (sibling === null ? [] : [[level, sibling] as const])));
      assert.equal(walk(slot, leaf, siblings), built.root, `${slot} of ${count}`);
    }
  }
});

test("an empty slot walks to the root with no leaf, and a filled slot does not", () => {
  const { leaves, built } = tree(5);
  const vacant = slotOf(["topic", "missing"]);
  assert.equal(leaves.has(vacant), false);
  assert.equal(rootFrom(vacant, null, built.path(vacant)), built.root);
  const [[taken]] = [...leaves] as [[number, Hash]];
  assert.notEqual(rootFrom(taken, null, built.path(taken)), built.root);
});

test("a changed entry, salt, slot, or path walks to a different root or to none", () => {
  const { leaves, built } = tree(5);
  const [[slot], [other]] = [...leaves] as [[number, Hash], [number, Hash]];
  const honest = leafHash({ index: 0 }, SALT);
  const path = built.path(slot);
  assert.equal(rootFrom(slot, honest, path), built.root);

  assert.notEqual(rootFrom(slot, leafHash({ index: 7 }, SALT), path), built.root);
  assert.notEqual(rootFrom(slot, leafHash({ index: 0 }, hash("22".repeat(32))), path), built.root);
  assert.notEqual(rootFrom(other, honest, path), built.root);
  assert.notEqual(rootFrom(slot, honest, built.path(other)), built.root);
  const level = path.findIndex((sibling) => sibling !== null);
  assert.ok(level >= 0);
  assert.notEqual(rootFrom(slot, honest, path.map((sibling, index) => (index === level ? null : sibling))), built.root);
  assert.notEqual(rootFrom(slot, honest, path.map((sibling, index) => (index === level ? honest : sibling))), built.root);
  assert.equal(rootFrom(slot, honest, path.slice(1)), null);
  assert.equal(rootFrom(slot, honest, [...path, null]), null);
  assert.equal(rootFrom(2 ** 32, honest, path), null);
});

test("an empty dataset has no commitment", () => {
  assert.throws(() => buildTree(new Map()), /at least one entry/);
});
