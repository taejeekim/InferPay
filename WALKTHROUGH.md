# Walkthrough

Every block below is the real output of the command above it, run in this order from one fresh data directory with no keys set (`payment=mock inference=stub`). `node src/docs/walkthrough.ts --write` regenerates this file, and a test fails when the file and the CLI disagree. Job ids, task ids, and times differ on your machine. Reputation feeds the arithmetic, so the numbers depend on the order.

## 1. Buy an answer the buyer cannot work out alone

The buyer rates its own confidence at 0.20, names the catalog key the answer depends on, and opens a job with the insurance shop at the list price. The shop delivers first and opens that key. The buyer verifies it against the shop's committed root, and only then pays.

```sh
npx inferpay ask "Does this policy cover an outpatient MRI?" --budget 0.10
```

```text
rails: payment=mock inference=stub
fees      none reserved: this rail charges no fee, so all of the 0.10 NEAR budget is left for the price
decide    buy from insurance at 0.02 NEAR (list price)
          value   0.10 NEAR, the budget: the most a right answer is worth
          local   confidence 0.20 x value = worth 0.020 NEAR
          missing this policy's schedule of covered procedures
          needs   insurance   outpatient-mri
          option  insurance   ask 0.02  cover 1.00 x rep 0.70 = quality 0.70  net +0.050
          option  disclosure  ask 0.02  cover 0.00 x rep 0.70 = quality 0.00  net -0.020
          option  legal       ask 0.03  cover 0.00 x rep 0.70 = quality 0.00  net -0.030
          rule    net = quality x value - ask; buy when net >= local worth: 0.050 >= 0.020
job       job_01M7BZETZGDED0N07FX3MZCK08 opened with insurance at the agreed 0.02 NEAR
          order   the shop delivers first; the buyer verifies every proof, then pays for what it verified
summary   Outpatient MRI is covered at a 20 percent copay.
          the shop's own words, not verified; the buyer relies only on the facts it verifies below
checks    1 of 1 needed key opened and verified against the shop's committed root
          verified    match         outpatient MRI  covered
                      Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          root      d26d1609271e…b68f  3 leaves  inferpay-keyed-merkle-sha256-v1
          from      the shop's listing, because the mock rail has no chain
facts     what the buyer relies on, built only from entries it verified:
          outpatient-mri  = covered
            from Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
payout    0.02 NEAR of the agreed 0.02 NEAR: 1 of 1 needed key opened to an entry and verified
          rule    nothing if any check is forged; else agreed x proven / needed, rounded down;
                  proven counts needed keys opened to a verified entry, mismatches included, empty slots not
          sum     0.02 x 1 / 1 = 0.02 NEAR
pay       settled  0.02 NEAR
          from    researcher.kyle.inferpay.testnet
          to      insurance.ban.inferpay.testnet
          via     mock receipt (no NEAR moved)
rate      5/5  = 5
          rule    start at 5; for each key the buyer needed, -1 per mismatch, -1 per empty slot,
                  -1 per key opened with no claim, -2 per key withheld;
                  at least 2 unless a check is forged, and 1 if any check is forged;
                  checks the buyer did not ask for never count
          kept      in this machine's ledger, because the mock rail has no chain
spent     0.02 NEAR price + 0 NEAR fees = 0.02 NEAR of the 0.10 NEAR budget
```

`--budget` is the most a right answer is worth. `local` is what answering alone is worth. `needs` are the keys the buyer requires the shop to open. Each `option` is a shop. The `rule` line shows the comparison with the numbers filled in.

## 2. Answer alone and pay nothing

The buyer is sure of the answer, and no shop's catalog holds a key the question needs.

```sh
npx inferpay ask "What is the capital of France?" --budget 0.10
```

```text
rails: payment=mock inference=stub
fees      none reserved: this rail charges no fee, so all of the 0.10 NEAR budget is left for the price
decide    answer locally, pay nothing
          value   0.10 NEAR, the budget: the most a right answer is worth
          local   confidence 0.99 x value = worth 0.099 NEAR
          missing nothing
          needs   no key from any shop's catalog
          option  disclosure  ask 0.02  cover 0.00 x rep 0.70 = quality 0.00  net -0.020
          option  legal       ask 0.03  cover 0.00 x rep 0.70 = quality 0.00  net -0.030
          option  insurance   ask 0.02  cover 0.00 x rep 0.80 = quality 0.00  net -0.020
          rule    buy only from a shop that covers a missing fact: no shop within the budget does
          rule    answer locally when confidence >= 0.50: 0.99 >= 0.50
answer    Paris is the capital of France.
checks    none, this is the buyer's own answer
spent     0 NEAR price + 0 NEAR fees = 0 NEAR of the 0.10 NEAR budget
```

