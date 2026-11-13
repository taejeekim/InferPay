import { createHash, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";
import type { ModelId } from "../domain.ts";

export const UNVERIFIED_REASONS = [
  "report-unavailable",
  "report-unbound",
  "body-not-captured",
  "no-signature",
  "unsupported-signature",
  "hash-mismatch",
  "bad-signature",
  "signer-not-in-report",
] as const;

export type UnverifiedReason = (typeof UNVERIFIED_REASONS)[number];

// "verified" means: the model's TEE key signed MODEL:sha256(request):sha256(response) over the exact
// bytes we sent and received, and that key is listed in a NEAR AI attestation report that echoed our
// nonce. The Intel TDX and NVIDIA quotes inside the report are not re-verified locally.
export type CallAttestation =
  | {
      readonly verdict: "verified";
      readonly model: ModelId;
      readonly completionId: string;
      readonly signer: string;
    }
  | {
      readonly verdict: "unverified";
      readonly model: ModelId;
      readonly completionId: string | null;
      readonly reason: UnverifiedReason;
      readonly detail: string;
    };

export type ReportEvidence =
  | { readonly ok: true; readonly signers: readonly string[] }
  | { readonly ok: false; readonly reason: "report-unavailable" | "report-unbound"; readonly detail: string };

export type SignatureEvidence =
  | {
      readonly ok: true;
      readonly text: string;
      readonly signature: string;
      readonly signingAddress: string;
      readonly signingAlgo: string;
      readonly kind: string | null;
    }
  | { readonly ok: false; readonly detail: string };

export type CapturedCall = {
  readonly model: ModelId;
  readonly completionId: string;
  readonly requestBody: Uint8Array | null;
  readonly responseBody: Uint8Array;
};

const reportSchema = z.object({
  model_attestations: z
    .array(
      z.object({
        model_name: z.string().optional(),
        signing_address: z.string(),
        signing_algo: z.string(),
        request_nonce: z.string().optional(),
        intel_quote: z.string().optional(),
      }),
    )
    .optional(),
});

const signatureSchema = z.object({
  text: z.string(),
  signature: z.string(),
  signing_address: z.string(),
  signing_algo: z.string(),
  signature_kind: z.string().optional(),
});

// TDX quote v4: a 48-byte header, then the TD report body whose report_data sits 520 bytes in.
const REPORT_DATA_OFFSET = 48 + 520;

export function readReport(raw: unknown, model: ModelId, nonce: string): ReportEvidence {
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "report-unavailable", detail: "attestation report has an unexpected shape" };
  const candidates = (parsed.data.model_attestations ?? []).filter(
    (item) => item.signing_algo === "ecdsa" && (item.model_name === undefined || item.model_name === model),
  );
  if (candidates.length === 0) {
    return { ok: false, reason: "report-unavailable", detail: `attestation report lists no ecdsa model attestation for ${model}` };
  }
  const bound = candidates.filter((item) => {
    if (item.request_nonce !== nonce || item.intel_quote === undefined) return false;
    const reportData = Buffer.from(item.intel_quote, "hex").subarray(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + 64).toString("hex");
    return reportData === `${stripHex(item.signing_address).padEnd(64, "0")}${nonce}`;
  });
  if (bound.length === 0) {
    return {
      ok: false,
      reason: "report-unbound",
      detail: `none of ${candidates.length} model attestations echo our nonce and bind their signer in the quote report_data`,
    };
  }
  return { ok: true, signers: [...new Set(bound.map((item) => normalizeAddress(item.signing_address)))] };
}

export function readSignature(raw: unknown): SignatureEvidence {
  const parsed = signatureSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, detail: "signature endpoint returned no signature" };
  return {
    ok: true,
    text: parsed.data.text,
    signature: parsed.data.signature,
    signingAddress: parsed.data.signing_address,
    signingAlgo: parsed.data.signing_algo,
    kind: parsed.data.signature_kind ?? null,
  };
}

export function checkCall(call: CapturedCall, report: ReportEvidence, signature: SignatureEvidence): CallAttestation {
  const unverified = (reason: UnverifiedReason, detail: string): CallAttestation => ({
    verdict: "unverified",
    model: call.model,
    completionId: call.completionId,
    reason,
    detail,
  });
  if (!report.ok) return unverified(report.reason, report.detail);
  if (call.requestBody === null) return unverified("body-not-captured", "the request body was not captured as text");
  if (!signature.ok) return unverified("no-signature", signature.detail);
  if (signature.kind !== "provider_tee" || signature.signingAlgo !== "ecdsa") {
    return unverified(
      "unsupported-signature",
      `expected a provider_tee ecdsa signature, got ${signature.kind ?? "no kind"} ${signature.signingAlgo}`,
    );
  }
  if (signature.text !== signedText(call.model, call.requestBody, call.responseBody)) {
    return unverified("hash-mismatch", mismatchDetail(call, call.requestBody, signature.text));
  }
  const recovered = recoverSigner(signature.text, signature.signature);
  if (recovered === null || recovered !== normalizeAddress(signature.signingAddress)) {
    return unverified("bad-signature", `signature does not recover to ${signature.signingAddress}`);
  }
  if (!report.signers.includes(recovered)) {
    return unverified("signer-not-in-report", `${recovered} is not among the report's signers: ${report.signers.join(", ")}`);
  }
  return { verdict: "verified", model: call.model, completionId: call.completionId, signer: recovered };
}

