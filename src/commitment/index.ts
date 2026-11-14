import { z } from "zod";
import { isAccountId, type AccountId } from "../domain.ts";
import { buildTree, DEPTH, isHash, leafHash, rootFrom, slotOf, type Hash, type Path } from "./merkle.ts";
import { entryKey, type ClauseClaim, type Entry, type FactClaim, type FigureClaim, type Key } from "./rules.ts";

export { canonical, DEPTH, leafHash, parseHash, slotOf } from "./merkle.ts";
export type { Hash, Path } from "./merkle.ts";
export * from "./rules.ts";

export const SCHEME = "inferpay-keyed-merkle-sha256-v1";

// All a shop publishes about its dataset. Entries and salts stay with the shop.
export type Commitment = {
  readonly scheme: typeof SCHEME;
  readonly root: Hash;
  readonly leaves: number;
};

// What a buyer needs to recompute one leaf and walk it to the root. The salt keeps the sibling hashes in a
// path from being matched against guessed entries.
export type Membership = {
  readonly entry: Entry;
  readonly salt: Hash;
  readonly path: Path;
};

// The path from a key's slot when the slot is empty: proof that the dataset holds no entry for the key.
export type Vacancy = {
  readonly vacant: true;
  readonly path: Path;
};

export type Evidence = Membership | Vacancy;

// A shop's word. It can pair any verdict with any evidence, so nothing here counts until a buyer verifies it.
export type AssertedCheck =
  | { readonly kind: "number"; readonly claim: FigureClaim; readonly verdict: "match" | "mismatch" | "unverifiable"; readonly evidence: Evidence | null }
  | { readonly kind: "fact"; readonly claim: FactClaim; readonly verdict: "match" | "mismatch" | "unverifiable"; readonly evidence: Evidence | null }
  | { readonly kind: "flag"; readonly claim: ClauseClaim; readonly verdict: "raised" | "clear" | "unverifiable"; readonly evidence: Evidence | null };

export type CommitmentSource =
  | { readonly kind: "listing" }
  | { readonly kind: "chain"; readonly contract: AccountId; readonly account: AccountId; readonly block: number };

// The commitment a buyer fixed before it paid, so a shop cannot publish a new root once it has seen the question.
export type PinnedCommitment =
  | { readonly status: "published"; readonly commitment: Commitment; readonly source: CommitmentSource }
  | { readonly status: "missing"; readonly contract: AccountId; readonly account: AccountId };

export type Dataset<E extends Entry> = {
  readonly commitment: Commitment;
  readonly entries: readonly E[];
  prove(entry: E): Membership;
  // Null when another key's entry happens to sit in this key's slot, which leaves nothing to prove.
  proveAbsent(key: Key): Vacancy | null;
};

export function sealDataset<E extends Entry>(rows: readonly { readonly entry: E; readonly salt: Hash }[]): Dataset<E> {
  const slots = new Map<number, { readonly entry: E; readonly salt: Hash }>();
  for (const row of rows) {
    const slot = slotOf(entryKey(row.entry));
    if (slots.has(slot)) throw new Error(`two entries share the key or the slot of ${entryKey(row.entry).join(" / ")}`);
    slots.set(slot, row);
  }
  const tree = buildTree(new Map([...slots].map(([slot, row]) => [slot, leafHash(row.entry, row.salt)])));
  return {
    commitment: { scheme: SCHEME, root: tree.root, leaves: rows.length },
    entries: rows.map((row) => row.entry),
    prove(entry) {
      const slot = slotOf(entryKey(entry));
      const row = slots.get(slot);
      if (row === undefined || row.entry !== entry) throw new Error("entry is not in this dataset");
      return { entry, salt: row.salt, path: tree.path(slot) };
    },
    proveAbsent(key) {
      const slot = slotOf(key);
      return slots.has(slot) ? null : { vacant: true, path: tree.path(slot) };
    },
  };
}

// The root this evidence gives for the slot of the key. The caller names the key, so evidence for one key
// cannot stand in for another. Null when the path is not a full path.
export function opensTo(key: Key, evidence: Evidence): Hash | null {
  const leaf = "vacant" in evidence ? null : leafHash(evidence.entry, evidence.salt);
  return rootFrom(slotOf(key), leaf, evidence.path);
}

const hashSchema = z.custom<Hash>((value) => typeof value === "string" && isHash(value));

export const saltSchema = hashSchema;

const entrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("figure"),
    company: z.string(),
    period: z.string(),
    metric: z.string(),
    value: z.number(),
    unit: z.string(),
    source: z.string(),
  }),
  z.object({ kind: z.literal("fact"), topic: z.string(), value: z.string(), source: z.string() }),
  z.object({
    kind: z.literal("rule"),
    id: z.string(),
    all: z.array(z.string().min(1)).min(1),
    label: z.string(),
    detail: z.string(),
  }),
]);

const pathSchema = z.array(hashSchema.nullable()).length(DEPTH);

const evidenceSchema = z.union([
  z.object({ entry: entrySchema, salt: hashSchema, path: pathSchema }),
  z.object({ vacant: z.literal(true), path: pathSchema }),
]);

export const figureClaimSchema = z.object({
  label: z.string(),
  company: z.string(),
  period: z.string(),
  metric: z.string(),
  claimed: z.number(),
  unit: z.string(),
});

export const factClaimSchema = z.object({ label: z.string(), topic: z.string(), claimed: z.string() });

export const clauseClaimSchema = z.object({ label: z.string(), text: z.string(), rule: z.string() });

export const assertedCheckSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("number"),
    claim: figureClaimSchema,
    verdict: z.enum(["match", "mismatch", "unverifiable"]),
    evidence: evidenceSchema.nullable(),
  }),
  z.object({
    kind: z.literal("fact"),
    claim: factClaimSchema,
    verdict: z.enum(["match", "mismatch", "unverifiable"]),
    evidence: evidenceSchema.nullable(),
  }),
  z.object({
    kind: z.literal("flag"),
    claim: clauseClaimSchema,
    verdict: z.enum(["raised", "clear", "unverifiable"]),
    evidence: evidenceSchema.nullable(),
  }),
]);

export const commitmentSchema = z.object({
  scheme: z.literal(SCHEME),
  root: hashSchema,
  leaves: z.number().int().positive(),
});

const accountSchema = z.custom<AccountId>((value) => typeof value === "string" && isAccountId(value));

export const pinnedCommitmentSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("published"),
    commitment: commitmentSchema,
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("listing") }),
      z.object({ kind: z.literal("chain"), contract: accountSchema, account: accountSchema, block: z.number().int() }),
    ]),
  }),
  z.object({ status: z.literal("missing"), contract: accountSchema, account: accountSchema }),
]);

export function parseAssertedChecks(raw: unknown): readonly AssertedCheck[] | null {
  const parsed = z.array(assertedCheckSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseCommitment(raw: unknown): Commitment | null {
  const parsed = commitmentSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
