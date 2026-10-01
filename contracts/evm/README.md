# Robinhood rental escrow proof

This is an immutable per-tenancy escrow with a narrow Morpho vault adapter. It implements agreement acceptance, fixed-asset funding, supply-only lending, policy-bounded earnings release, tenant-approved claims, assigned arbitration, and separately executed settlement. The escrow has no operator withdrawal key, upgrade method, arbitrary executor, or authority over a personal portfolio.

All amounts are native atomic integers. USDG uses 6 decimals; the selected Morpho vault uses 18-decimal shares. Claim payments cannot exceed the requested claim or security requirement. A settlement records a minimum total asset value: losses below that floor stop payment until the decision is revisited. Residual earnings return with the tenant's security. Closed escrow donations can only return to the fixed tenant.

## Sponsor-paid rental actions

Both direct native methods and a bounded EIP-712 relay are implemented. The latter allows an unrelated sponsor to pay transaction gas while the tenant, landlord, or assigned arbitrator signs the exact permitted action. EOA signatures enforce low-S and valid V; deployed contract role wallets use ERC-1271. There is no arbitrary target, native value, or call data in a signed action.

Domain: `name=RentalEscrow`, `version=1`, immutable `chainId`, and `verifyingContract=escrow`.

```text
EscrowAction(
  address signer,
  uint8 kind,
  uint256 amount,
  uint256 limit,
  bytes32 evidence,
  uint256 expectedNonce,
  uint256 deadline
)
```

| Kind | Operation | Amount | Limit | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Accept agreement | 0 | 0 | Zero hash |
| 1 | Fund fixed security | 0 | 0 | Zero hash |
| 2 | Supply | Underlying assets | Minimum shares | Zero hash |
| 3 | Release earnings | Underlying assets | Maximum burned shares | Zero hash |
| 4 | Propose claim | Requested assets | 0 | Private evidence digest |
| 5 | Accept claim | 0 | Minimum settlement assets | Zero hash |
| 6 | Contest claim | 0 | 0 | Zero hash |
| 7 | Resolve claim | Landlord award | Minimum settlement assets | Zero hash |
| 8 | Execute settlement | 0 | Minimum assets from redemption | Zero hash |

Every action binds the current global escrow nonce and an expiry. An unsuccessful action reverts its nonce and state. A successful signed action emits both its ordinary financial event and `SignedOperationExecuted`, allowing reconciliation to verify the authorization digest as well as the effect. The sponsor has no independent trading signature.

This is the implemented sponsorship choice; it does not claim working Safe4337, Pimlico, or a configured wallet provider. Initial USDG approval and personal-wallet stock trades/withdrawals require their own supported sponsorship path. A preapproved local test wallet is not proof of gasless consumer onboarding. ERC-1271 support is verified with a local contract-wallet fixture, not an installed Safe.

## Commands

From `contracts/evm`, with Foundry and Solc 0.8.28:

```sh
forge test --offline -vv
forge script script/LocalProof.s.sol:LocalProof --offline --sig 'run()' -vv
```

On a fresh environment, allow Foundry to obtain the pinned compiler before using `--offline`. That flag also avoids an observed Foundry 1.4.4/macOS proxy-detection crash. No containers are needed. The script requires chain 31337 and uses public fixture keys. Without `--broadcast` it executes only in Foundry's local EVM. It returns a test token, mock vault and settled escrow; it is not a Robinhood deployment. To leave an interactive escrow before funding, deploy the contracts from the application deployment tooling rather than presenting this completed script as a new tenancy.

From the repository root:

```sh
node --experimental-strip-types --test src/finance/robinhood/native.test.ts
```

## Share-backed deposit (deployed and verified; hosted flow not yet proven)