## 3. Counter once when the ask is over plan

With a smaller budget, the list price is above what the answer is worth to the buyer. The buyer offers its reservation price once. The shop's private floor is below the offer, so the shop accepts.

```sh
npx inferpay ask "Does this policy cover an outpatient MRI?" --budget 0.03
```

```text
rails: payment=mock inference=stub
fees      none reserved: this rail charges no fee, so all of the 0.03 NEAR budget is left for the price
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
job       job_01M7BZEV0SC6H2D1RG12XHTFKR opened with insurance at the agreed 0.018 NEAR
          order   the shop delivers first; the buyer verifies every proof, then pays for what it verified
summary   Outpatient MRI is covered at a 20 percent copay.
          the shop's own words, not verified; the buyer relies only on the facts it verifies below
checks    1 of 1 needed key opened and verified against the shop's committed root
          verified    match         outpatient MRI  covered
                      Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          root      d26d1609271e…b68f  3 leaves  inferpay-keyed-merkle-sha256-v1
          from      the shop's listing, because the mock rail has no chain
facts     what the buyer relies on, built only from entries it verified:
          outpatient-mri  = covered
            from Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
payout    0.018 NEAR of the agreed 0.018 NEAR: 1 of 1 needed key opened to an entry and verified
          rule    nothing if any check is forged; else agreed x proven / needed, rounded down;
                  proven counts needed keys opened to a verified entry, mismatches included, empty slots not
          sum     0.018 x 1 / 1 = 0.018 NEAR
pay       settled  0.018 NEAR
          from    researcher.kyle.inferpay.testnet
          to      insurance.ban.inferpay.testnet
          via     mock receipt (no NEAR moved)
rate      5/5  = 5
          rule    start at 5; for each key the buyer needed, -1 per mismatch, -1 per empty slot,
                  -1 per key opened with no claim, -2 per key withheld;
                  at least 2 unless a check is forged, and 1 if any check is forged;
                  checks the buyer did not ask for never count
          kept      in this machine's ledger, because the mock rail has no chain
spent     0.018 NEAR price + 0 NEAR fees = 0.018 NEAR of the 0.03 NEAR budget
```

## 4. Walk away when the counter is refused

Here the buyer is fairly sure of itself, so its reservation price is low. The offer is below the shop's floor, the shop refuses, and the buyer answers alone.

```sh
npx inferpay ask "What was Samsung's Q3 2025 revenue?" --budget 0.10
```

```text
rails: payment=mock inference=stub
fees      none reserved: this rail charges no fee, so all of the 0.10 NEAR budget is left for the price
decide    answer locally, pay nothing (counter-offer refused)
          value   0.10 NEAR, the budget: the most a right answer is worth
          local   confidence 0.55 x value = worth 0.055 NEAR
          missing the revenue Samsung filed for Q3 2025
          needs   disclosure  Samsung Electronics / Q3 2025 / revenue
          option  disclosure  ask 0.02  cover 1.00 x rep 0.70 = quality 0.70  net +0.050
          option  legal       ask 0.03  cover 0.00 x rep 0.70 = quality 0.00  net -0.030
          option  insurance   ask 0.02  cover 0.00 x rep 0.85 = quality 0.00  net -0.020
          rule    net = quality x value - ask; buy when net >= local worth: 0.050 < 0.055
          reserve (0.70 - 0.55) x 0.10 = 0.015 NEAR, where buying equals the local worth
          counter 0.015 NEAR against the ask of 0.02 NEAR
          reply   disclosure refused, so the buyer walks away
          rule    answer locally when confidence >= 0.50: 0.55 >= 0.50
answer    Samsung reported about KRW 86 trillion in revenue for Q3 2025. I have not checked that against the filing.
checks    none, this is the buyer's own answer
spent     0 NEAR price + 0 NEAR fees = 0 NEAR of the 0.10 NEAR budget
```

## 5. Grade an honest shop that got a figure wrong

In this recording the shop's model claims a 10 percent copay. The shop's own dataset says 20. The shop opens the entry anyway, the buyer sees the mismatch, and the rating drops by one star. The shop's summary still says 10 percent, but the buyer's `facts` come only from the entries it verified, so the buyer relies on 20. The shop opened both needed keys, so it is paid in full.

```sh
npx inferpay ask "What copay does this policy charge for an outpatient MRI?" --budget 0.10
```

