import { z } from "zod";
import { isAccountId, type AccountId } from "../domain.ts";
import { buildTree, isHash, leafHash, rootFrom, type Hash, type Step } from "./merkle.ts";
import type { ClauseClaim, Entry, FactClaim, FigureClaim } from "./rules.ts";

export { canonical, leafHash, parseHash } from "./merkle.ts";
export type { Hash, Step } from "./merkle.ts";
export * from "./rules.ts";

export const SCHEME = "inferpay-merkle-sha256-v1";

// All a shop publishes about its dataset. Entries and salts stay with the shop.
export type Commitment = {
  readonly scheme: typeof SCHEME;
  readonly root: Hash;
  readonly leaves: number;
};

// What a buyer needs to recompute one leaf and walk it to the root. The salt keeps the sibling hashes in a
// path from being matched against guessed entries.
export type Evidence = {
  readonly entry: Entry;
  readonly salt: Hash;
  readonly path: readonly Step[];
};

// A shop's word. It can pair any verdict with any evidence, so nothing here counts until a buyer verifies it.
export type AssertedCheck =
  | { readonly kind: "number"; readonly claim: FigureClaim; readonly verdict: "match" | "mismatch" | "unverifiable"; readonly evidence: Evidence | null }
  | { readonly kind: "fact"; readonly claim: FactClaim; readonly verdict: "match" | "mismatch" | "unverifiable"; readonly evidence: Evidence | null }
  | { readonly kind: "flag"; readonly claim: ClauseClaim; readonly verdict: "raised" | "clear"; readonly evidence: Evidence | null };

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
  prove(entry: E): Evidence;
};

export function sealDataset<E extends Entry>(rows: readonly { readonly entry: E; readonly salt: Hash }[]): Dataset<E> {
  const tree = buildTree(rows.map((row) => leafHash(row.entry, row.salt)));
  return {
    commitment: { scheme: SCHEME, root: tree.root, leaves: tree.leaves },
    entries: rows.map((row) => row.entry),
    prove(entry) {
      const index = rows.findIndex((row) => row.entry === entry);
      const row = rows[index];
      if (row === undefined) throw new Error("entry is not in this dataset");
      return { entry, salt: row.salt, path: tree.path(index) };
    },
  };
}

export function opensTo(evidence: Evidence): Hash {
  return rootFrom(leafHash(evidence.entry, evidence.salt), evidence.path);
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

// No path in a tree of 2^64 leaves is longer than this, so a longer one is not worth hashing.
const MAX_PATH = 64;

const evidenceSchema = z.object({
  entry: entrySchema,
  salt: hashSchema,
  path: z.array(z.object({ side: z.enum(["left", "right"]), hash: hashSchema })).max(MAX_PATH),
});

export const figureClaimSchema = z.object({
  label: z.string(),
  company: z.string(),
  period: z.string(),
  metric: z.string(),
  claimed: z.number(),
  unit: z.string(),
});

export const factClaimSchema = z.object({ label: z.string(), topic: z.string(), claimed: z.string() });

export const clauseClaimSchema = z.object({ label: z.string(), text: z.string() });

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
    verdict: z.enum(["raised", "clear"]),
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
