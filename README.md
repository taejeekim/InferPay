# InferPay

InferPay is a buyer agent with a budget. You give it a task. It splits the task into parts and decides for each part, with arithmetic you can read, whether to answer on its own or to pay a specialist agent in NEAR. When it buys, it names the facts it needs, the specialist must prove each one against a hash of its dataset that it published on NEAR, and the buyer checks every proof itself before it rates the specialist on chain.

The problem: an agent with a budget can waste it in two ways. It can pay for answers it already knows, and it can pay for answers it cannot check. Agent marketplaces settle the payment and collect a star rating, but the rating is an opinion. InferPay prices each purchase against the buyer's own confidence before any money moves, and it replaces the opinion with proofs. A specialist that forges a proof, or leaves out a fact the buyer asked for, is caught and rated down.

## Judges, start here

1. **Open the page.** [taejeekim.github.io/InferPay](https://taejeekim.github.io/InferPay/) reads the live state from NEAR testnet in your browser: each specialist's dataset hash and reputation, each buyer bot's balance, and the latest on-chain ratings. Under "Verify a proof yourself", your browser recomputes one proof and compares it with the hash on chain. Press **Change covered to excluded** and the verdict turns to `FORGED`.
2. **Run a whole task with no keys.** You need Node 22.18 or newer.

	```sh
	npm install
	npx inferpay task "Brief me for Monday: France's capital, our NDA's indemnity clause, outpatient MRI cover, and Samsung's Q3 2025 operating profit" --budget 0.10
	```

	You see a plan of 4 parts, a decision with its arithmetic for each part, and one receipt that ends with `spent 0.064 NEAR of the 0.10 NEAR budget`.
3. **Check our testnet records against the chain.** `npm run evidence` re-reads every transaction and on-chain record this README cites and ends with `28 of 28 records match the chain`.
4. **Reproduce the measurements.** `npm run eval` runs 88 CLI commands without keys and prints how many forged proofs the buyer caught (4 of 4), how many honest proofs it flagged by mistake (0), and what a shop loses by withholding a fact.
5. **Pay on NEAR testnet yourself.** `npx inferpay testnet setup` creates 18 accounts through the public faucet in about two minutes. After that, every purchase is a real transfer with an explorer link. See [Pay on NEAR testnet](#pay-on-near-testnet).

[WALKTHROUGH.md](WALKTHROUGH.md) shows eleven commands with their full output. A test regenerates that file from the CLI and fails when the two disagree.

## What runs today

| Part | No keys | After `npx inferpay testnet setup` | With `NEAR_AI_API_KEY` |
| --- | --- | --- | --- |
| Task splitting, buy-or-answer decision, one counter-offer, receipt | Real | Real | Real |
| Proof verification and grading | Real. The dataset hash comes from the shop's listing. | The buyer reads the dataset hash from NEAR testnet. | Unchanged |
| Payment | `payment=mock`: a local receipt. No NEAR moves. | `payment=near-testnet`: a native NEAR transfer from the buyer bot's own sub-account | Unchanged |
| Reputation | This machine's job files | Ratings that the buyer bots write on NEAR testnet | Unchanged |
| Answers | `inference=stub`: 10 recorded questions and 2 recorded tasks. Anything else stops before payment. | Unchanged | `inference=near-ai`: NEAR AI Cloud, any question or task, with each model response checked against NEAR AI's TEE attestation report |

The first line of every command prints the active rails, for example `rails: payment=mock inference=stub`. A NEAR Intents rail for mainnet exists in `src/payment/near-intents.ts` and has never run. See [Limits](#limits).

## What it does, in four outputs

These excerpts come from [WALKTHROUGH.md](WALKTHROUGH.md).

**One receipt for a task, inside one budget.** The buyer answered one part alone, bought one part after a counter-offer, and bought two parts at the list price.

```text
receipt   task_01M7BW87Y35PF3276ATYZW3YWC
          task    Brief me for Monday: France's capital, our NDA's indemnity clause, outpatient MRI cover, and Samsung's Q3 2025 operating profit
          #  DONE BY                            LIST  PAID                   CHECK
          1  the buyer itself                   -     nothing                own answer, confidence 0.99
             asked  What is the capital of France?
          2  legal.stella.inferpay.testnet      0.03  0.024 NEAR on counter  1 verified; rated 5/5
             asked  Does this NDA's unlimited indemnification clause fail our playbook?
             job    job_01M7BW87VPEYRE05ZSRAQVMQMA
          3  insurance.ban.inferpay.testnet     0.02  0.02 NEAR at list      1 verified; rated 5/5
             asked  Does this policy cover an outpatient MRI?
             job    job_01M7BW87WFD52NZHQZJXFHA65Y
          4  disclosure.david.inferpay.testnet  0.02  0.02 NEAR at list      1 verified; rated 5/5
             asked  What was Samsung's Q3 2025 operating profit?
             job    job_01M7BW87XA17Y5HJ5AV8YWTFXT
total     spent 0.064 NEAR of the 0.10 NEAR budget, 0.036 NEAR left
fees      none: this rail reports no network fees
saved     .inferpay/tasks/task_01M7BW87Y35PF3276ATYZW3YWC.json
```

**A decision you can redo by hand, with one counter-offer.** The list price was above what the answer was worth to the buyer, so it offered its reservation price once.

```text
decide    buy from insurance at 0.018 NEAR (counter-offer accepted)
          value   0.03 NEAR, the budget: the most a right answer is worth
          local   confidence 0.20 x value = worth 0.006 NEAR
          missing this policy's schedule of covered procedures
          needs   insurance   outpatient-mri
          option  insurance   ask 0.02  cover 1.00 x rep 0.80 = quality 0.80  net +0.004
          option  disclosure  ask 0.02  cover 0.00 x rep 0.70 = quality 0.00  net -0.020
          option  legal       ask 0.03  cover 0.00 x rep 0.70 = quality 0.00  net -0.030
          rule    net = quality x value - ask; buy when net >= local worth: 0.004 < 0.006
          reserve (0.80 - 0.20) x 0.03 = 0.018 NEAR, where buying equals the local worth
          counter 0.018 NEAR against the ask of 0.02 NEAR
          reply   insurance accepted
```

**A specialist that forges a proof is caught.** `INFERPAY_TEST_LIAR=insurance` makes the shop report a wrong copay as a match with fabricated evidence. The shop cannot change the hash it already published.

```text
checks    1 of 2 needed keys opened and verified against the shop's committed root, 1 WITHHELD, 1 FORGED
          verified    match         outpatient MRI  covered
                      Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          FORGED      match         MRI copay       10
                      the shop said match, but its evidence does not open to the committed root
          WITHHELD                  mri-copay
                      the buyer needed this key and the shop sent no verified opening of it
          root      d26d1609271e…b68f  3 leaves  inferpay-keyed-merkle-sha256-v1
          from      the shop's listing, because the mock rail has no chain
rate      1/5  forged evidence sets the rating to 1
```

**A specialist that leaves a fact out is caught.** `INFERPAY_TEST_WITHHOLD=insurance` makes the shop drop the proof that does not help it. The buyer asked for that key, so the gap costs two stars. An honest mismatch costs one, so hiding a fact never pays.

```text
checks    1 of 2 needed keys opened and verified against the shop's committed root, 1 WITHHELD
          verified    match         outpatient MRI  covered
                      Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          WITHHELD                  mri-copay
                      the buyer needed this key and the shop sent no verified opening of it
          root      d26d1609271e…b68f  3 leaves  inferpay-keyed-merkle-sha256-v1
          from      the shop's listing, because the mock rail has no chain
rate      3/5  = 5 - 2 x 1 withheld = 3
```

## Pay on NEAR testnet

You need no keys of your own.

1. Create the accounts. The command creates a fresh root through the NEAR testnet faucet, 17 accounts under it, and one dataset hash on chain for each shop. It writes `INFERPAY_PAYMENT=near-testnet` and `INFERPAY_ROOT_ACCOUNT=<your root>` into `.env`. A second run changes nothing.

	```sh
	npx inferpay testnet setup
	```

2. Ask a question or give a task. The first line now reads `rails: payment=near-testnet inference=stub`.

	```sh
	npx inferpay ask "Does this policy cover an outpatient MRI?" --budget 0.10
	```

3. Look at the result on chain. `npx inferpay wallets` shows each bot's balance. `npx inferpay providers` computes each shop's reputation from the ratings on chain. Open the page with `?root=<your root>` to see the same state in a browser.
4. To return to the mock rail, delete the two `INFERPAY_` lines from `.env`.

Under our own root `inferpay.testnet`, with live NEAR AI inference, one purchase printed this from the pay block on:

```
pay       settled  0.02 NEAR
          from    analyst.kyle.inferpay.testnet
          to      insurance.ban.inferpay.testnet
          via     NEAR testnet transfer
          job     job_01M7BQPFYRXBVGR4TX5N4KGZ9Z
          tx      https://testnet.nearblocks.io/txns/Hr26P5JqV674spww2Cta2W6KYn5QuKgbq4vJGRxpDD7Y
          fee     0.00004463 NEAR gas on top of the price, from the transaction outcome
answer    Yes, outpatient MRI is covered under this policy with a 20% copay.
checks    2 of 2 needed keys opened and verified against the shop's committed root
          verified    match         Outpatient MRI coverage  covered
                      Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          verified    match         MRI copay                20
                      Policy schedule §4.2. Outpatient MRI copay is 20 percent.
          root      d26d1609271e…b68f  3 leaves  inferpay-keyed-merkle-sha256-v1
          from      NEAR testnet, written at block 277578399 and read before paying
          key       insurance.ban.inferpay.testnet/inferpay/commitment in SocialDB v1.social08.testnet
          link      https://testnet.nearblocks.io/address/insurance.ban.inferpay.testnet
rate      5/5  = 5
          rule    start at 5; for each key the buyer needed, -1 per mismatch, -1 per empty slot,
                  -1 per key opened with no claim, -2 per key withheld;
                  at most 2 when no needed key backs the answer;
                  1 if any check is forged; checks the buyer did not ask for never count
          on chain  SocialDB v1.social08.testnet, written by the buyer bot under its own account
          key       analyst.kyle.inferpay.testnet/inferpay/ratings/job_01M7BQPFYRXBVGR4TX5N4KGZ9Z
          tx        https://testnet.nearblocks.io/txns/9pxdrmRDt1HDFoH2grk29v1MoYj5AN45aKodyxeKUWFx
          cost      0.01568045 NEAR on top of the price: 0.00063045 gas, from the transaction outcome,
                    + 0.01505 SocialDB storage, from the bot's storage_balance_of before and after
```

Three things happened on chain. The bot paid the shop with a native transfer. The buyer read the shop's dataset hash from NEAR before it paid. The bot wrote its rating under its own account. `--budget` bounds the price paid to shops. Network fees and the storage for the rating are extra, and each one is printed.

`npm run evidence` checks 28 records from our runs against the chain: the 18 accounts, 12 transfers, the 3 dataset hashes, and 6 ratings with their transactions. The records are in [`src/evidence/records.json`](src/evidence/records.json). Among them:

| What | Transaction |
| --- | --- |
| A payment at an agreed counter-offer price of 0.0195 NEAR | [6XWf3aZn…](https://testnet.nearblocks.io/txns/6XWf3aZnx5ZejvdLkBne1tLftMUa1SQctctQpEMuYgES) |
| A payment whose process was killed after signing, then sent once by `resume` | [9Uif5q6D…](https://testnet.nearblocks.io/txns/9Uif5q6Dm68hp9UyeuaQXU1FXDecgH2waVAKgBpTQHrs) |
| A 1/5 rating written on chain after a shop forged a proof | [65XtKK6R…](https://testnet.nearblocks.io/txns/65XtKK6RsKyLvMAoz4ZAdMnmoYJoss96nKR7cV6NQy9X) |
| A 3/5 rating written on chain after a shop withheld a needed key | [2rF39Vov…](https://testnet.nearblocks.io/txns/2rF39VovTyzDSJD3XVQVcZXWi9qS9gCRcVuqQDk4zCUQ) |

The explorer answers scripts with a browser challenge. To read a shop's dataset hash and a bot's ratings from a terminal, call the view method `get` on the SocialDB contract:

```sh
ARGS=$(printf '{"keys":["insurance.ban.inferpay.testnet/inferpay/commitment","reviewer.kyle.inferpay.testnet/inferpay/ratings/*"]}' | base64 | tr -d '\n')
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"v1.social08.testnet","method_name":"get","args_base64":"'"$ARGS"'"}}' | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
```

The reply holds the root `d26d1609271e8c546648dc3d83990ff7540d60bf40cdf738d693ec655602b68f` for the insurance shop and each rating that the bot `reviewer` wrote.

## Ask anything with NEAR AI

1. Get a NEAR AI Cloud API key. Q-000 in [HACKATHON.md](HACKATHON.md) lists two ways.
2. Add it to `.env` in the repository root. Git ignores that file.

	```sh
	echo 'NEAR_AI_API_KEY=your-key' >> .env
	```

3. Give it any task.

	```sh
	npx inferpay task "Before I sign with this vendor: is an outpatient MRI covered under our policy and at what copay, does the unlimited indemnification clause in their NDA pass our playbook, and what does NDA stand for?" --budget 0.12
	```

	On 2026-11-14 the model split this into three parts. The buyer bought the first from the insurance shop and the second from the legal shop on testnet, answered the third alone, and spent 0.05 NEAR of the 0.12 NEAR budget.

What the live path adds:

- **The plan and the self-assessment are model calls. The decisions are code.** One call splits the task. One call per part returns the buyer's best answer, its confidence, the facts it is missing, and the catalog keys it needs from each shop. If a reply does not parse, the buyer stops without paying.
- **The specialist's model calls a tool** (`cross_validate_numbers`, `flag_clauses`, or `lookup_coverage`). The shop's code opens every key the buyer needs, whether or not the model mentioned it.
- **The `attest` lines.** NEAR AI Cloud runs the model inside a TEE and signs each response. For every model call, InferPay checks that the signed text equals `model:sha256(request):sha256(response)` for the exact bytes it sent and received, that the signature recovers to the signing address, and that this address is listed for the model in an attestation report fetched with a fresh nonce before the call. It does not re-verify the Intel TDX or NVIDIA GPU quotes inside that report, and the output says so.

Both roles default to the model `z-ai/glm-5.3-flash`. Override them with `NEAR_AI_CONSUMER_MODEL` and `NEAR_AI_PROVIDER_MODEL`.

## How it works

**The decision** is a pure function in `src/consumer/decide.ts`. Money is integer arithmetic and probabilities are whole percents.

1. `--budget` is the most a right answer is worth. The buyer never pays a shop more than it.
2. Answering alone is worth `confidence x value`.
3. A shop's quality is `coverage x reputation`. Coverage is zero when the shop's catalog holds none of the keys the question needs. Reputation maps the shop's star ratings onto 0 to 1 and blends in a prior of 0.70 that counts as two ratings.
4. `net = quality x value - ask`. The buyer buys from the shop with the best net at the list price when `net >= local worth`.
5. Otherwise it computes its reservation price, `(quality - confidence) x value`, and offers it once. Each shop has a private floor price and accepts any offer at or above it.
6. With no deal, the buyer answers alone when its confidence is at least 0.50, and declines below that.

**A task** (`src/consumer/task.ts`) gives each part a share of the budget. Parts run in order, and what a part leaves unspent is added to the next part's allotment. The code asserts that the total never exceeds the budget.

**Proofs** (`src/commitment/`, `src/consumer/verify.ts`):

1. Each shop hashes every dataset entry with a random salt into a sparse Merkle tree of 32 levels. An entry sits in the slot that its key hashes to. The shop publishes the root, and a catalog of its key names without their values.
2. The buyer names the catalog keys it needs and pins the shop's root before it pays. On the testnet rail it reads the root from the SocialDB contract `v1.social08.testnet`.
3. The shop must open every needed key: the entry with its salt and path, or the empty slot when it holds nothing for that key.
4. The buyer recomputes each leaf and root, compares the root with the pinned one, and recomputes the verdict from the proven entry. Its code imports nothing from the shop's private modules.

**The grade** (`src/consumer/grade.ts`) starts at 5. For each needed key it subtracts 1 for a mismatch, 1 for an empty slot, 1 for a key opened with no claim, and 2 for a key withheld. It is at most 2 when no needed key backs the answer, and 1 if any proof is forged. Proofs the buyer did not ask for never count. On the testnet rail the bot writes the rating to SocialDB under `<bot account>/inferpay/ratings/<jobId>`.

**Paying once** (`src/payment/near-testnet.ts`). The market writes an idempotency key into the job file before the transfer. The rail signs one transaction, stores the signed bytes under that key, and only then broadcasts. `npx inferpay resume <jobId>` rebroadcasts the same bytes, and one signed transaction can land at most once.

## How NEAR fits

- **Named sub-accounts as wallets with a cap.** Every account derives from one root: `kyle.R` owns ten buyer bots such as `researcher.kyle.R`, and `stella.R`, `ban.R`, and `david.R` each own one shop. Each account has its own key and its own balance. The code signs a bot's payment only with that bot's key, and a native transfer cannot draw on another account, so a bot's balance is the most it can spend. `--from clerk` pays from `clerk.kyle.R`.
- **Native transfers on testnet** for every payment.
- **SocialDB as the public record.** Shops publish dataset hashes and bots publish ratings in NEAR Social's contract `v1.social08.testnet`. Anyone can read both with a view call.
- **NEAR AI Cloud** for inference, with the attestation check above.
- **NEAR Intents** in `src/payment/near-intents.ts`, through `@near-intents-agent-api/sdk`. This rail is mainnet only and has not run.

**Keys, and what the agent cannot do without you.** Setup saves one key per account under `~/.near-credentials/testnet/`, and the repository holds none. All of those keys sit in one directory on one machine. A real deployment would keep each bot's key on its own machine. A bot cannot refill itself, cannot create accounts, and cannot open a job at a price the shop did not accept.

## NEAR AI Agent Market: what we found

The `agents` track prompt asks how jobs get posted and paid on [NEAR AI Agent Market](https://market.near.ai) programmatically. We read its docs on 2026-11-13. InferPay does not post or take jobs there yet.

- **Discovery is public.** `GET https://market.near.ai/v1/agents?q=research` returns listed agents without a login.
- **A buyer with an account hires over MCP** at `https://market.near.ai/mcp`, paying from a prepaid balance. ([Claude Desktop guide](https://docs.market.near.ai/guides/claude-desktop))
- **A buyer with only a wallet hires over A2A with x402.** The agent answers `402` with a price, and the caller signs one USDC authorization on `near:mainnet`. ([Hire using A2A+x402](https://docs.market.near.ai/a2a/hire-agent-using-x402))
- **A seller polls four endpoints with an `aat_` token**: `GET /v1/agents/me/assignments`, then `POST /v1/assignments/{id}/start`, `/messages`, and `/submit`. ([List your agent](https://docs.market.near.ai/list-your-agent))
- **The marketplace holds the payment** until the buyer accepts, refunds undelivered work, takes a 5 percent fee, and settles disputes with an automated judge that runs about every 12 hours. ([Payments and disputes](https://docs.market.near.ai/concepts/payments-and-disputes))

What InferPay adds on the buyer's side of a hire: the buy-or-answer decision before a job is posted, one counter-offer with its arithmetic, and acceptance by proofs in place of a manual review or a dispute. The next step is to hire through the x402 path and to list the three specialists as sellers. Both need mainnet USDC and a hosted worker, so they are not in this submission.

## Limits

- **The Intents rail has never run.** Every on-chain action here is on testnet.
- **The buyer's model picks the needed keys.** A key it fails to name is never required. In stub mode the confidence, coverage, and needed keys of each recorded question are written by hand.
- **The buyer verifies facts, not prose.** It does not check that the answer sentence says what the proven entries say.
- **A proof shows consistency, not truth.** It shows that a fact is in the dataset the shop published. It does not show that the dataset is right.
- **The sample data and its salts are in this repository,** so the three sample datasets are not secret. A purchase reveals the entries it opens.
- **Ratings can be gamed.** Anyone can create an account and write a rating. `providers` reads the ratings of the buyer bots under its own root.
- **One process.** The buyer and the specialists run in one process on one machine.
- **Payment comes first.** If the specialist fails three times, the job is abandoned without a refund.
- **Attestation depth.** The TDX and GPU quotes are not re-verified locally.
- **Concurrency.** Two CLI processes that pay from the same bot at the same moment can collide on a nonce. The second payment settles once the first transaction is found on chain, or is signed again after it has expired.

## Develop

```sh
npm run check
```

`npm run check` runs the type check, the linter, and the tests. No test uses the network. GitHub Actions runs it on every push.

| Path | Contents |
| --- | --- |
| `bin/inferpay.js` | CLI entry. Loads `./.env`. |
| `src/cli/` | Argument parsing, terminal output, and `testnet setup`. |
| `src/consumer/` | Task splitting, self-assessment, the decision, proof verification, and grading. |
| `src/commitment/` | The salted sparse Merkle tree, catalogs and needs, and the verdict rules both sides run. |
| `src/market/` | Job ledger, hire state machine, counter-offers, and reputation. |
| `src/payment/` | Mock rail, NEAR testnet rail, and NEAR Intents rail. |
| `src/near/` | The NEAR testnet client: credentials, signing, sending, and SocialDB calls. |
| `src/registry/` | Dataset hashes and ratings on SocialDB. |
| `src/inference/` | Stub recordings, the NEAR AI client, and attestation checks. |
| `src/providers/` | The three specialists, their tools, and their sample data. |
| `src/eval/`, `src/evidence/` | `npm run eval` and `npm run evidence`. |
| `src/docs/` | `node src/docs/walkthrough.ts --write` regenerates WALKTHROUGH.md. |
| `docs/`, `src/site/` | The GitHub Pages site, and the tests that hold its browser code to the TypeScript. |

Running `npx inferpay` with no command lists the commands and the test hooks.

## Hackathon notes

- Event: NEAR HACKATHON. Track: `agents` (Agent Economy).
- Timeline: the first commit is dated 2026-10-24, after the announcement on 2026-10-19 (Q-001).
- Libraries: `near-api-js`, `@near-intents-agent-api/sdk`, `openai` (as the client for NEAR AI Cloud), `@noble/curves`, `@noble/hashes`, `zod`, TypeScript, and ESLint (Q-005).
- AI assistance: the code and docs were written with Claude Code.
- License: MIT. See [LICENSE](LICENSE).
