# InferPay

A consumer agent can pay a specialist for an answer. The specialist keeps the dataset. The consumer gets the answer and the checks.

## The problem

Specialist data is the valuable part of an agent, and sending that data to the caller throws it away. A filings question needs the filing. The caller does not need the rest of the workbook.

## Try it

Install dependencies, then run the demo.

```sh
npm install
npx inferpay demo
```

The demo writes job files in a temporary directory and deletes them when it finishes. It refuses to start when any payment variable is set. It leaves `NEAR_AI_API_KEY` unset. It does not transfer funds.

A passing run ends in a `judge` block. See these lines.

- `payment=mock` and `inference=stub` on every command.
- A revenue mismatch of `79.0T` against the filed `79.1T`, printed as `-0.13%`.
- `4/5` on that answer.
- Resume of the settled job reuses the idempotency key and prints `transfer skipped`.
- An interrupted payment settles once on resume. The next resume prints `transfer skipped`.
- A budget of `0.10` declines the `0.25` price.
- The provider listing then shows `4.5 (2)`.

This fits the `agents` track and the `security` track. NEAR Intents is the payment rail when the four payment variables below are set together. NEAR AI Cloud is the model API when `NEAR_AI_API_KEY` is set. The budget on each ask is the spending limit. The job file stores the idempotency key before the transfer, and a retry sends that same key. The grant token is what spends. This program does not sign owner intents.

A live receipt is a transcript from `npx inferpay ask` whose first line is `payment=near-intents` and `inference=near-ai`, whose correlation id does not start with `mock-`, and whose resume prints `transfer skipped` for the same key. Use the Samsung question in the walkthrough below. Paste that transcript here only after the command has printed it. `npx inferpay demo` does not produce a live receipt.

## The product

InferPay runs that exchange from the command line. One consumer reads a provider list, decides whether to hire, and pays before the provider runs. The provider in this slice is `disclosure`. It answers questions about company filings. Every cited figure is checked against a private dataset in `src/providers/disclosure/data`.

The sample filing is Samsung Electronics Q3 2025. Operating profit is 12.1T KRW. Revenue is 79.1T KRW. `TOLERANCE_PCT` in `src/providers/disclosure/crossValidate.ts` is 0.05, and the unit is percent, so 0.05 percent. A claim of 79.0T KRW is 0.13 percent away from 79.1T KRW, so the check is a mismatch.

The consumer grades the answer from those checks. All matches score 5. Each mismatch subtracts 1, and the score does not go below 1. An answer with no checks scores 3. An unverifiable figure does not subtract. The capex question in the walkthrough scores 5 because the dataset has no capex row.

A job is an append-only file under `.inferpay/jobs`. Reputation is the count of completed jobs and the average of the ratings on those jobs. `npx inferpay providers` recomputes it from the files.

## NEAR Intents and NEAR AI Cloud

NEAR Intents is the payment rail. The live path uses `@near-intents-agent-api/sdk` 0.7.1. `NEAR_INTENTS_AGENT_API_KEY` authenticates the backend. `INFERPAY_GRANT_TOKEN` is the consumer agent's grant. `api.forGrant(token).transfer` sends USDC to `INFERPAY_DISCLOSURE_PAY_TO`. The API counts atomic units. USDC has 6 decimal places, so a price of 0.25 is sent as 250000. The marketplace writes the idempotency key into the job file before the transfer. A retry uses that same key. A new key would be a second payment. This slice does not issue grants and does not sign owner intents. The SDK package requires Node 24.

NEAR AI Cloud is the model API when `NEAR_AI_API_KEY` is set. InferPay uses the OpenAI client at `https://cloud-api.near.ai/v1`. The consumer model picks a provider. The disclosure model must call `cross_validate_numbers`. The checks stored on the job are that tool result. The default consumer model is `z-ai/glm-5.2`. The default provider model is `zai-org/GLM-5.1-FP8`. `NEAR_AI_CONSUMER_MODEL` and `NEAR_AI_PROVIDER_MODEL` override them.

With those keys unset, the same functions run against a mock payment file and recorded fixtures. Both modes write the same job file format.

## Ask on the mock rail

Mock mode runs on Node 22.18 or newer. The transcript below is stdout from one run on Node v22.23.2. Job ids, keys, and correlation ids change on every run. Times in `inferpay job` are UTC.

Install dependencies.

```sh
npm install
```

See who is selling. With no keys set, the first line says the mock rail and the stub model are active.

```sh
npx inferpay providers
```

```
rails: payment=mock inference=stub
ID          SPECIALTY                                PRICE      JOBS  RATING
disclosure  Disclosure analysis, number cross-check  0.25 USDC  0     unrated
```

Ask a filings question inside a 0.50 USDC budget. The disclosure price is 0.25 USDC.

```sh
npx inferpay ask "Does Samsung Electronics' Q3 2025 operating profit in the earnings release match the quarterly report?" --budget 0.50
```

