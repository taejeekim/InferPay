import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newJobId, parseIsoTime, parseModelId } from "../domain.ts";
import { createFileLedger, LedgerReadError } from "./ledger.ts";

test("an opened line without payFrom is corrupt", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    const jobId = newJobId(1_700_000_000_000);
    const jobs = join(root, "jobs");
    await mkdir(jobs);
    const line = JSON.stringify({
      type: "opened",
      at: "2026-10-24T14:02:11.000Z",
      order: {
        jobId,
        providerId: "disclosure",
        question: "Does the filing match?",
        budget: { asset: "nep141:wrap.near", symbol: "NEAR", amount: "0.10" },
      },
      quote: { asset: "nep141:wrap.near", symbol: "NEAR", amount: "0.02" },
      payTo: "disclosure.david.inferpay.near",
    });
    await writeFile(join(jobs, `${jobId}.jsonl`), `${line}\n`);
    await assert.rejects(() => createFileLedger(root).read(jobId), LedgerReadError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all skips a job file that read would reject", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    const jobs = join(root, "jobs");
    await mkdir(jobs);
    const staleId = newJobId(1_700_000_000_000);
    const liveId = newJobId(1_700_000_000_001);
    const stale = JSON.stringify({
      type: "opened",
      at: "2026-10-24T08:04:51.690Z",
      order: {
        jobId: staleId,
        providerId: "disclosure",
        question: "What was Samsung's Q3 2025 operating profit?",
        budget: { asset: "nep141:wrap.near", symbol: "NEAR", amount: "0.10" },
      },
      quote: { asset: "nep141:wrap.near", symbol: "NEAR", amount: "0.02" },
      payTo: "disclosure.david.inferpay.near",
    });
    const live = JSON.stringify({
      type: "opened",
      at: "2026-10-24T08:04:51.690Z",
      order: {
        jobId: liveId,
        providerId: "insurance",
        question: "Does this policy cover an outpatient MRI?",
        offer: { asset: "nep141:wrap.near", symbol: "NEAR", amount: "0.02" },
        budget: { asset: "nep141:wrap.near", symbol: "NEAR", amount: "0.10" },
        payFrom: "researcher.kyle.inferpay.near",
        commitment: {
          status: "published",
          commitment: { scheme: "inferpay-keyed-merkle-sha256-v1", root: "ab".repeat(32), leaves: 3 },
          source: { kind: "listing" },
        },
      },
      quote: { asset: "nep141:wrap.near", symbol: "NEAR", amount: "0.02" },
      payTo: "insurance.ban.inferpay.near",
    });
    await writeFile(join(jobs, `${staleId}.jsonl`), `${stale}\n`);
    await writeFile(join(jobs, `${liveId}.jsonl`), `${live}\n`);
    const rows = await createFileLedger(root).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.jobId, liveId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fulfilled answer keeps its attestation, and older lines read as unattested", async () => {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    const model = parseModelId("z-ai/glm-5.3-flash");
    const at = parseIsoTime("2026-11-14T10:00:00.000Z");
    assert.ok(model && at);
    const ledger = createFileLedger(root);
    const attested = newJobId(1_700_000_000_000);
    const attestation = [
      { verdict: "verified", model, completionId: "chatcmpl-1", signer: "0x3b753b4406613c5e70ae640508632b600424fa0c" },
      { verdict: "unverified", model, completionId: "chatcmpl-2", reason: "hash-mismatch", detail: "response hash" },
    ] as const;
    const answer = { text: "Covered.", checks: [], model, inference: "near-ai", attestation } as const;
    await ledger.append(attested, { type: "fulfilled", at, answer });
    assert.deepEqual(await ledger.read(attested), [{ type: "fulfilled", at, answer }]);

    const older = newJobId(1_700_000_000_001);
    await mkdir(join(root, "jobs"), { recursive: true });
    const line = JSON.stringify({ type: "fulfilled", at, answer: { text: "Covered.", checks: [], model, inference: "stub" } });
    await writeFile(join(root, "jobs", `${older}.jsonl`), `${line}\n`);
    const [event] = await ledger.read(older);
    assert.deepEqual(event?.type === "fulfilled" && event.answer.attestation, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
