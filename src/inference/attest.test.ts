import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseModelId } from "../domain.ts";
import { checkCall, createAttestor, readReport, readSignature, recoverSigner, signedText, type CapturedCall } from "./attest.ts";

type Attestation = { model_name: string; signing_address: string; signing_algo: string; request_nonce: string; intel_quote: string };

// Captured from one real z-ai/glm-5.3-flash call on NEAR AI Cloud: the report, the exact request and
// response bytes, and the signature. None of it is secret.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/near-ai-call.json", import.meta.url), "utf8")) as {
  nonce: string;
  report: { model_attestations: Attestation[] };
  request: string;
  response: string;
  signature: { text: string; signature: string; signing_address: string; signing_algo: string; signature_kind: string };
};

const parsedModel = parseModelId("z-ai/glm-5.3-flash");
if (!parsedModel) throw new Error("fixture model id failed its check");
const model = parsedModel;
const signer = "0x3b753b4406613c5e70ae640508632b600424fa0c";
const otherSigner = "0x1111111111111111111111111111111111111111";
const completionId = (JSON.parse(fixture.response) as { id: string }).id;

function call(overrides: Partial<CapturedCall> = {}): CapturedCall {
  return {
    model,
    completionId,
    requestBody: Buffer.from(fixture.request, "utf8"),
    responseBody: Buffer.from(fixture.response, "utf8"),
    ...overrides,
  };
}

// Rewrites each candidate as if NEAR AI had attested a different key for a different nonce, keeping the
// quote's report_data consistent so only the field under test changes.
function reportFor(nonce: string, address: string) {
  return {
    model_attestations: fixture.report.model_attestations.map((item) => {
      const quote = Buffer.from(item.intel_quote, "hex");
      Buffer.from(`${address.slice(2).padEnd(64, "0")}${nonce}`, "hex").copy(quote, 568);
      return { ...item, signing_address: address, request_nonce: nonce, intel_quote: quote.toString("hex") };
    }),
  };
}

const report = readReport(fixture.report, model, fixture.nonce);
const signature = readSignature(fixture.signature);

test("the real captured call verifies against its report", () => {
  assert.deepEqual(report, { ok: true, signers: [signer] });
  assert.deepEqual(checkCall(call(), report, signature), { verdict: "verified", model, completionId, signer });
});

test("the signed text is MODEL:sha256(request):sha256(response)", () => {
  assert.equal(signedText(model, Buffer.from(fixture.request), Buffer.from(fixture.response)), fixture.signature.text);
});

test("the ecdsa signature recovers the EIP-191 signer", () => {
  assert.equal(recoverSigner(fixture.signature.text, fixture.signature.signature), signer);
  assert.notEqual(recoverSigner(`${fixture.signature.text}x`, fixture.signature.signature), signer);
});

test("a response altered by one byte is a hash mismatch", () => {
  const tampered = Buffer.from(fixture.response, "utf8");
  tampered.writeUInt8(tampered.readUInt8(tampered.length - 2) ^ 1, tampered.length - 2);
  const result = checkCall(call({ responseBody: tampered }), report, signature);
  assert.equal(result.verdict, "unverified");
  assert.equal(result.verdict === "unverified" && result.reason, "hash-mismatch");
  assert.match(result.verdict === "unverified" ? result.detail : "", /response hash/);
  assert.doesNotMatch(result.verdict === "unverified" ? result.detail : "", /request hash/);
});

test("a different request body is a hash mismatch on the request", () => {
  const result = checkCall(call({ requestBody: Buffer.from(fixture.request.replace("hi", "yo")) }), report, signature);
  assert.equal(result.verdict === "unverified" && result.detail, "signed text differs from what we hashed: request hash");
});

test("a signer the report does not list is unverified", () => {
  const foreign = readReport(reportFor(fixture.nonce, otherSigner), model, fixture.nonce);
  assert.deepEqual(foreign, { ok: true, signers: [otherSigner] });
  const result = checkCall(call(), foreign, signature);
  assert.equal(result.verdict === "unverified" && result.reason, "signer-not-in-report");
});

test("a signature that does not recover to its claimed address is unverified", () => {
  const forged = readSignature({ ...fixture.signature, signing_address: otherSigner });
  assert.equal(reasonOf(checkCall(call(), report, forged)), "bad-signature");
  const flipped = `${fixture.signature.signature.slice(0, 10)}${fixture.signature.signature[10] === "0" ? "1" : "0"}${fixture.signature.signature.slice(11)}`;
  assert.equal(reasonOf(checkCall(call(), report, readSignature({ ...fixture.signature, signature: flipped }))), "bad-signature");
});

test("a report that does not echo our nonce is unbound", () => {
  const other = "ab".repeat(32);
  assert.equal(reasonOf(checkCall(call(), readReport(fixture.report, model, other), signature)), "report-unbound");
  const echoedOnly = {
    model_attestations: fixture.report.model_attestations.map((item) => ({ ...item, request_nonce: other })),
  };
  assert.equal(reasonOf(checkCall(call(), readReport(echoedOnly, model, other), signature)), "report-unbound");
});

test("a report with no model attestations is unavailable", () => {
  assert.equal(reasonOf(checkCall(call(), readReport({}, model, fixture.nonce), signature)), "report-unavailable");
  assert.equal(reasonOf(checkCall(call(), readReport({ model_attestations: [] }, model, fixture.nonce), signature)), "report-unavailable");
});

test("a missing signature is unverified", () => {
  const missing = readSignature({ error_code: "not_found", message: "no signature" });
  assert.equal(reasonOf(checkCall(call(), report, missing)), "no-signature");
});

test("a gateway signature is not accepted as the model's", () => {
  const gateway = readSignature({ ...fixture.signature, signature_kind: "gateway" });
  assert.equal(reasonOf(checkCall(call(), report, gateway)), "unsupported-signature");
});

test("an uncaptured request body is unverified", () => {
  assert.equal(reasonOf(checkCall(call({ requestBody: null }), report, signature)), "body-not-captured");
});

test("the attestor fetches the report once per model and retries a late signature", async () => {
  const seen: string[] = [];
  let signatureCalls = 0;
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    if (url.pathname.endsWith("/attestation/report")) {
      return Response.json(reportFor(url.searchParams.get("nonce") ?? "", signer));
    }
    signatureCalls += 1;
    if (signatureCalls === 1) return new Response("not yet", { status: 404 });
    return Response.json(fixture.signature);
  };
  const attestor = createAttestor({ baseUrl: "https://example.test/v1", apiKey: "k", fetch: fakeFetch });
  assert.equal((await attestor.attest(call(), await attestor.preflight(model))).verdict, "verified");
  assert.equal((await attestor.attest(call(), await attestor.preflight(model))).verdict, "verified");
  assert.equal(seen.filter((path) => path.endsWith("/attestation/report")).length, 1);
  assert.equal(signatureCalls, 3);
});

test("the attestor reports endpoint failures as unverified without throwing", async () => {
  const down: typeof fetch = async () => {
    throw new Error("socket closed for sekrit-key");
  };
  const attestor = createAttestor({ baseUrl: "https://example.test/v1", apiKey: "sekrit-key", fetch: down });
  const result = await attestor.attest(call(), await attestor.preflight(model));
  assert.equal(reasonOf(result), "report-unavailable");
  assert.doesNotMatch(result.verdict === "unverified" ? result.detail : "", /sekrit-key/);
});

function reasonOf(result: ReturnType<typeof checkCall>): string {
  return result.verdict === "unverified" ? result.reason : "verified";
}
