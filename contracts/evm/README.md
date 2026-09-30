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
