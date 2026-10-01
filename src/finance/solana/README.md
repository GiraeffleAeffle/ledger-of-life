# Solana finance boundary

`index.ts` exports the adapter. All financial values and nonces crossing the boundary are canonical decimal atomic-unit strings. Addresses retain case. The network is `solana`; cluster and genesis identity remain mandatory separate fields.

| Export | Application responsibility |
| --- | --- |
| `resolveSolanaManifest` | Supply an explicitly reviewed test deployment after checking RPC genesis and deployed program bytes/authority. No implicit deployment and no mainnet writes. |
| `readTenancy` / `decodeTenancy` | Use trusted RPC evidence. `readTenancy` checks genesis, owner, fixed asset/protocol fields, discriminator, exact versioned layout (483-byte legacy vs. 499-byte pull), and PDA. |
| `validateMintObservation` | Pass an explicit issuer-extension and authority allowlist. Missing issuer review fails closed. |
| `decodeKaminoReserve` / `validateKaminoAccounts` | Pass a coherent, fresh account observation. Vault and receipt mint come from validated reserve state; only the market authority universally follows the current PDA derivation. Refresh again on chain before a value-sensitive action. |
| `buildInitializeEscrow` | Tenant and landlord agree/sign jointly, or landlord initializes staged setup after off-chain acceptance. A separate sponsor pays rent; payout destinations are canonical classic-Token ATAs. |
| `buildEscrowInstruction` | Persist an operation intent, expected nonce and exact compiled message before user authorization. Action kinds match the Anchor instruction names. |
| `quoteInvestment` | Read/build only. Price-only requests allow the documented keyless tier (caller rate limit: 0.5 RPS). Builds require a configured key, mainnet reference genesis and taker/separate payer. Test issuer routes return unavailable. No secret or signing behavior lives here. |
| `validateQuoteForAuthorization` | Verify eligibility, fee bound, amount, expiry and recipient; then inspect the actual bytes. A price-only/failed build is never signable. |
| `inspectInvestmentTransaction` | Resolve every lookup table; obtain before/after simulation data for every writable account. It validates required signers, fee payer, the narrow supported venue ABI, encoded economic limits, recipient, tenant asset loss/authority changes, sponsor budget and exact-message simulation hash. |
| `observeSolanaSignature` / `reconcileSolanaSignature` | Verify finality and raw mint/owner/account deltas against the persisted message authorization. Unknown/missing evidence does not mean zero balance or authorize creating a replacement intent. |

Build instructions with `@solana/kit` 5.x; the root application owns message compilation, blockhash lifetime, Privy signing, Kora/server sponsorship, persistence and broadcast. These helpers do not perform swaps, provide a faucet, manufacture market returns, or sign transactions. `investmentExecutionAvailability()` explicitly reports that real issuer execution remains unavailable in this test prototype.

The restricted test-escrow server integration is implemented in `src/server/solana-service.ts`, `src/server/solana-initialization.ts` and `src/server/solana-rpc.ts`. Its [operator setup and HTTP contract](../../../app/api/finance/solana/README.md) explain the required verified deployment, accepted agreement, passkey and wallet ownership, sponsorship, persistence and unavailable-state gates. The manifest explicitly chooses joint/staged setup. Mainnet execution remains unavailable.

The optional deployment field `ledgerDepositMint` accepts only the site-owned, six-decimal classic SPL devnet mint `BCgqGAUvbGobqXrJtEDS437i8r1FffVSGcnwCsHcN2oE` (`SOLANA_TEST_USDC_MINT`). `ledgerDepositMint(manifest)` selects it for **new** escrows; without the field, new escrows still use Circle devnet USDC and fund plus supply to KLend. `depositMint` always remains the reviewed Circle reserve-asset pin, not a mutable alias for the new cash token. Initialization may retain those existing KLend account identities alongside site dollars, but site-dollar deposits fund cash only: the server never plans supply or earnings release for them. They have no monetary value or lending yield.

An existing on-chain tenancy's `depositMint` governs payout ATAs, funding source, token-account validation, balances and reconciled deltas, independent of the current new-tenancy selection. This preserves Circle tenancies across configuration cutover and rejects unreviewed mints. Portfolio stock trading remains denominated in Circle test USDC; site-dollar faucet funds are not stock-trading liquidity.

For program actions, match the persisted intent and on-chain nonce as well as token receipts. Claim approval has no token delta and needs the tenancy state transition; it is not a payment. Supply amounts are caps because KLend rounds to whole receipt units; use observed cash/receipt changes rather than assuming the requested amount was fully spent. Never infer settled earnings from an unexplained cash donation.

Existing pinned joint and staged manifests keep their direct-transfer settlement ABI. Only a **future, separately deployed and reviewed** manifest with `escrowVersion: "pull-v2"` may decode owed balances and build `payout(landlord, nonce)`. In that version, settle has no token delta and records two obligations; each payout requires an exact escrow debit and one fixed ATA credit. A finalized settlement alone is not evidence of payment. Every new persisted operation binds genesis hash, escrow program and pinned binary SHA-256; an expired unsigned review cannot silently switch deployment.

The complete native proof and its limits are recorded in `programs/rental_escrow/README.md`. The 3,000/10/120 scenario is a controlled test fixture, and the stock/ETF portfolio belongs to the tenant outside the escrow. A scaled Token-2022 display balance is a reporting value; order sizes and reconciled positions use raw token units.