```text
rails: payment=mock inference=stub
fees      none reserved: this rail charges no fee, so all of the 0.10 NEAR budget is left for the price
decide    buy from insurance at 0.02 NEAR (list price)
          value   0.10 NEAR, the budget: the most a right answer is worth
          local   confidence 0.20 x value = worth 0.020 NEAR
          missing this policy's MRI copay
          needs   insurance   outpatient-mri; mri-copay
          option  insurance   ask 0.02  cover 1.00 x rep 0.85 = quality 0.85  net +0.065
          option  disclosure  ask 0.02  cover 0.00 x rep 0.70 = quality 0.00  net -0.020
          option  legal       ask 0.03  cover 0.00 x rep 0.70 = quality 0.00  net -0.030
          rule    net = quality x value - ask; buy when net >= local worth: 0.065 >= 0.020
job       job_01M7BZEV1Y31SXQ35R1SAWNRXG opened with insurance at the agreed 0.02 NEAR
          order   the shop delivers first; the buyer verifies every proof, then pays for what it verified
summary   Outpatient MRI is covered with a 10 percent copay.
          the shop's own words, not verified; the buyer relies only on the facts it verifies below
checks    2 of 2 needed keys opened and verified against the shop's committed root
          verified    match         outpatient MRI  covered
                      Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          verified    mismatch      MRI copay       10   ref 20
                      Policy schedule §4.2. Outpatient MRI copay is 20 percent.
          root      d26d1609271e…b68f  3 leaves  inferpay-keyed-merkle-sha256-v1
          from      the shop's listing, because the mock rail has no chain
facts     what the buyer relies on, built only from entries it verified:
          outpatient-mri  = covered
            from Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          mri-copay  = 20
            from Policy schedule §4.2. Outpatient MRI copay is 20 percent.
payout    0.02 NEAR of the agreed 0.02 NEAR: 2 of 2 needed keys opened to an entry and verified
          rule    nothing if any check is forged; else agreed x proven / needed, rounded down;
                  proven counts needed keys opened to a verified entry, mismatches included, empty slots not
          sum     0.02 x 2 / 2 = 0.02 NEAR
pay       settled  0.02 NEAR
          from    researcher.kyle.inferpay.testnet
          to      insurance.ban.inferpay.testnet
          via     mock receipt (no NEAR moved)
rate      4/5  = 5 - 1 x 1 mismatch = 4
          rule    start at 5; for each key the buyer needed, -1 per mismatch, -1 per empty slot,
                  -1 per key opened with no claim, -2 per key withheld;
                  at least 2 unless a check is forged, and 1 if any check is forged;
                  checks the buyer did not ask for never count
          kept      in this machine's ledger, because the mock rail has no chain
spent     0.02 NEAR price + 0 NEAR fees = 0.02 NEAR of the 0.10 NEAR budget
```

## 6. Catch a shop that forges its evidence

`INFERPAY_TEST_LIAR` is a test hook. The named shop rewrites the mismatch into a match and fabricates the evidence. It cannot change the root it already published, so the fabricated evidence does not open to that root. The buyer verifies before it pays, so the forger gets nothing.

```sh
INFERPAY_TEST_LIAR=insurance npx inferpay ask "What copay does this policy charge for an outpatient MRI?" --budget 0.10
```

```text
rails: payment=mock inference=stub
hook      INFERPAY_TEST_LIAR=insurance: this shop rewrites each check that is not a match or a raised flag into one, with forged evidence
fees      none reserved: this rail charges no fee, so all of the 0.10 NEAR budget is left for the price
decide    buy from insurance at 0.02 NEAR (list price)
          value   0.10 NEAR, the budget: the most a right answer is worth
          local   confidence 0.20 x value = worth 0.020 NEAR
          missing this policy's MRI copay
          needs   insurance   outpatient-mri; mri-copay
          option  insurance   ask 0.02  cover 1.00 x rep 0.83 = quality 0.83  net +0.063
          option  disclosure  ask 0.02  cover 0.00 x rep 0.70 = quality 0.00  net -0.020
          option  legal       ask 0.03  cover 0.00 x rep 0.70 = quality 0.00  net -0.030
          rule    net = quality x value - ask; buy when net >= local worth: 0.063 >= 0.020
job       job_01M7BZEV2XJP9S6VX82DW3E5B2 opened with insurance at the agreed 0.02 NEAR
          order   the shop delivers first; the buyer verifies every proof, then pays for what it verified
hook      insurance forged 1 check; the buyer should mark it FORGED and rate insurance 1/5
summary   Outpatient MRI is covered with a 10 percent copay.
          the shop's own words, not verified; the buyer relies only on the facts it verifies below
checks    1 of 2 needed keys opened and verified against the shop's committed root, 1 WITHHELD, 1 FORGED
          verified    match         outpatient MRI  covered
                      Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          FORGED      match         MRI copay       10
                      the shop said match, but its evidence does not open to the committed root
          WITHHELD                  mri-copay
                      the buyer needed this key and the shop sent no verified opening of it
          root      d26d1609271e…b68f  3 leaves  inferpay-keyed-merkle-sha256-v1
          from      the shop's listing, because the mock rail has no chain
facts     what the buyer relies on, built only from entries it verified:
          outpatient-mri  = covered
            from Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          mri-copay  not proven: no verified opening, so the buyer has no value for it
payout    nothing of the agreed 0.02 NEAR: 1 check FORGED
          rule    nothing if any check is forged; else agreed x proven / needed, rounded down;
                  proven counts needed keys opened to a verified entry, mismatches included, empty slots not
          sum     a forged check leaves nothing owed: 0 NEAR
pay       nothing sent: a forged check voids the payout, and no transfer is ever attempted for this job
rate      1/5  forged evidence sets the rating to 1
          rule    start at 5; for each key the buyer needed, -1 per mismatch, -1 per empty slot,
                  -1 per key opened with no claim, -2 per key withheld;
                  at least 2 unless a check is forged, and 1 if any check is forged;
                  checks the buyer did not ask for never count
          kept      in this machine's ledger, because the mock rail has no chain
spent     0 NEAR price + 0 NEAR fees = 0 NEAR of the 0.10 NEAR budget
```

