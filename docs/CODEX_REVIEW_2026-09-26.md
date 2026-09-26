# Codex review 2026-09-26 (openai-codex/gpt-6-astra)

Independent read-only review of `06e9f0f..b769078` (23 commits). Report verbatim below the triage.

## Triage

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | SSRF via Home Assistant URL | Partly fixed: redirects refused, link-local/metadata addresses blocked, private addresses blocked on Vercel. DNS rebinding between check and fetch remains; hosted use needs a connector or allowlist. |
| 2 | High | One failing recipient stalls Solana payouts | Open |
| 3 | High | CollateralEscrow forgives claims on slippage | Open (prototype contract, not used in the app flow) |
| 4 | High | `/api/identity` overwritten, breaking recovery | Fixed: original recovery route restored; EU wallet moved to `/api/eudi` |
| 5 | Medium | Local-only test actions trust request hostname | Open |
| 6 | Medium | Clients receive unrestricted fee-payer signatures (portfolio buy) | Open |
| 7 | Medium | Concurrent applicant selection creates two agreements | Open |
| 8 | Medium | Purchase timeouts lose transaction state | Open |
| 9 | Medium | Late EUDI poll reverses "Forget" | Fixed: result stored only if the same request is still pending (atomic update) |
| 10 | Medium | Portfolio counts tenants' deposits for landlords | Fixed: viewer entitlement per role; unpaid payouts kept after close |
| 11 | Medium | Lifetime solar counter shown as today | Fixed: only per-day sensors auto-detected; tariff values marked as estimates; currency from sensor |
| 12 | Low | Simulated returns lose provenance | Fixed for visible figures: distributions, Robinhood earn message and devnet earnings labeled simulated |

## Report

Reviewed `06e9f0f..b769078`—the requested 23 commits. Concurrent commit `d17a61f` is outside scope **[unverified]**. No files changed or network writes performed.

**Findings**

1. **High — Authenticated SSRF through Home Assistant.** [adapters.ts:39](/Users/max/Code/rental-deposit-hackathon/src/server/adapters.ts:39), [adapters.ts:73](/Users/max/Code/rental-deposit-hackathon/src/server/adapters.ts:73). Any signed-in user can configure loopback/private addresses for server-side fetching; redirects also allow escaping `/api/states`. Acceptance and attempted loopback fetch reproduced with mocks. **Fix:** require operator-authorized destinations or a local connector; validate resolved addresses and disable or revalidate redirects.

2. **High — One broken recipient stalls both Solana payouts.** [solana-service.ts:858](/Users/max/Code/rental-deposit-hackathon/src/server/solana-service.ts:858). A tenant payout that fails simulation is selected repeatedly because the failure is never recorded. A broadcast failure also becomes permanently cached under the unchanged nonce. Both failures reproduced; the landlord remains unpaid through the app despite independent on-chain withdrawals. **Fix:** track attempts per recipient, try the other recipient after definitive failure, and permit replacement attempts after confirmed failure/expiry.

3. **High — Collateral settlement forgives claims while collateral remains.** [CollateralEscrow.sol:230](/Users/max/Code/rental-deposit-hackathon/contracts/evm/src/CollateralEscrow.sol:230), [CollateralEscrow.sol:256](/Users/max/Code/rental-deposit-hackathon/contracts/evm/src/CollateralEscrow.sol:256). With a $400 oracle price, $392 execution price and $120 approved claim, settlement sells 0.3 shares, pays $117.60, then returns remaining stock to the tenant. Allowed slippage is mistaken for exhausted collateral. **Fix:** target actual cash proceeds, selling additional stock until the claim is covered or holdings are exhausted. EVM execution **[unverified]**.

4. **High — EUDI replaces the endpoint required for account recovery.** [identity/route.ts:12](/Users/max/Code/rental-deposit-hackathon/app/api/identity/route.ts:12), [use-recovery.ts:15](/Users/max/Code/rental-deposit-hackathon/src/components/use-recovery.ts:15). `/api/identity` now returns `{identity: …}`, but recovery immediately dereferences `profile.subject`. Normal onboarding cannot obtain recovery status or expose the baseline-enrollment step. **Fix:** separate EUDI and recovery endpoints and update their callers. Browser execution **[unverified]**.

5. **Medium — “Local-only” test actions lack a reliable locality boundary.** [test-helpers.ts:44](/Users/max/Code/rental-deposit-hackathon/src/server/test-helpers.ts:44), [assets/route.ts:38](/Users/max/Code/rental-deposit-hackathon/app/api/assets/route.ts:38), [portfolio.ts:71](/Users/max/Code/rental-deposit-hackathon/src/server/portfolio.ts:71). With test mode enabled, a reverse-proxied localhost server can expose fixture signing and repeated operator-funded Robinhood deployments. Request URL hostname does not identify the caller; portfolio also omits the signer’s database restriction. **Fix:** enforce one operator-only test capability across these endpoints, with deployment restrictions and bounded, idempotent jobs. Remote deployment behavior **[unverified]**.

