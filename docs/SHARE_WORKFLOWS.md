# Shared shares, loans and lending · Robinhood testnet

## Deployment is a prerequisite, not a demo fallback

The application uses one shared market on Robinhood Chain testnet **46630**, loaded from `contracts/evm/deployments/shared-market-46630.json`. A missing or unverifiable deployment is shown as **undeployed**: no invented address, price, liquidity, earnings or position replaces it. This cutover does not claim a live deployment or a completed shared-market wallet rehearsal.

The person signs with their own Privy EVM wallet. Obtain **five official test TSLA and test ETH** from [Robinhood's official faucet](https://faucet.testnet.chain.robinhood.com/), subject to its daily limits. The stock is Robinhood's official test TSLA, not project-minted fake stock. Get test dollars through the existing wallet-signed tUSDG mint. **tUSDG is test dollars anyone can mint; unlimited repeated mint calls are possible. It has no monetary value and is not income, euros or redeemable cash.** Nothing bridges Solana assets.

## One valuation path

`MirroredPriceFeed` copies [Chainlink RHTSLA/USD on Robinhood mainnet 4663](https://robinhoodchain.blockscout.com/address/0x4A1166a659A55625345e9515b32adECea5547C38), **converted to the test token's multiplier**. This is a Robinhood token price, not a headline Tesla share quote. The testnet mirror is **not a Chainlink contract** and no native Chainlink testnet feed is claimed.

The hosted price job reads the source round and timestamp, checks pauses and multipliers, and uses Jupiter TSLAx as an independent cross-check. It copies a new acceptable round; it does not choose a scenario price. The immutable updater key's sole contract power is to push a price: it cannot withdraw or move pool funds. The contract requires increasing rounds/timestamps, bounded future timestamps, at least 60 seconds between pushes and a per-push movement bound scaled by elapsed time, capped at 20% after one hour; the first push is bounded against the immutable deployment anchor. Nothing on-chain proves the copy matches mainnet: updater honesty and RPC availability remain risks.

Mainnet and testnet multipliers need not match. The updater converts `mainnet_answer × testnetMultiplier / mainnetMultiplier`, rounding down, before pushing. It reads the official test token's `uiMultiplier()` (1e18 if absent), and journals the raw mainnet answer and both multipliers. The `push` parameter named `sourceMultiplier` records the **test-token multiplier used for conversion**; a later test-token multiplier mismatch makes `latestPrice()` return zero, freezing price-sensitive actions until an acceptable new round is copied.

Wallet TSLA, collateral and loan valuation use this same mirror. The interface exposes the source round, source time, copied time, age, source feed and chain, and stale state. It labels Saturday 00:00 UTC through Monday 12:00 UTC as the **weekend freshness window (74 hours)**, not as a claim that trading is closed. Normal freshness is 26 hours. Before the first push there is no price provenance: no mainnet round has been copied yet. Stale, unset or suspended prices are unavailable, never displayed as zero-dollar quotes. Longer holidays or a failed updater freeze price-sensitive actions rather than substituting Jupiter or an operator quote.

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

The former share-backed `CollateralEscrow` app flow is removed. The contract remains a tested prototype, not a hosted tenancy offer. A real rental agreement needs distinct actual parties; the public deposit tab must not imply one account can create them.

`RentalEscrow` and `MorphoAdapter` can use the shared pool as their vault. The separate **local-only `/api/share-earnings`** rehearsal discloses `operator.key` as the test landlord and `arbitrator.key` as the test arbitrator. The tenant obtains gas from Robinhood's official faucet, self-mints **1,501 tUSDG**, and signs acceptance, funding, pool supply and earnings claim. A verified pool manifest is required. Earnings are **borrower-funded interest**, never manufactured yield or operator funding. Principal remains protected by the escrow; release and settlement roll back if the pool lacks cash. Production disables this rehearsal **even when `ALLOW_OPERATOR_TEST_ACTIONS` is set**. It is not an operation on the prepare/submit-only share route; old per-wallet store keys stay untouched and unused.

Incomplete local setup is returned as `starting`, so the setup control can resume the journal instead of hiding the rehearsal. Preparing tenant signatures requires test ETH. A refused broadcast restores its reviewed call only after the node proves it does not know the hash; unknown or known broadcasts remain reserved until a receipt, consumed nonce or aged-null lookup resolves them. Domain errors are shown with their actual message.

Localhost reads the same manifest and chain market as hosted clients. The hosted job maintains the mirror; **localhost needs no updater key and must not run a second updater**.

## Historical evidence is not shared-market proof

[SHARE_WORKFLOWS_ROBINHOOD_TESTNET.json](evidence/SHARE_WORKFLOWS_ROBINHOOD_TESTNET.json) and [BORROW_TO_LOCAL_AI_ROBINHOOD_TESTNET.json](evidence/BORROW_TO_LOCAL_AI_ROBINHOOD_TESTNET.json) record the **historical per-wallet fake-stock/operator-priced implementation**. They do not prove official-stock shared-pool lending, mirror valuation, independent liquidity or borrower-funded earnings. Earlier official-stock collateral cycles likewise used a simulated oracle and operator desk. Preserve their transaction facts without promoting them to evidence of this cutover.

Old per-wallet contracts and store keys (`share-workflows:*`, `share-control:*`, `share-earnings:*`, `ownership-example:*`) remain on-chain/in storage but are unused, not reset or migrated, and no longer surfaced as current positions. Shared-market live evidence must be recorded separately only after an actual rehearsal.