`ShareDepositFactory` creates one EIP-1167 clone per landlord/agreement, using CREATE2 with `keccak256(abi.encode(terms))`. Terms are `(tenant, landlord, arbitrator, depositValue, agreementHash, responseWindow, returnWindow, arbitrationWindow)`; parties must be nonzero and distinct, the USD-6 value is 1–10,000 test dollars, the agreement commitment is nonzero, and each window must be 1 hour–400 days inclusive. Windows cannot change after initialization and must be part of accepted agreement terms. Only the declared landlord can call `create`. `predict(terms)` and `escrowFor(landlord, agreementHash)` support recovery; the mapping is namespaced by `keccak256(abi.encode(landlord, agreementHash))`, preventing another landlord from occupying the app's intended slot. Duplicate creation in that namespace reverts even if another term changes. The application must read back every accepted term; the factory cannot verify the app's off-chain agreement acceptance. Initialization is factory-only and atomic with creation; the implementation is self-locked. There is no administrator, upgrade or signed-action relay. Parties send their own transactions, using the site's existing test-gas drip where sufficient.

Chain 46630 pins official test TSLA `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` and mirror `0x5196C8713A529bd676B875fB9Cea3F8a47ba48Be`; local chain 31337 permits mocks. The contract states are AwaitingLock, Active, ClaimPending, ClaimContested and Closed (0–4). Partial funding remains AwaitingLock; pledge checks the exact custody balance increase and auto-activates at 150% with a fresh price. Tenant withdrawals before activation need no quote; after activation they must leave 150% cover. No withdrawals are allowed during claims. Top-ups remain possible during claims and stale quotes, but not after closing. Below 125% the application requests a top-up: there is no on-chain grace timer, forced sale or DEX.

The landlord proposes a USD-6 deduction up to the security cap, committing private evidence. A positive claim converts once at proposal, `min(balance, ceil(usd6 * 1e18 / price6))`; the event and `claim()` expose the conversion price and source time. The tenant accepts a maximum share bound (`current claim.shares <= maxShares`) or contests. The fixed arbitrator, once authorized by contest/escalation, resolves in either claim state; the award clamps to the current lowered share request. Concurrent reductions therefore cannot invalidate a tenant acceptance bound or revoke arbitration authority. A zero claim closes immediately without a price. Accept, contest, resolve and payouts are price-free. `quote()` catches feed errors and exposes price/source time/freshness; `coverBps()` returns zero for an unusable quote, so callers must distinguish it with `quote().fresh`. Freshness follows the pool's 26-hour normal / 74-hour weekend window (Saturday through Monday before 12:00 UTC), rejecting zero and future source times and multiplier mismatch.

**Bounded, tenant-favouring liveness:** the tenant can `requestReturn()` while Active; if the landlord has not proposed before `returnDeadline`, anyone can `closeUnclaimed()` with a full return, without a price. A positive proposal starts `responseDeadline`; tenant silence after that permits anyone to `escalateClaim()` to ClaimContested, never to auto-accept. First contest/escalation permanently latches arbitration authority for that claim and fixes `arbitrationStartedAt`. The landlord can `lowerClaim(usd6)` in either claim state, never raise it; a nonzero reduction converts using the stored proposal price, rounds down in the tenant's favour, and returns to ClaimPending without restarting any window or revoking arbitration. Zero withdraws the claim and closes with full return. Existing share caps cannot increase. **If the arbitrator decides nothing within the agreed arbitration window (N days), anyone can return the deposit to the tenant** using `closeUnresolved()`: award zero, no price and no further role consent. At the deadline, late acceptance/arbitration can no longer race the agreed timeout. Every non-Closed state has a custody exit; issuer pause/block/burn can still prevent or reduce actual transfers. There is never an automatic landlord award or consent by silence.

`pledgeWithPermit` tolerates a previously submitted permit only if, after a failed permit call, the remaining allowance equals the exact requested shares. A larger, unlimited or partially consumed allowance cannot authorize a permissionless fallback pledge.

Closing records the landlord's raw share award. Permissionless `payout(true)` sends `min(landlordOwed, actual balance)` to the fixed landlord; `payout(false)` sends the actual balance minus that reserved award to the fixed tenant. The tenant can collect the remainder even when the landlord is blocked, and vice versa. Unsolicited transfers become part of the actual escrow balance, not a separately tenant-owned donation ledger: they can refill an unpaid landlord award after a burn. Landlord priority means a burn first consumes the tenant remainder, then reduces landlord payment when actual custody falls below its award. `custodyShortfall()` compares actual custody to the outstanding tracked expectation; excess withdrawals consume untracked balance first. A paid capped award consumes its unpaid entitlement; later inflows do not revive it. Closed means the award is decided, not that both payouts have confirmed. The application must inspect custody, unpaid award and receipts.

