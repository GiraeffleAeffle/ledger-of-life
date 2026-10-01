# Shared shares, loans and lending · Robinhood testnet

## Deployment is a prerequisite, not a demo fallback

The application uses one shared market on Robinhood Chain testnet **46630**, loaded from `contracts/evm/deployments/shared-market-46630.json`. A missing or unverifiable deployment is shown as **undeployed**: no invented address, price, liquidity, earnings or position replaces it. This cutover does not claim a live deployment or a completed shared-market wallet rehearsal.

The person signs with their own Privy EVM wallet. Obtain **five official test TSLA and test ETH** from [Robinhood's official faucet](https://faucet.testnet.chain.robinhood.com/), subject to its daily limits. The stock is Robinhood's official test TSLA, not project-minted fake stock. Get test dollars through the existing wallet-signed tUSDG mint. **tUSDG is test dollars anyone can mint; unlimited repeated mint calls are possible. It has no monetary value and is not income, euros or redeemable cash.** Nothing bridges Solana assets.

## One valuation path

`MirroredPriceFeed` copies [Chainlink RHTSLA/USD on Robinhood mainnet 4663](https://robinhoodchain.blockscout.com/address/0x4A1166a659A55625345e9515b32adECea5547C38), **converted to the test token's multiplier**. This is a Robinhood token price, not a headline Tesla share quote. The testnet mirror is **not a Chainlink contract** and no native Chainlink testnet feed is claimed.

The hosted price job reads the source round and timestamp, checks pauses and multipliers, and uses Jupiter TSLAx as an independent cross-check. It copies a new acceptable round; it does not choose a scenario price. The immutable updater key's sole contract power is to push a price: it cannot withdraw or move pool funds. The contract requires increasing rounds/timestamps, bounded future timestamps, at least 60 seconds between pushes and a per-push movement bound scaled by elapsed time, capped at 20% after one hour; the first push is bounded against the immutable deployment anchor. Nothing on-chain proves the copy matches mainnet: updater honesty and RPC availability remain risks.

Mainnet and testnet multipliers need not match. The updater converts `mainnet_answer × testnetMultiplier / mainnetMultiplier`, rounding down, before pushing. It reads the official test token's `uiMultiplier()` (1e18 if absent), and journals the raw mainnet answer and both multipliers. The `push` parameter named `sourceMultiplier` records the **test-token multiplier used for conversion**; a later test-token multiplier mismatch makes `latestPrice()` return zero, freezing price-sensitive actions until an acceptable new round is copied.

Wallet TSLA, collateral and loan valuation use this same mirror. The interface exposes the source round, source time, copied time, age, source feed and chain, and stale state. It labels Saturday 00:00 UTC through Monday 12:00 UTC as the **weekend freshness window (74 hours)**, not as a claim that trading is closed. Normal freshness is 26 hours. Before the first push there is no price provenance: no mainnet round has been copied yet. Stale, unset or suspended prices are unavailable, never displayed as zero-dollar quotes. Longer holidays or a failed updater freeze price-sensitive actions rather than substituting Jupiter or an operator quote.

## The hourly price job and its health

An operator job (`scripts/reconcile.mjs`, scope `price`, hourly) runs `reconcileTslaPrice`. After every run the route `POST /api/jobs/reconcile?scope=price` stores the outcome under `tsla-price-job:last`: status (`pushed`, `skipped`, `unconfigured`, `failed`), the skip reason, the source round id and its time, the time of the run, and the last successful copy (time, round, transaction). `GET /api/status` returns it as `market.priceJob`, and the loan panel shows it under the price lines and in "Price source & pool facts".

`health` is `ok` when the last run copied a round, `waiting` when it skipped only because nothing newer exists (`same_or_older_round`, `push_interval`, `nonincreasing_source_time`), and `attention` for every other skip (stale or paused source, Jupiter cross-check unavailable or divergent, movement bound, RPC trouble), for an unconfigured or failed run, for a job that never reported, and for no run in over three hours. A skipped run is therefore never reported as healthy. The job state does not change what the contract accepts: the pool still decides freshness (26 h, 74 h in the weekend window) from the copied source time.

The panel keeps two times apart: the **source round** (when Chainlink published the price on mainnet, which is what freshness is measured from) and the **copy** (when the job wrote it to this chain). The line above the Borrow form states the pool's cash, your limit and the price age.

## Leaving in kind

There is no sale and no exchange. To exit, repay the debt (enter a little more than owed; Repay takes only what is owed because interest accrues every second) and withdraw the collateral: the same test TSLA returns to the wallet. With no debt, withdrawing needs no price. Only liquidation seizes collateral. Every confirmed action shows an explorer link for each transaction it sent (approval and market call).

## Evidence for a hosted run

`node scripts/prove-loan-cycle.mjs <wallet> <txHash>...` reads the public RPC only (no key, no transaction) and prints JSON: each receipt (status, block, target, decoded pool or token call), the wallet's position, balances and pool market, and the mirrored price with its source time and age. It records what the chain says; it does not decide whether a run counts as evidence.

## Wallet-signed actions

| Action | What actually happens |
| --- | --- |
| Deposit collateral | Approve the pool for the exact official test TSLA amount, then transfer collateral into the pool. No price is needed. |
| Borrow | Receive tUSDG from pool cash; post-borrow loan-to-value must not exceed 50%, utilization must not exceed 90%, and the price must be fresh. |
| Repay | Approve the exact tUSDG amount and repay debt plus accrued interest. Repayment remains possible when pricing is stale. |
| Withdraw collateral | Return the person's collateral; with debt, freshness and the borrowing limit apply. With no debt, no price is needed. |
| Lend test dollars | Approve an exact tUSDG amount and deposit for lender shares owned by the signer. |
| Unlend | Withdraw/redeem the signer's lender position, limited by available pool cash. |
| Liquidate | Any person can repay part of an unhealthy borrower's debt with their own tUSDG and receive seized official test TSLA. |

`GET /api/share-workflows` returns `{workflow}` with shared-market observations. POST supports only `prepare` (`operation`, `quantity`, optional `borrower`) and `submit` (`signed`); operations are `deposit_collateral`, `withdraw_collateral`, `borrow`, `repay`, `lend`, `unlend`, and `liquidate`. Preparation returns the wallet id and reviewed signing steps. Submission decodes calldata: only exact supported token approvals to the pool and supported pool methods, chain 46630, zero native value, and signer-owned receivers/owners are accepted. There is no start, demo preparation, price control or injected-yield operation on this route.

The editable amount is a human quantity: collateral actions accept up to 18 decimal places of official test TSLA; dollar actions accept up to 6 decimal places of tUSDG. Review and signing descriptions include that quantity and unit. Excess precision is rejected rather than rounded silently. Atomic values are sent to the server.

Wallet reads never scan the borrower registry and no longer return `unhealthyLoans`. They expose `suspended`, `suspensionReasons`, and pool `effectiveBorrowApyBps` alongside nominal `borrowAprBps` (500). Liquidation discovery is separate and on demand: `GET /api/share-workflows?view=unhealthy&cursor=0&pageSize=20` returns `{page:{loans:[{borrower,debtAtomic,sharesRaw,ltvBps}],nextCursor:string|null,scanned:number,observedAt:number,suspended:boolean,suspensionReasons:string[]}}`. Follow `nextCursor` to continue; each page reports how many registry entries were scanned, not a complete-market assertion.

`observedAt` is a Unix timestamp in **seconds**. Wallet balances remain independent of deployment: undeployed reads query the official tokens and use `null` for an unreadable quantity, never a factual zero. Missing, stale, suspended or unpriced stock prevents a complete priced subtotal when stock is held or its quantity is unknown.

## Borrower interest, lenders and seed

Borrowings accrue continuously at a **5% nominal annual rate**, approximately **5.13% effective annually**. The UI reads `effectiveBorrowApyBps` from the contract instead of computing a projection or assuming simple interest. Lender share value increases by the same accrued interest; there is no yield injection, fee recipient or operator withdrawal lever. The displayed supply rate is a current utilization-based rate, not a projected or guaranteed return. Earned value is current lender value minus net contribution and can be negative after bad debt.

Deployment seeds **10,000 tUSDG to shares owned by the burn address `0x000000000000000000000000000000000000dEaD`**. Nobody can redeem those shares. The seed's proportionate interest stays locked too; it is disclosed separately from independent lender participation. All subsequent borrowable cash comes from lenders, including compatible rental escrows. Interest becomes cash only when borrowers or liquidators repay. A lender may have a claim but insufficient cash to withdraw it.

## Liquidation is not a scenario button

The UI loads unhealthy loans only when requested, in bounded registry pages; normal wallet reads do not scan the registry. At **80% loan-to-value**, anyone may liquidate with a fresh price while the market is not suspended. Each liquidation repays at most 50% of debt and seizes collateral with a 10% bonus, bounded by available collateral. If collateral reaches zero, remaining debt is written off and lender value falls. There is no operator liquidation bot or price-drop lever. A loan opened at 50% needs about a 37.5% actual token-price decline to reach the threshold before interest accrual; a live liquidation cannot honestly be staged on demand. Contract tests, rather than fabricated market moves, demonstrate those boundaries.

Stale pricing blocks borrowing, withdrawing collateral with debt, and liquidation. Lending, adding collateral, repayment, cash-limited lender withdrawal, and debt-free collateral withdrawal remain possible. Robinhood retains issuer powers to pause/block accounts, burn tokens held by a pool, or upgrade the stock implementation; those are external risks, not app controls.

Issuer suspension is distinct from stale pricing: TSLA paused, the pool blocked by the issuer, an implementation change, or collateral custody below recorded collateral suspends the market. Suspension blocks collateral deposits and withdrawals, borrowing and liquidation, and withholds TSLA valuations. Dollar-only lending, repayment and cash-limited lender withdrawal remain available because tUSDG is separate from the suspended collateral token. Wallet and liquidation-page reads expose the suspension reasons. The collateral issuer identity and implementation are immutable deployment pins, not silently refreshed after an upgrade. Robinhood's issuer powers remain external risks; neither a fresh price nor an updater can override suspension.

## Rental deposits and localhost

The former `CollateralEscrow` app flow is removed. The current share-backed tenancy uses `ShareDeposit` and `ShareDepositFactory`, operated in **Home**, not the loan panel. The catalogue keeps its existing prototype status until hosted three-account proof is recorded; the app implementation is built and that proof is pending. Distinct landlord, tenant and invited arbitrator accounts each use verified EVM wallets. The public manifest `contracts/evm/deployments/share-deposit-46630.json` pins the deployment; missing/null addresses disable the feature without a demo fallback.

`RentalEscrow` and `MorphoAdapter` can use the shared pool as their vault. The separate **local-only `/api/share-earnings`** rehearsal discloses `operator.key` as the test landlord and `arbitrator.key` as the test arbitrator. The tenant obtains gas from Robinhood's official faucet, self-mints **1,501 tUSDG**, and signs acceptance, funding, pool supply and earnings claim. A verified pool manifest is required. Earnings are **borrower-funded interest**, never manufactured yield or operator funding. Principal remains protected by the escrow; release and settlement roll back if the pool lacks cash. Production disables this rehearsal **even when `ALLOW_OPERATOR_TEST_ACTIONS` is set**. It is not an operation on the prepare/submit-only share route; old per-wallet store keys stay untouched and unused.

Incomplete local setup is returned as `starting`, so the setup control can resume the journal instead of hiding the rehearsal. Preparing tenant signatures requires test ETH. A refused broadcast restores its reviewed call only after the node proves it does not know the hash; unknown or known broadcasts remain reserved until a receipt, consumed nonce or aged-null lookup resolves them. Domain errors are shown with their actual message.

Localhost reads the same manifest and chain market as hosted clients. The hosted job maintains the mirror; **localhost needs no updater key and must not run a second updater**.

### Share-deposit prepare, sign and reconcile

`GET /api/share-deposit?rentalId=...` returns `{view}` with accepted terms, role-derived actions, actual custody, wallet shares, quote source/copy times, price-job health and fixed deadlines. `GET /api/share-deposit?listingId=...` quotes 150% required versus the verified applicant’s held shares before Apply. `POST` prepares an exact durable plan, then accepts only its exact wallet-signed raw transaction; the server broadcasts but never signs. Chain, value, calldata, signer, nonce, gas and fee fields must match. Repeated submit with the bound transaction hash reconciles its receipt and expected events; merely sending a transaction never advances Home.
An unknown rejected broadcast leaves no pending binding; a mined revert is a terminal failed receipt, allowing another valid action. Quotes are null on read failure/zero observations, not a $0 price. Active withdrawal reviews show the exact maximum shares that preserve 150%; malformed zero withdrawal and under-bound acceptance are rejected before estimation. Every review includes the accepted Terms and predicted CREATE2 target for independent wallet-side binding.

The landlord creates and proposes/lowers claims. The tenant approves exactly, pledges, withdraws extra, requests return and accepts/contests. The arbitrator resolves only after contested/escalated authority. Agreement parties can activate, escalate an expired response, close an expired unclaimed return, close an expired unresolved arbitration and trigger either fixed payout side. Evidence records are bound into the proposal hash and persist only after the matching confirmed receipt. Every quote-dependent review shows human shares, USD-at-quote and timestamps; proposal shares are an estimate until the transaction’s quote fixes the conversion.

No shares are sold, lent or used as loan collateral by this rental escrow. 150% activates and permits extra withdrawals; below 125% asks for a top-up without enforcement. Silence never awards the landlord. Claims convert once; subsequent decisions and exits are price-free. After the arbitration window anyone can return the deposit to the tenant. Outstanding landlord awards have priority, with independent fixed-recipient payouts and actual custody verification. Issuer pause/block/burn/upgrade remains disclosed; factory and full term read-back plus issuer safety checks refuse unsafe inflows, without an app safety gate over exits. Test tokens have no monetary value and no legal advice is given.


## Historical evidence is not shared-market proof

[SHARE_WORKFLOWS_ROBINHOOD_TESTNET.json](evidence/SHARE_WORKFLOWS_ROBINHOOD_TESTNET.json) and [BORROW_TO_LOCAL_AI_ROBINHOOD_TESTNET.json](evidence/BORROW_TO_LOCAL_AI_ROBINHOOD_TESTNET.json) record the **historical per-wallet fake-stock/operator-priced implementation**. They do not prove official-stock shared-pool lending, mirror valuation, independent liquidity or borrower-funded earnings. Earlier official-stock collateral cycles likewise used a simulated oracle and operator desk. Preserve their transaction facts without promoting them to evidence of this cutover.

Old per-wallet contracts and store keys (`share-workflows:*`, `share-control:*`, `share-earnings:*`, `ownership-example:*`) remain on-chain/in storage but are unused, not reset or migrated, and no longer surfaced as current positions. Shared-market live evidence must be recorded separately only after an actual rehearsal.
