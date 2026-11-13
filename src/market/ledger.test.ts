import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newJobId } from "../domain.ts";
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
        budget: { asset: "nep141:wrap.near", symbol: "NEAR", amount: "0.10" },
        payFrom: "researcher.kyle.inferpay.near",
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