## 7. Catch a shop that leaves a needed key out

`INFERPAY_TEST_WITHHOLD` is the other test hook. The named shop drops the check that does not back its answer. The buyer named that key as needed, so the missing opening is marked `WITHHELD`. It costs the shop that key's share of the price and two stars, which is more than the honest mismatch cost.

```sh
INFERPAY_TEST_WITHHOLD=insurance npx inferpay ask "What copay does this policy charge for an outpatient MRI?" --budget 0.10
```

```text
rails: payment=mock inference=stub
hook      INFERPAY_TEST_WITHHOLD=insurance: this shop drops each check that does not back its answer, needed keys included
fees      none reserved: this rail charges no fee, so all of the 0.10 NEAR budget is left for the price
decide    buy from insurance at 0.02 NEAR (list price)
          value   0.10 NEAR, the budget: the most a right answer is worth
          local   confidence 0.20 x value = worth 0.020 NEAR
          missing this policy's MRI copay
          needs   insurance   outpatient-mri; mri-copay
          option  insurance   ask 0.02  cover 1.00 x rep 0.69 = quality 0.69  net +0.049
          option  disclosure  ask 0.02  cover 0.00 x rep 0.70 = quality 0.00  net -0.020
          option  legal       ask 0.03  cover 0.00 x rep 0.70 = quality 0.00  net -0.030
          rule    net = quality x value - ask; buy when net >= local worth: 0.049 >= 0.020
job       job_01M7BZEV3KGW6KYF2C2DXJJT2P opened with insurance at the agreed 0.02 NEAR
          order   the shop delivers first; the buyer verifies every proof, then pays for what it verified
hook      insurance dropped 1 check; the buyer should mark each needed key it dropped WITHHELD
summary   Outpatient MRI is covered with a 10 percent copay.
          the shop's own words, not verified; the buyer relies only on the facts it verifies below
checks    1 of 2 needed keys opened and verified against the shop's committed root, 1 WITHHELD
          verified    match         outpatient MRI  covered
                      Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          WITHHELD                  mri-copay
                      the buyer needed this key and the shop sent no verified opening of it
          root      d26d1609271e…b68f  3 leaves  inferpay-keyed-merkle-sha256-v1
          from      the shop's listing, because the mock rail has no chain
facts     what the buyer relies on, built only from entries it verified:
          outpatient-mri  = covered
            from Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          mri-copay  not proven: no verified opening, so the buyer has no value for it
payout    0.01 NEAR of the agreed 0.02 NEAR: 1 of 2 needed keys opened to an entry and verified
          rule    nothing if any check is forged; else agreed x proven / needed, rounded down;
                  proven counts needed keys opened to a verified entry, mismatches included, empty slots not
          sum     0.02 x 1 / 2 = 0.01 NEAR
pay       settled  0.01 NEAR
          from    researcher.kyle.inferpay.testnet
          to      insurance.ban.inferpay.testnet
          via     mock receipt (no NEAR moved)
rate      3/5  = 5 - 2 x 1 withheld = 3
          rule    start at 5; for each key the buyer needed, -1 per mismatch, -1 per empty slot,
                  -1 per key opened with no claim, -2 per key withheld;
                  at least 2 unless a check is forged, and 1 if any check is forged;
                  checks the buyer did not ask for never count
          kept      in this machine's ledger, because the mock rail has no chain
spent     0.01 NEAR price + 0 NEAR fees = 0.01 NEAR of the 0.10 NEAR budget
```