6. **Medium — Clients receive unrestricted fee-payer signatures.** [portfolio.ts:148](/Users/max/Code/rental-deposit-hackathon/src/server/portfolio.ts:148). `prepareBuy` returns maker-signed transactions without simulation or an aggregate sponsorship budget. An authenticated user with insufficient USDC can request distinct quotes, countersign, and submit directly while skipping preflight, spending maker fees on failures. The submission API cannot enforce limits afterward. **Fix:** retain the maker signature server-side until validation and budget reservation. On-chain abuse **[unverified]**.

7. **Medium — Concurrent applicant selection creates two agreements.** [listings.ts:209](/Users/max/Code/rental-deposit-hackathon/src/server/listings.ts:209). Agreement creation precedes the listing’s conditional update. Two concurrent selections produce two agreements although one request fails; the orphan remains discoverable through `myTenancies`. Reproduced. **Fix:** atomically commit selection and agreement creation, with idempotency for retries.

8. **Medium — Purchase timeouts lose transaction state and invite duplicate spending.** [portfolio.ts:184](/Users/max/Code/rental-deposit-hackathon/src/server/portfolio.ts:184), [home.tsx:611](/Users/max/Code/rental-deposit-hackathon/src/components/home.tsx:611). Broadcast signatures/status are never persisted. If submission succeeds but confirmation times out, another click creates a fresh purchase while the first may still complete. **Fix:** persist signed bytes and signature before broadcast; reconcile the existing purchase independently of quote expiry. RPC timeout scenario **[unverified]**.

9. **Medium — An outstanding EUDI poll reverses “Forget.”** [eudi.ts:94, reviewed commit](https://github.com/GiraeffleAeffle/rental-deposit-hackathon/blob/b7690784a445699f01e09d54da9fbb805c57c1c2/src/server/eudi.ts#L94). Polling reads pending state before fetching, then saves unconditionally. A delayed response restores verification after deletion; reproduced with a mocked verifier. **Fix:** atomically require the same still-valid request generation, transaction ID and nonce before storing; forgetting must invalidate that generation.

10. **Medium — Portfolio totals attribute tenants’ deposits to landlords.** [assets.tsx:74, reviewed commit](https://github.com/GiraeffleAeffle/rental-deposit-hackathon/blob/b7690784a445699f01e09d54da9fbb805c57c1c2/src/components/assets.tsx#L74). Every active tenancy’s full escrow value enters the viewer’s portfolio, regardless of role. Conversely, closing removes unpaid payout entitlements. **Fix:** calculate the viewer’s beneficial entitlement and retain unpaid receivables until payout.

11. **Medium — Lifetime solar production appears as today’s earnings.** [adapters.ts:82](/Users/max/Code/rental-deposit-hackathon/src/server/adapters.ts:82). The fallback accepts any solar energy sensor as daily production. A lifetime counter of 12,000 kWh produced “12,000 kWh today” and €3,600 today in reproduction. Monetary units are also assumed to be EUR. **Fix:** require an explicit measurement period/unit, calculate daily deltas where appropriate, and identify tariff-derived values as estimates.

12. **Low — Simulated returns lose their provenance in the portfolio.** [assets.tsx:106, reviewed commit](https://github.com/GiraeffleAeffle/rental-deposit-hackathon/blob/b7690784a445699f01e09d54da9fbb805c57c1c2/src/components/assets.tsx#L106), [robinhood-demo.ts:148](/Users/max/Code/rental-deposit-hackathon/src/server/robinhood-demo.ts:148). Operator-set multipliers appear as “distributions,” and minted test yield becomes “earned.” A general testnet badge does not distinguish the ontology’s `testnet_real` from `testnet_simulated`. **Fix:** return provenance with each figure and label simulated yield/distributions beside the amount.

**What is solid**

The Solana program’s fixed recipients, nonce checks and separate payout liabilities provide a sound custody foundation. The core operation service verifies exact signed messages, persists signed transactions before broadcast, and reconciles finalized effects. Agreement authorization binds identity and wallet rather than trusting UI role selection.

All 53 selected tests passed. Additional memory-only fixtures reproduced findings 2, 7, 9 and 11. Full Rust/Forge suites, deployed bytecode, live wallet flows, and the hosted verifier’s validation configuration and retention remain **[unverified]**.

**Product/UX opinion**

The deposit → earnings → investment journey is the clearest demonstration of household ownership. Recovery and payout failures currently interrupt that story. The portfolio should distinguish owned balances, escrow entitlements and observed device output, while keeping simulation labels visible. Broader household and city concepts will be more convincing once this primary journey works consistently.