export function signedText(model: ModelId, requestBody: Uint8Array, responseBody: Uint8Array): string {
  return `${model}:${sha256(requestBody)}:${sha256(responseBody)}`;
}

export function recoverSigner(text: string, signatureHex: string): string | null {
  const raw = Buffer.from(stripHex(signatureHex), "hex");
  const v = raw[64];
  if (raw.length !== 65 || v === undefined) return null;
  const message = Buffer.from(text, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`, "utf8"), message]));
  try {
    const recovered = Buffer.concat([Buffer.from([v >= 27 ? v - 27 : v]), raw.subarray(0, 64)]);
    const publicKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
    return `0x${Buffer.from(keccak_256(uncompressed.subarray(1)).subarray(12)).toString("hex")}`;
  } catch {
    return null;
  }
}

export type Attestor = {
  preflight(model: ModelId): Promise<ReportEvidence>;
  attest(call: CapturedCall, report: ReportEvidence): Promise<CallAttestation>;
};

const SIGNATURE_TRIES = 4;
const SIGNATURE_RETRY_MS = 500;

export function createAttestor(deps: { readonly baseUrl: string; readonly apiKey: string; readonly fetch?: typeof fetch }): Attestor {
  const doFetch = deps.fetch ?? fetch;
  const reports = new Map<ModelId, Promise<ReportEvidence>>();

  async function fetchReport(model: ModelId): Promise<ReportEvidence> {
    const nonce = randomBytes(32).toString("hex");
    const query = new URLSearchParams({ model, provider: "near", signing_algo: "ecdsa", include_tls_fingerprint: "false", nonce });
    try {
      const response = await doFetch(`${deps.baseUrl}/attestation/report?${query}`, {
        headers: { accept: "application/json", authorization: `Bearer ${deps.apiKey}`, "x-no-aliasing": "true" },
      });
      if (!response.ok) return { ok: false, reason: "report-unavailable", detail: `attestation report returned HTTP ${response.status}` };
      return readReport(await response.json(), model, nonce);
    } catch (error) {
      return { ok: false, reason: "report-unavailable", detail: `attestation report request failed: ${errorText(error, deps.apiKey)}` };
    }
  }

  async function fetchSignature(completionId: string): Promise<SignatureEvidence> {
    const url = `${deps.baseUrl}/signature/${encodeURIComponent(completionId)}?signing_algo=ecdsa`;
    try {
      for (let attempt = 1; ; attempt += 1) {
        const response = await doFetch(url, { headers: { accept: "application/json", authorization: `Bearer ${deps.apiKey}` } });
        if (response.ok) return readSignature(await response.json());
        if (response.status !== 404 || attempt >= SIGNATURE_TRIES) {
          return { ok: false, detail: `signature endpoint returned HTTP ${response.status}` };
        }
        await new Promise((resolve) => setTimeout(resolve, SIGNATURE_RETRY_MS));
      }
    } catch (error) {
      return { ok: false, detail: `signature request failed: ${errorText(error, deps.apiKey)}` };
    }
  }

  function preflight(model: ModelId): Promise<ReportEvidence> {
    const cached = reports.get(model);
    if (cached) return cached;
    const pending = fetchReport(model).then((report) => {
      if (!report.ok) reports.delete(model);
      return report;
    });
    reports.set(model, pending);
    return pending;
  }

  return {
    preflight,
    async attest(call, report) {
      if (!report.ok) return checkCall(call, report, { ok: false, detail: "skipped" });
      return checkCall(call, report, await fetchSignature(call.completionId));
    },
  };
}

function mismatchDetail(call: CapturedCall, requestBody: Uint8Array, signed: string): string {
  const [signedRequest, signedResponse] = signed.split(":").slice(-2);
  const parts: string[] = [];
  if (!signed.startsWith(`${call.model}:`)) parts.push("model");
  if (signedRequest !== sha256(requestBody)) parts.push("request hash");
  if (signedResponse !== sha256(call.responseBody)) parts.push("response hash");
  return `signed text differs from what we hashed: ${parts.join(", ") || "format"}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeAddress(address: string): string {
  return `0x${stripHex(address)}`;
}

function stripHex(value: string): string {
  return value.toLowerCase().replace(/^0x/, "");
}

function errorText(error: unknown, apiKey: string): string {
  return (error instanceof Error ? error.message : String(error)).split(apiKey).join("[redacted]");
}