## 8. Give it a whole task and one budget

The buyer splits the task into parts, gives each part a share of the budget, and carries what a part leaves unspent to the next part. It ends with one receipt that shows, per part, the agreed price, what the buyer paid after verifying, and the fees. On the mock rail no fee is charged; on testnet the fees come out of the same budget.

```sh
npx inferpay task "Brief me for Monday: France's capital, our NDA's indemnity clause, outpatient MRI cover, and Samsung's Q3 2025 operating profit" --budget 0.10
```

```text
rails: payment=mock inference=stub
plan      4 parts under one budget of 0.10 NEAR, each given its share of it
          1  20%  0.02 NEAR  What is the capital of France?
          2  20%  0.02 NEAR  Does this NDA's unlimited indemnification clause fail our playbook?
          3  30%  0.03 NEAR  Does this policy cover an outpatient MRI?
          4  30%  0.03 NEAR  What was Samsung's Q3 2025 operating profit?
          carry   parts run in order, and what a part leaves unspent is added to the next part's allotment,
                  so a cheap part can fund a dearer one and the task never pays more than 0.10 NEAR

part 1/4  What is the capital of France?
          allot   0.02 NEAR share + 0 NEAR carried = 0.02 NEAR
fees      none reserved: this rail charges no fee, so all of the 0.02 NEAR part's allotment is left for the price
decide    answer locally, pay nothing
          value   0.02 NEAR, the part's allotment: the most a right answer is worth
          local   confidence 0.99 x value = worth 0.0198 NEAR
          missing nothing
          needs   no key from any shop's catalog
          option  disclosure  ask 0.02  cover 0.00 x rep 0.70 = quality 0.00  net -0.020
          option  insurance   ask 0.02  cover 0.00 x rep 0.66 = quality 0.00  net -0.020
          option  legal       ask 0.03  outside the 0.02 NEAR allotment
          rule    buy only from a shop that covers a missing fact: no shop within the allotment does
          rule    answer locally when confidence >= 0.50: 0.99 >= 0.50
answer    Paris is the capital of France.
checks    none, this is the buyer's own answer
unspent   0.02 NEAR - 0 NEAR price - 0 NEAR fees = 0.02 NEAR, carried to part 2

part 2/4  Does this NDA's unlimited indemnification clause fail our playbook?
          allot   0.02 NEAR share + 0.02 NEAR carried = 0.04 NEAR
fees      none reserved: this rail charges no fee, so all of the 0.04 NEAR part's allotment is left for the price
decide    buy from legal at 0.024 NEAR (counter-offer accepted)
          value   0.04 NEAR, the part's allotment: the most a right answer is worth
          local   confidence 0.10 x value = worth 0.004 NEAR
          missing the playbook's position on indemnification
          needs   legal       uncapped-indemnity on "unlimited indemnification clause"
          option  legal       ask 0.03  cover 1.00 x rep 0.70 = quality 0.70  net -0.002
          option  disclosure  ask 0.02  cover 0.00 x rep 0.70 = quality 0.00  net -0.020
          option  insurance   ask 0.02  cover 0.00 x rep 0.66 = quality 0.00  net -0.020
          rule    net = quality x value - ask; buy when net >= local worth: -0.002 < 0.004
          reserve (0.70 - 0.10) x 0.04 = 0.024 NEAR, where buying equals the local worth
          counter 0.024 NEAR against the ask of 0.03 NEAR
          reply   legal accepted
job       job_01M7BZEV4JKSQVXRYNZJB8FT4Z opened with legal at the agreed 0.024 NEAR
          order   the shop delivers first; the buyer verifies every proof, then pays for what it verified
summary   The unlimited indemnification clause fails the playbook.
          the shop's own words, not verified; the buyer relies only on the facts it verifies below
checks    1 of 1 needed key opened and verified against the shop's committed root
          verified    raised        indemnity
                      The playbook rejects unlimited indemnification. Cap it or delete it.
          root      4a19e743ea74…d9b5  2 leaves  inferpay-keyed-merkle-sha256-v1
          from      the shop's listing, because the mock rail has no chain
facts     what the buyer relies on, built only from entries it verified:
          uncapped-indemnity on "unlimited indemnification clause"  applies to the quoted clause
            The playbook rejects unlimited indemnification. Cap it or delete it.
payout    0.024 NEAR of the agreed 0.024 NEAR: 1 of 1 needed key opened to an entry and verified
          rule    nothing if any check is forged; else agreed x proven / needed, rounded down;
                  proven counts needed keys opened to a verified entry, mismatches included, empty slots not
          sum     0.024 x 1 / 1 = 0.024 NEAR
pay       settled  0.024 NEAR
          from    researcher.kyle.inferpay.testnet
          to      legal.stella.inferpay.testnet
          via     mock receipt (no NEAR moved)
rate      5/5  = 5
          rule    start at 5; for each key the buyer needed, -1 per mismatch, -1 per empty slot,
                  -1 per key opened with no claim, -2 per key withheld;
                  at least 2 unless a check is forged, and 1 if any check is forged;
                  checks the buyer did not ask for never count
          kept      in this machine's ledger, because the mock rail has no chain
unspent   0.04 NEAR - 0.024 NEAR price - 0 NEAR fees = 0.016 NEAR, carried to part 3

part 3/4  Does this policy cover an outpatient MRI?
          allot   0.03 NEAR share + 0.016 NEAR carried = 0.046 NEAR
fees      none reserved: this rail charges no fee, so all of the 0.046 NEAR part's allotment is left for the price
decide    buy from insurance at 0.02 NEAR (list price)
          value   0.046 NEAR, the part's allotment: the most a right answer is worth
          local   confidence 0.20 x value = worth 0.0092 NEAR
          missing this policy's schedule of covered procedures
          needs   insurance   outpatient-mri
          option  insurance   ask 0.02  cover 1.00 x rep 0.66 = quality 0.66  net +0.01036
          option  disclosure  ask 0.02  cover 0.00 x rep 0.70 = quality 0.00  net -0.020
          option  legal       ask 0.03  cover 0.00 x rep 0.80 = quality 0.00  net -0.030
          rule    net = quality x value - ask; buy when net >= local worth: 0.01036 >= 0.0092
job       job_01M7BZEV5K8QVXQ6RPAH63G3GS opened with insurance at the agreed 0.02 NEAR
          order   the shop delivers first; the buyer verifies every proof, then pays for what it verified
summary   Outpatient MRI is covered at a 20 percent copay.
          the shop's own words, not verified; the buyer relies only on the facts it verifies below
checks    1 of 1 needed key opened and verified against the shop's committed root
          verified    match         outpatient MRI  covered
                      Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
          root      d26d1609271e…b68f  3 leaves  inferpay-keyed-merkle-sha256-v1
          from      the shop's listing, because the mock rail has no chain
facts     what the buyer relies on, built only from entries it verified:
          outpatient-mri  = covered
            from Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
payout    0.02 NEAR of the agreed 0.02 NEAR: 1 of 1 needed key opened to an entry and verified
          rule    nothing if any check is forged; else agreed x proven / needed, rounded down;
                  proven counts needed keys opened to a verified entry, mismatches included, empty slots not
          sum     0.02 x 1 / 1 = 0.02 NEAR
pay       settled  0.02 NEAR
          from    researcher.kyle.inferpay.testnet
          to      insurance.ban.inferpay.testnet
          via     mock receipt (no NEAR moved)
rate      5/5  = 5
          rule    start at 5; for each key the buyer needed, -1 per mismatch, -1 per empty slot,
                  -1 per key opened with no claim, -2 per key withheld;
                  at least 2 unless a check is forged, and 1 if any check is forged;
                  checks the buyer did not ask for never count
          kept      in this machine's ledger, because the mock rail has no chain
unspent   0.046 NEAR - 0.02 NEAR price - 0 NEAR fees = 0.026 NEAR, carried to part 4

part 4/4  What was Samsung's Q3 2025 operating profit?
          allot   0.03 NEAR share + 0.026 NEAR carried = 0.056 NEAR
fees      none reserved: this rail charges no fee, so all of the 0.056 NEAR part's allotment is left for the price
decide    buy from disclosure at 0.02 NEAR (list price)
          value   0.056 NEAR, the part's allotment: the most a right answer is worth
          local   confidence 0.30 x value = worth 0.0168 NEAR
          missing the operating profit Samsung filed for Q3 2025
          needs   disclosure  Samsung Electronics / Q3 2025 / operating profit
          option  disclosure  ask 0.02  cover 1.00 x rep 0.70 = quality 0.70  net +0.0192
          option  legal       ask 0.03  cover 0.00 x rep 0.80 = quality 0.00  net -0.030
          option  insurance   ask 0.02  cover 0.00 x rep 0.71 = quality 0.00  net -0.020
          rule    net = quality x value - ask; buy when net >= local worth: 0.0192 >= 0.0168
job       job_01M7BZEV6RNWKVJG6YDTK30JGX opened with disclosure at the agreed 0.02 NEAR
          order   the shop delivers first; the buyer verifies every proof, then pays for what it verified
summary   Operating profit matches across both documents: KRW 12.2T.
          the shop's own words, not verified; the buyer relies only on the facts it verifies below
checks    1 of 1 needed key opened and verified against the shop's committed root, 1 unrequested
          verified    match         operating profit Q3 2025  12.2T KRW
                      Samsung Electronics Q3 2025 earnings release
          unrequested mismatch      revenue Q3 2025           86.0T KRW   ref 86.1T KRW (-0.12%)
                      Samsung Electronics Q3 2025 earnings release
                      the buyer did not ask for this key, so it counts neither for nor against the shop
          root      4bc59b533ac3…a40a  2 leaves  inferpay-keyed-merkle-sha256-v1
          from      the shop's listing, because the mock rail has no chain
facts     what the buyer relies on, built only from entries it verified:
          Samsung Electronics / Q3 2025 / operating profit  = 12.2T KRW
            from Samsung Electronics Q3 2025 earnings release
payout    0.02 NEAR of the agreed 0.02 NEAR: 1 of 1 needed key opened to an entry and verified
          rule    nothing if any check is forged; else agreed x proven / needed, rounded down;
                  proven counts needed keys opened to a verified entry, mismatches included, empty slots not
          sum     0.02 x 1 / 1 = 0.02 NEAR
pay       settled  0.02 NEAR
          from    researcher.kyle.inferpay.testnet
          to      disclosure.david.inferpay.testnet
          via     mock receipt (no NEAR moved)
rate      5/5  = 5
          rule    start at 5; for each key the buyer needed, -1 per mismatch, -1 per empty slot,
                  -1 per key opened with no claim, -2 per key withheld;
                  at least 2 unless a check is forged, and 1 if any check is forged;
                  checks the buyer did not ask for never count
          kept      in this machine's ledger, because the mock rail has no chain
unspent   0.056 NEAR - 0.02 NEAR price - 0 NEAR fees = 0.036 NEAR, kept: this was the last part

receipt   task_01M7BZEV7SHG2Q0CRJ71RNAR3K
          task    Brief me for Monday: France's capital, our NDA's indemnity clause, outpatient MRI cover, and Samsung's Q3 2025 operating profit
          #  DONE BY                            LIST  AGREED            PAID        FEES  CHECK
          1  the buyer itself                   -     -                 nothing     -     own answer, confidence 0.99
             asked  What is the capital of France?
          2  legal.stella.inferpay.testnet      0.03  0.024 on counter  0.024 NEAR  -     1 verified; rated 5/5
             asked  Does this NDA's unlimited indemnification clause fail our playbook?
             fact   uncapped-indemnity on "unlimited indemnification clause" applies to the quoted clause
             job    job_01M7BZEV4JKSQVXRYNZJB8FT4Z
          3  insurance.ban.inferpay.testnet     0.02  0.02 at list      0.02 NEAR   -     1 verified; rated 5/5
             asked  Does this policy cover an outpatient MRI?
             fact   outpatient-mri = covered
             job    job_01M7BZEV5K8QVXQ6RPAH63G3GS
          4  disclosure.david.inferpay.testnet  0.02  0.02 at list      0.02 NEAR   -     1 verified; rated 5/5
             asked  What was Samsung's Q3 2025 operating profit?
             fact   Samsung Electronics / Q3 2025 / operating profit = 12.2T KRW
             job    job_01M7BZEV6RNWKVJG6YDTK30JGX
total     prices 0.064 NEAR + fees 0 NEAR = 0.064 NEAR of the 0.10 NEAR budget, 0.036 NEAR left
fees      none on this run: no part paid a network fee
saved     .inferpay/tasks/task_01M7BZEV7SHG2Q0CRJ71RNAR3K.json
```