```
rails: payment=mock inference=stub
decide    outsource to disclosure (needs filing figures the consumer does not hold)
pay       settled 0.25 USDC -> disclosure.mock (job job_01M5PAE3VXD8N1XM6X379NAN6M, key mock_c5b5426d-66b9-4112-be9b-23643181a243, correlation mock-e5f9) transfer called
answer    Operating profit matches across both documents: KRW 12.1T.
checks    match     operating profit Q3 2025  12.1T KRW   (quarterly report, p.14)
          mismatch  revenue Q3 2025           79.0T KRW   ref 79.1T KRW (-0.13%)
rate      4/5 (1 of 2 figures needed correction)
```

The command exits 0. Read the job file. Use the job id from the pay line.

```sh
npx inferpay job job_01M5PAE3VXD8N1XM6X379NAN6M
```

```
rails: payment=mock inference=stub
opened            06:44:10 UTC  disclosure  quote 0.25 USDC  budget 0.50 USDC
payment-intended  06:44:10 UTC  key mock_c5b5426d-66b9-4112-be9b-23643181a243
payment-settled   06:44:10 UTC  correlation mock-e5f9
fulfilled         06:44:10 UTC  2 checks
rated             06:44:10 UTC  4/5
```

List providers again. The completed job and the rating come from that file.

```sh
npx inferpay providers
```

```
rails: payment=mock inference=stub
ID          SPECIALTY                                PRICE      JOBS  RATING
disclosure  Disclosure analysis, number cross-check  0.25 USDC  1     4.0 (1)
```

Stop a payment after the rail accepts the key and before it settles. `INFERPAY_MOCK_CHAOS=uncertain-once` does that once per key.

```sh
INFERPAY_MOCK_CHAOS=uncertain-once npx inferpay ask "What was Samsung's Q3 2025 capex?" --budget 0.50
```

```
rails: payment=mock inference=stub
decide    outsource to disclosure (needs filing figures the consumer does not hold)
pay       uncertain (job job_01M5PAE4801AAZVGAZ28255AXQ, key mock_578438aa-bebe-44f5-81f8-a3f82c2a86dd, correlation mock-98e2) transfer called. Nothing was charged twice.
pending   job_01M5PAE4801AAZVGAZ28255AXQ is waiting on payment. Run: npx inferpay resume job_01M5PAE4801AAZVGAZ28255AXQ
```

Resume with the same job id. The pay line uses the same key and the same correlation id. `transfer called` means this run sent the key to the rail again. The mock rail settles the stored key instead of charging a second time.

```sh
npx inferpay resume job_01M5PAE4801AAZVGAZ28255AXQ
```

```
rails: payment=mock inference=stub
pay       settled 0.25 USDC -> disclosure.mock (job job_01M5PAE4801AAZVGAZ28255AXQ, key mock_578438aa-bebe-44f5-81f8-a3f82c2a86dd, correlation mock-98e2) transfer called
answer    Samsung Electronics Q3 2025 capex is not in the filed figures this provider holds.
checks    unverifiable  capex Q3 2025             1.0T KRW
rate      5/5
```

Run resume on that finished job again. `transfer skipped` means this run did not call the rail.

```sh
npx inferpay resume job_01M5PAE4801AAZVGAZ28255AXQ
```

```
rails: payment=mock inference=stub
pay       settled 0.25 USDC -> disclosure.mock (job job_01M5PAE4801AAZVGAZ28255AXQ, key mock_578438aa-bebe-44f5-81f8-a3f82c2a86dd, correlation mock-98e2) transfer skipped
answer    Samsung Electronics Q3 2025 capex is not in the filed figures this provider holds.
checks    unverifiable  capex Q3 2025             1.0T KRW
rate      5/5
```

Stay under the disclosure price. The command declines and writes no job file.

```sh
npx inferpay ask "Summarize the Q3 filing" --budget 0.10
```

```
rails: payment=mock inference=stub
decide    declined. Cheapest fitting provider costs 0.25 USDC, budget is 0.10 USDC.
```

`npm test` checks the ledger fold, the grade, the 0.13 percent mismatch, and the `inferpay demo` transcript.

## Use the live rails

Copy `.env.example` to `.env` and fill the names you need. Do not commit `.env`.

Set `NEAR_AI_API_KEY` to use NEAR AI Cloud. Leave it unset to keep the recorded fixtures.

Set all four payment variables together, or leave all four unset. A partial set is a startup error. The mock rail stays in place when they are unset.

```
NEAR_INTENTS_AGENT_API_KEY
INFERPAY_AGENT_ID
INFERPAY_GRANT_TOKEN
INFERPAY_DISCLOSURE_PAY_TO
```

`INFERPAY_USDC_ASSET` overrides the asset id on the transfer. The default is `nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near`. `INFERPAY_DATA_DIR` overrides `.inferpay`. `INFERPAY_MOCK_CHAOS` is only read for the mock rail.