**Issuer risk:** test tokens have no monetary value. Robinhood can pause or block transfers, burn held tokens, change multipliers or upgrade TSLA. This contract cannot reverse those actions; a blocked recipient's payout stays retryable. The mirror is an updater's bounded copy, not on-chain proof of Chainlink data. Application safety checks must expose issuer and mirror health without hiding exits.

### Deployment and manifest format

`deployments/share-deposit-46630.json` is version 1 with `status: deployed`. The factory is [`0x525b9bA7d083d2a63417239B7e384C5e0E570aCe`](https://explorer.testnet.chain.robinhood.com/address/0x525b9bA7d083d2a63417239B7e384C5e0E570aCe), and the self-locked implementation is [`0x84f3bDEcF0Ca0F561fe865A7Ae412CdE8DC81427`](https://explorer.testnet.chain.robinhood.com/address/0x84f3bDEcF0Ca0F561fe865A7Ae412CdE8DC81427). Both are source-verified on Blockscout. Deployment [transaction `0x90a2211b75b89bce07de5744a5bfc96779e6090b3a2cf116d6f2c9f0d9aeb027`](https://explorer.testnet.chain.robinhood.com/tx/0x90a2211b75b89bce07de5744a5bfc96779e6090b3a2cf116d6f2c9f0d9aeb027) succeeded at block 127079150, using 3,306,759 gas. The deployer `0x4efe17E8D8C475971d639ED1CaeEd84F57Fe68dD` has no post-deployment authority.

The manifest pins exact deployed code hashes (`factory: 0xea1e2bbfbfdda9f1b152630c7d4a2db67972a84cb0988656fb1ab5dbd1f05ab6`, `implementation: 0x42ea9945d624db747982db0f51d46167b178cb8de6f40c8bfa91009eb466c48e`), stock/feed and reviewed creation/runtime-template hashes. Public-RPC readbacks confirmed factory `implementation`, implementation `factory/stock/oracle/fixedChainId`, and implementation state Closed (4). Deployed runtime normalizes exactly to each reviewed template after zeroing compiler-recorded immutable slots. Named `immutableAnchors` identify one byte offset per immutable group, avoiding dependence on compiler AST IDs; the checker fills every slot with the manifest's expected address/chain value and hashes that exact configured runtime.

Dependency pins are copied from `shared-market-46630.json`: stock proxy/feed runtime hashes, EIP-1967 beacon, current issuer implementation, access registry and their code hashes. Identity pins are 18 decimals, multiplier 1e18, permit domain Tesla/1/46630 and unpaused transfers. Before `startBroadcast`, the deploy script verifies both manifests agree, every dependency code hash/address, beacon storage, decimals, multiplier, pause/block status and live permit domain/separator; failure stops deployment. `node contracts/evm/script/check-runtime.mjs` validates artifact/dependency pins, manifest shape and exact configured deployed code hashes offline, preserving the existing cash runtime checks. Add `--live` for read-only public-RPC verification of receipt, exact live code and locked implementation readbacks. `CollateralEscrow.sol`, `RentalEscrow.sol`, feed and pool remain unchanged.

Dry-run only, from the repository root:

```sh
forge script --root contracts/evm contracts/evm/script/ShareDeposit.s.sol:DeployShareDeposit \
  --rpc-url https://rpc.testnet.chain.robinhood.com -vv
SHARE_DEPOSIT_FORK_PROOF=true forge test --root contracts/evm --match-path test/ShareDepositFork.t.sol -vv
```

The fork uses real TSLA/feed with locally fixture-written balances and a source-time warp if needed. It sends no network transaction and is not hosted acceptance evidence. A script dry-run also does not deploy; any future broadcast still requires separate explicit authorization. Do not substitute runtime-template hashes for deployed code hashes: immutables differ. Verify each tenancy clone's exact 45-byte EIP-1167 runtime contains the reviewed implementation, the factory's prediction/mapping, and every accepted term. Deployment/source verification does not prove the hosted three-account agreement/funding/claim/payout flow; catalogue availability stays unchanged until that evidence exists.

## Shared testnet TSLA lending market

`MirroredPriceFeed` and `SharedLendingPool` are testnet-only, immutable contracts (chain 46630 or local 31337). The pool constructor is `(usd, stock, oracle)`; its fixed rules are 5% borrow APR (continuous accrual, approximately 5.13% effective annual rate), 50% maximum borrow LTV, 80% liquidation LTV, 10% liquidation bonus, a 50% liquidation close factor, and 90% maximum utilization. Minimum borrowing is 1 tUSDG. Interest accrues to lenders, including RentalEscrow vault positions; bad debt lowers their share value. Cash availability limits withdrawals. Direct token donations do not create accounted liquidity.

The feed constructor is `(updater, stock, sourceFeed, sourceChainId, initialAnswer)`. Its separate updater can only push increasing source rounds/times and bounded prices; it cannot withdraw funds. The immutable initial answer bounds the first push to ±20%, even if it arrives hours after deployment. Thereafter the feed accepts at most one push per hour, each within 20% of the previous copied price; a longer gap still allows at most 20% at once. The mirror may lag the source by up to an hour. This is the mainnet Chainlink RHTSLA/USD token price **converted to the test token's multiplier**, not a Chainlink contract, and the chain does not prove that the updater copied honestly. The updater rounds down when dividing out the mainnet multiplier and applying the testnet multiplier; the push's multiplier identifies the test-token basis. A later test-token multiplier mismatch freezes price-dependent operations. The pool rejects prices older than 26 hours, except for a 74-hour window from Saturday 00:00 UTC through Monday 12:00 UTC. Repayment, lending, cash withdrawal and debt-free collateral withdrawal remain available with a stale price.

The price job records the raw mainnet answer and both mainnet/testnet multipliers in its journal and result. The feed's `latestPrice()` returns zero when the current test-token multiplier no longer matches the basis last pushed.

Neither contract has an owner, configurable parameters, pause or upgrade path. The deployer has no privileged power after setup. Replacing the immutable updater requires a new feed and pool. Robinhood's external stock issuer still has pause, blocklist, burn and upgrade powers. tUSDG is test money anyone can mint, not valuable dollars; all earnings are actual borrower interest in that test asset, not an operator yield credit.

### Deployment (explicitly reviewed, never automatic)

From the repository root, build and run the contract suite before deployment:

```sh
forge build --root contracts/evm
forge test --root contracts/evm
node contracts/evm/script/shared-market.mjs setup --updater 0xPUBLIC_UPDATER_ADDRESS
# Only an authorized deployment operator runs the next command:
node contracts/evm/script/shared-market.mjs setup --updater 0xPUBLIC_UPDATER_ADDRESS --send
```

Replace the address placeholder with the separate updater's public address. The script never reads an updater secret. Set `ROBINHOOD_TEST_KEYS_DIR` to override `.testnet-secrets/robinhood-testnet`; `shared-market-deployer.key` must be a regular file owned by the current user with owner-only permissions (`chmod 600`). Do not use the updater key as the deployer. For a read-only rehearsal, use a newly generated throwaway key under `~/.cache`, select that directory, and omit `--send`. Dry run asserts the live chain/official assets, reads the mainnet source to derive the converted initial answer, and encodes all five transactions; it neither signs nor broadcasts, writes a journal, or publishes a manifest. It is not a simulated successful deployment.

`SHARED_MARKET_ARTIFACTS_DIR` optionally selects an alternate Foundry-format output directory for scoped rehearsals, but cannot bypass reviewed artifact pins. The final read-only rehearsal on September 30, 2026 accepted the final Solc 0.8.28 Forge artifacts, passed live official-asset and issuer-pin assertions, and encoded feed deployment, pool deployment, mint, exact approval and burned-seed deposit with zero writes. Mainnet multiplier reads are pinned to official TSLA `0x322F0929c4625eD5bAd873c95208D54E1c003b2d`, with exact identity `Tesla • Robinhood Token` / `TSLA` / 18 decimals and both `paused()` and `oraclePaused()` false. Source round `18446744073709553011` gave raw answer `35046300000`; both mainnet and test multipliers were `1000000000000000000`, so the converted initial answer was `35046300000`. The earlier rehearsal used the wrong SPY multiplier and is superseded; journals naming that wrong stock are rejected instead of resumed. Independent creation-bytecode, runtime-template and immutable-range tampering each failed closed. An explicit mode-0644 throwaway deployer key was rejected before reading it. All throwaway keys/artifacts were removed; `--send` was not exercised and no transaction was broadcast. Post-deployment wiring/state/seed assertions therefore remain unexercised on a live deployment.

With `--send`, setup persists the source round, raw answer, both multipliers and converted `initialAnswer` **before** any signing, so resume retains the original constructor anchor. It journals signed raw transactions **before** broadcasting, pins each nonce/hash/CREATE address and calldata hash, and waits for **three confirmations** at every step. Resume reuses the identical signed transaction; an unexpectedly consumed nonce is an error, not permission to deploy again. Protect `shared-market-progress.json` like the key: it contains signed transactions. Setup asserts the pinned tUSDG and official TSLA runtime hashes, Tesla/TSLA metadata, 6/18 decimals, unpaused stock, unblocked deployer/pool, and multiplier 1e18. It discovers and pins the stock beacon, implementation and access registry addresses and runtime hashes; subsequent issuer upgrades fail closed.

Only the reviewed Solc 0.8.28 creation bytecode, runtime templates and exact immutable-reference ranges are accepted, including when an alternate artifact directory is selected. After deployment, setup checks normalized on-chain runtime templates plus every constructor wiring getter, the feed's immutable initial answer/movement band, all public fixed parameters and effective annual rate. Setup deploys feed then pool, mints 10,000 tUSDG to the deployer, approves exactly that amount, and deposits it for `0x000000000000000000000000000000000000dEaD`. Before publication it requires exactly 10,000 accounted and actual tUSDG cash/assets, the exact burned seed share count, zero deployer shares, zero debt and no remaining seed allowance. Those shares cannot be withdrawn; their interest stays locked. The pool itself never mints assets. Atomic publication of `contracts/evm/deployments/shared-market-46630.json` records verified addresses, runtime hashes, fixed parameters, feed/bootstrap price data, reviewed artifact pins, deployment block/transaction hashes, seed assets/shares/receiver/transaction hashes, updater, source chain 4663/feed `0x4A1166a659A55625345e9515b32adECea5547C38`, and `collateralIssuer` with beacon/implementation/registry addresses and hashes. Existing manifests are checked, not overwritten.

Verify both deployed contracts with `forge verify-contract --chain 46630 --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api`, supplying their addresses, source paths and ABI-encoded constructor arguments. Publish the reviewed manifest to the application image, configure the separate `ROBINHOOD_PRICE_UPDATER_PRIVATE_KEY` in deployment secrets, and enable the price reconciliation scope. The first accepted mirror push makes borrowing available. Localhost reads the same market and needs no updater key; never run a competing updater. No deployment, explorer verification or live seed is implied by a dry run.

### Shared-market verification (September 30, 2026)

`forge build --quiet` succeeded; `forge test --gas-report` passed 67 tests with zero failures and one opt-in mainnet fork skip (68 total). The 32 new market tests (10 feed, 22 pool) include 256 runs of a 32-operation sequence fuzz and RentalEscrow using the actual pool. The final deployment dry run used the resulting Forge artifacts, rechecked the live assets, and reported five planned stages and `writes: 0`; its throwaway cache key was removed.

Foundry measured deployment costs of **508,645 gas for the feed** and **2,206,340 gas for the pool** (2,714,985 combined, excluding seed operations). Feed `push` gas-report measurements across 215 calls were 34,041 median and 138,189 maximum; that aggregate includes deliberate rejection cases. These are local EVM measurements, not broadcast transaction receipts or a Robinhood fee quote.

Debt-share rounding favours the pool: a repayment pays the ceiling claim while removing the floor debt claim, preserving other borrowers' debt even at one-atomic-dollar boundaries. At most one atomic dollar per conversion remains with lenders. Bad-debt realization removes the floor claim. When liquidation reaches the collateral-value repayment cap, it seizes all remaining collateral (including rounding dust) and writes off remaining debt, rather than leaving an economically exhausted loan stranded.

## Verified evidence on September 22, 2026

**25 local contract tests passed**, including 256 fuzz runs for conservation. Coverage includes the 3,000 → 10 earnings → 120 claim → 2,880 security refund scenario; separated personal funds; incorrect roles; claim caps; partial losses; stale nonces; expiry and chain mismatch; share slippage; failed withdrawals; callback reentrancy; EIP-712 tampering; cross-contract replay; malformed/high-S signatures; and ERC-1271 authorization. **14 TypeScript tests and strict typechecking passed** for native plans, typed relay encoding, canonical receipt reconciliation, exact amounts, accumulating exposure, and gated quote validation.

**Two tests also passed against a pinned Robinhood mainnet fork at block 69,829,067.** They executed the actual USDG token and selected Steakhouse USDG vault locally through the new escrow. Source addresses:

- USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- Morpho vault: `0xBeEff033F34C046626B8D0A041844C5d1A5409dd`.
- SPY metadata/multiplier read: `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C`. No stock trade was executed.

| Fork observation | Result |
| --- | ---: |
| Declared local security fixture | 3,000 USDG |
| Cash retained for preview rounding | Determined from same-block deposit/redeem previews |
| Vault shares minted | Reported by the fork test |
| Eligible earnings after **90 days of synthetic time progression** | Reported by the fork test |
| Earnings released | 10 USDG |
| Landlord settlement | 120 USDG |
| Tenant settlement | Includes residual earnings and any retained cash |
| Remaining escrow shares | 0 |

The fork supplies only the exact funded security requirement. It computes a
preview-backed amount that leaves enough USDG idle to preserve the contract's
minimum accounting value; a separate test call confirms that supplying all
available USDG reverts when preview rounding would make security insufficient.
These are local fork results, not realized mainnet returns or a forecast. The
fixture changes the tenant's local token balance and local time; no transaction
is broadcast to Robinhood. Morpho V2's transient per-transaction accrual cache
requires deposit setup and later accrual to execute as separate transactions.
Advancing time within the same Foundry transaction does not reset that cache.

Replay, using an archive-capable RPC if the public endpoint has pruned the block:

```sh
ROBINHOOD_FORK_PROOF=true ROBINHOOD_FORK_BLOCK=69829067 \
  forge test --offline --match-contract RobinhoodForkTest -vv
```

The original research block 69,695,660 was unavailable from the public RPC's historical state during implementation. Default unit runs explicitly skip network fork tests; do not count a skip as an integration pass. Changing the source block requires recording its new evidence. The fork source RPC can be configured with `ROBINHOOD_FORK_RPC`; its default is the official public endpoint.

## Integration boundaries

- Morpho V2 `max*` views return zero. `securityValue` and `releasableEarnings` are accounting bounds, not guaranteed available liquidity. Simulate the exact operation from the correct caller, then reconcile actual asset/share changes. In-kind exits and arbitrary allocator operations are outside this adapter.
- Deployments and dependencies must be reviewed and pinned by the application. A contract address from browser input is not an authorized tenancy. The adapter's read verifies asset/network/vault identity; deployment provenance remains the application's responsibility.
- Signed action fields must be shown to the user before signing. The durable server stores the plan, digest, signature and submitted hash. A timeout remains unresolved until chain observation; it is not permission to resubmit as a new operation.
- The TypeScript stock helper is fail-closed without approved 0x RWA access, a current eligible profile, an enabled instrument, and reviewed route/allowance targets. Quotes still require fresh simulation and a tenant signature. It never signs, submits, fabricates fills, or grants unlimited allowance.
- Robinhood Stock Tokens accumulate exposure using a multiplier. Chainlink prices already include that multiplier; REST underlying-equity prices do not. No second cash dividend is credited.
- No production wallet/provider account, stock purchase, fiat transfer, or production deployment was created here. Provider access, wallet recovery, complete fee sponsorship, actual stock execution/exit and production review remain integration gates.

Primary references: [Robinhood network](https://docs.robinhood.com/chain/connecting/), [stock integration](https://docs.robinhood.com/chain/building-with-stock-tokens/), [Morpho integration](https://docs.morpho.org/developers/earn/tutorials/assets-flow/), [Morpho V2 source](https://github.com/morpho-org/vault-v2), and [0x RWA access](https://help.0x.org/articles/5420296643-xstocks-support-on-0x).

## Building GPU revenue streaming (testnet; not deployed)

`BuildingRevenueDistributor` is a trustless staking-rewards stream. It receives ERC20 tUSDG directly, including a potential future x402 host payee transfer. **Income streams to stakers over 7 days**, not as an immediate payout to whoever stakes around a revenue transfer. Constructor arguments `(payoutToken, unitToken, rewardDuration)` are immutable; duration is bounded to 1 hour–30 days and pinned to 7 days for this deployment. Chains 46630 and local 31337 are allowed. No operator, owner, admin, roots, epochs, upgrades or rescue exists.

`stake(amount)` transfers the caller's approved raw tHOME into custody; `unstake(amount)` returns only that caller's units. `claim()` pays only the caller's accrued atomic tUSDG (6 decimals). `exit()` unstakes all and claims atomically. All mutations, including permissionless `sync()`, enforce a reentrancy guard and synchronize incoming revenue first. Account checkpoints precede stake-weight changes; effects precede transfers, and exact sender/recipient balance deltas reject fee-on-transfer tokens. Transfer failures revert the full action, so a failed exit keeps units and rewards intact.

**Do not transfer tHOME directly to the distributor.** Only `stake()` credits the caller's stake ledger. Direct unit transfers earn no rewards and cannot be recovered or unstaked because no rescue authority exists. Plain transfers are intended for **tUSDG revenue only**.

**Timing is part of the model:** only elapsed stream time earns rewards at the actual stake weights during that time, not historical unit ownership. A large stake immediately before a receipt and an immediate exit earns zero at the same timestamp; after one second it earns only its share of that second. New incoming receipts plus the unstreamed remainder start a fresh seven-day window; already-earned rewards are never rescheduled. Revenue emitted while nobody stakes is retained, and when the first staker arrives that carry plus the unstreamed budget starts a fresh full-window stream, **never an instant lump-sum payout**. Repeated zero-incoming syncs cannot extend the window. These time-weighted fictional test rewards do not create ownership or legal rights.

**Streaming liveness limitation:** any positive tUSDG receipt restarts the outstanding unstreamed budget over a new window. Because test tUSDG is freely mintable, repeated dust receipts can keep extending the remaining tail at negligible cost. Already-accrued rewards remain claimable and unit principal remains withdrawable, but **seven days is not a guaranteed completion deadline when new receipts keep arriving**. This is a known tradeoff of the permissionless reschedule-on-receipt model, not a claim of production-grade economic fairness.

### Accounting and precision

With high internal precision `S = 1e36`, `rewardRate` is **scaled atomic tUSDG per second**; divide by `S` and by `1e6` to express test dollars/second. `accounted` tracks all synced payouts still held and decreases only on successful whole-token claims. Each mutation accrues the current stream first, then computes new `incoming = payoutToken.balanceOf(distributor) - accounted`. Newly received revenue, idle carry and the still-unstreamed budget are scheduled over `rewardDuration`, with `rewardRate = floor(budgetScaled / rewardDuration)`.

Elapsed emission is `rewardRate * elapsedSeconds` up to `periodFinish`; the final accrual includes the exact remaining budget, so sub-atomic rate-division dust is not lost. With stakers, emission plus `rewardRemainderScaled` increments `rewardPerUnit` by floor division over raw `totalStaked`; its modulo remainder stays tracked. Without stakers, emissions enter `undistributedScaled` (idle carry). `streamRemainingScaled` is the exact unstreamed budget. Synced payout custody equals whole owed rewards, uncheckpointed accrual, per-account fractions, future/idle budgets and global remainders combined.

Per-account checkpoints accrue `stakedOf(account)*(rewardPerUnit-rewardPerUnitPaid(account)) + rewardFraction(account)`; whole atomic units enter `rewards`, and the sub-atomic fraction remains tracked across ordinary claims/partial unstaking. Full unstake/exit retains whole rewards for a later claim but clears and recycles its fractional remainder into the stream, emitting `FractionRecycled`. Recycling keeps an active period's existing finish; if the stream ended with stakers remaining, the fraction streams over a fresh window. With no remaining stakers, fractions and global accumulator dust join idle carry. No per-account fraction is permanently orphaned by a full exit.

Views expose `rewardDuration`, `rewardScale`, `rewardRate`, `periodFinish`, `lastUpdateTime`, `totalStaked`, `stakedOf(account)`, `rewardPerUnit`, account checkpoints/rewards/fractions, `accounted`, `streamRemainingScaled`, `undistributedScaled`, `rewardRemainderScaled`, `pendingRevenue()` and `earned(account)`. Earned rewards grow with elapsed scheduled time; unsynced new receipts do not instantly become earned. `Staked`, `Unstaked`, `Claimed`, `RevenueSynced`, `StreamScheduled` and `FractionRecycled` expose mutations; direct tUSDG receipts use token `Transfer` logs. The pinned dependencies must remain ordinary non-rebasing test ERC20 assets; unexpected payout custody loss fails closed rather than silently reallocating rewards.

### Reviewed build and dry-run

`deployments/building-revenue-46630.json` is **version 3**, `rewardsSpec.scheme = staking_stream_v1`, **status `not_deployed`**, with null distributor/runtime/deployment evidence. It pins test tUSDG/tHOME, their code hashes, `rewardDuration = 604800`, scale `1e36`, and reviewed creation/runtime-template hashes with complete token/duration immutable anchors. `script/check-runtime.mjs` rejects obsolete operator/instant-reward manifests and validates build/dependency/runtime bindings offline. Explicit `--live` additionally checks a deployed distributor's receipt, exact configured runtime, token/duration/scale readbacks, or reports deployment unavailable.

```sh
forge build --root contracts/evm
forge test --root contracts/evm -vv
node contracts/evm/script/check-runtime.mjs
forge script --root contracts/evm \
  contracts/evm/script/BuildingRevenueDistributor.s.sol:DeployBuildingRevenueDistributor \
  --rpc-url https://rpc.testnet.chain.robinhood.com -vv
```

The deployment script checks token addresses, chain/version/stream scheme, seven-day duration, scale, live dependency code hashes and reviewed creation hash before starting a broadcast context. The command above **does not broadcast**: the public-RPC dry-run succeeded on chain 46630 with an estimated 1,540,455 gas and only simulated deployment.

A separate throwaway local-EVM smoke received 10,400 atomic tUSDG while nobody staked, waited through the idle window, then staked 1 tHOME. The immediate claim paid **0**, the half-window claim paid **5,199**, and at the end total payout was exactly **10,400** with zero held payout and all 1 tHOME principal returned. Foundry time-warp tests cover one-second front-run participation, zero-staker streaming, staggered stakers, repeated receipts extending only future revenue, unchanged finish on zero-incoming sync, exact rate/dust accounting, recycled exit fractions, transfer rollback, reentrancy, duration/chain guards and 256-run exact-conservation sequences. Default network-fork skips are not integration evidence.

No deployment, chain transaction or host payout reroute was performed. A simulated address is not usable deployment evidence. All units and payouts are fictional testnet data with no monetary value or legal rights; this is not legal advice.