## 9. Ask something with no recording

Without a NEAR AI key the stub replays recorded questions only. Any other question stops before a job opens.

```sh
npx inferpay ask "Schedule a meeting on Monday" --budget 0.10
```

```text
rails: payment=mock inference=stub
spent     0 NEAR price + 0 NEAR fees = 0 NEAR of the 0.10 NEAR budget
Inference failed. No NEAR moved. The stub replays only these recorded questions:
  npx inferpay ask "What was Samsung's Q3 2025 operating profit?" --budget 0.10
  npx inferpay ask "Does Samsung Electronics' Q3 2025 operating profit in the earnings release match the quarterly report?" --budget 0.10
  npx inferpay ask "What was Samsung's Q3 2025 capex?" --budget 0.10
  npx inferpay ask "What was Samsung's Q3 2025 revenue?" --budget 0.10
  npx inferpay ask "Does this NDA's unlimited indemnification clause fail our playbook?" --budget 0.10
  npx inferpay ask "Does this policy cover an outpatient MRI?" --budget 0.10
  npx inferpay ask "Does this policy cover cosmetic surgery?" --budget 0.10
  npx inferpay ask "Does our NDA's three-year confidentiality term fail our playbook?" --budget 0.10
  npx inferpay ask "What copay does this policy charge for an outpatient MRI?" --budget 0.10
  npx inferpay ask "What is the capital of France?" --budget 0.10
Set NEAR_AI_API_KEY to ask anything.
```

The command exits with code 1.

## 10. List the shops

Reputation comes from the ratings above. The catalog is what a buyer may require a shop to open.

```sh
npx inferpay providers
```

```text
rails: payment=mock inference=stub
ID          OWNER                    PAY TO                             SPECIALTY                                          PRICE      JOBS  RATING
disclosure  david.inferpay.testnet   disclosure.david.inferpay.testnet  Disclosure analysis, number cross-check            0.02 NEAR  1     5.0 (1)
legal       stella.inferpay.testnet  legal.stella.inferpay.testnet      Contract clause review against a private playbook  0.03 NEAR  1     5.0 (1)
insurance   ban.inferpay.testnet     insurance.ban.inferpay.testnet     Private policy schedule: MRI, copay, exclusions    0.02 NEAR  6     3.8 (6)

reputation  this machine's job ledger, because the mock rail has no chain
commitment  each root is from the shop's listing, because the mock rail has no chain
            disclosure  4bc59b533ac3…a40a  2 leaves
            legal       4a19e743ea74…d9b5  2 leaves
            insurance   d26d1609271e…b68f  3 leaves
catalog     the keys each shop holds an entry for, without their values; a buyer may require only these opened
            disclosure  Samsung Electronics / Q3 2025 / operating profit; Samsung Electronics / Q3 2025 / revenue
            legal       uncapped-indemnity; perpetual-nda
            insurance   outpatient-mri; cosmetic-surgery; mri-copay
```

## 11. Read one job's log

This is the job from the counter-offer step, in the order it happened. The `quote` is the agreed price. The lines under `delivered` are the shop's answer and the evidence for each check. `payout-decided` is what the buyer owed after verifying, and only then does the payment appear.

```sh
npx inferpay job job_01M7BZEV0SC6H2D1RG12XHTFKR
```

```text
rails: payment=mock inference=stub
opened            02:51:18 UTC  insurance  quote 0.018 NEAR  budget 0.03 NEAR  researcher.kyle.inferpay.testnet -> insurance.ban.inferpay.testnet
                  commitment d26d1609271e8c546648dc3d83990ff7540d60bf40cdf738d693ec655602b68f
                             3 leaves, inferpay-keyed-merkle-sha256-v1, from the shop's listing
                  needs      outpatient-mri
delivered         02:51:18 UTC  1 check; 1 of 1 needed key opened, 0 withheld
                  summary    Outpatient MRI is covered at a 20 percent copay.  (the shop's words, not verified)
                  verified  match  outpatient MRI
                    key       ["fact","outpatient-mri"]
                    slot      2246468
                    entry     {"kind":"fact","source":"Policy schedule §4.2. Outpatient MRI is covered at 20% copay.","topic":"outpatient-mri","value":"covered"}
                    salt      c2820c363f28424d6f529b46d086e8e272e20f43820a7532b143a296ed52d470
                    leaf      15f92631588a70ae266c9eceb227ac4c809c9a3be56b5707e8020baac42ea763
                    level 30  8e40665dd381bd01781149ce8b210ddc7ea07112aee780e879a58e2bc7369b64
                    path      32 levels, 31 of them empty subtrees
                    root      equals the commitment above
                  facts     what the buyer relies on, built only from entries it verified:
                            outpatient-mri  = covered
                              from Policy schedule §4.2. Outpatient MRI is covered at 20% copay.
payout-decided    02:51:18 UTC  0.018 NEAR of the agreed 0.018 NEAR: 1 of 1 needed key opened to an entry and verified
                  0.018 x 1 / 1 = 0.018 NEAR
payment-intended  02:51:18 UTC  key mock_7fd7ace2-2f9c-4677-9c79-b2e9d5257104
payment-settled   02:51:18 UTC  0.018 NEAR to insurance.ban.inferpay.testnet  correlation mock-8c01
rated             02:51:18 UTC  5/5
```
