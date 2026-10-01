# Solana native operations

The [service setup and HTTP contract](../app/api/finance/solana/README.md) is the canonical operator guide. It covers the test deployment manifest, exact-message wallet signing, sponsor fee/rent limits and recovery of persisted operations.

The application exposes those controls in **Home** after authenticated passkey access. A real accepted agreement, sole-owned wallet and matching initialized test escrow are required. Localnet has no Privy browser-signing claim. The native [Anchor/Kamino execution proof](../programs/rental_escrow/README.md) is independent of provider setup.

An [operator-key devnet rehearsal](SOLANA_DEVNET_REHEARSAL.md) deployed the original test program and completed a 10-test-USDC custody cycle through Kamino. Its test tenancy does not match a Privy agreement or wallet. Separately, one Privy-connected joint-signature tenancy finalized funding and supply and remains active. Another on the staged program completed setup, funding, supply, redemption, zero-claim acceptance and full tenant payout. Independent finalized reads found closed escrow with zero cash/receipts, 10 test USDC at the tenant's fixed payout account and zero at the landlord's.

No mainnet escrow writes or issuer test-network trades are enabled. A read-only mainnet Jupiter quote is pricing evidence, not a deployed devnet investment route.

## Site-owned test USDC (tUSDC)

The optional manifest field `ledgerDepositMint` selects the mint for **new** tenancies. Set it to `BCgqGAUvbGobqXrJtEDS437i8r1FffVSGcnwCsHcN2oE`, the site-owned classic SPL Token devnet mint with 6 decimals. Those deposits stay in cash escrow: no KLend supply, no lending and no interest. Any rental-deposit earnings belong to the tenant. These site-minted test tokens have no monetary value and are not Circle USDC. Omitting the field preserves the existing Circle-USDC + KLend path. Existing tenancies remain bound to their recorded mint; this is not a token migration.
Solana portfolio trading remains Circle-USDC-backed; the new mint is for tenancy cash deposits and their separately reported wallet balance, not a replacement trading currency.
The existing manifest `depositMint` remains the Circle/KLend reserve pin; `ledgerDepositMint` does not replace it. Each existing escrow's recorded `tenancy.depositMint` governs its token accounts, transaction deltas and balances.

The signed-in Home funding step and Money's Test money card call `POST /api/test-usdc` through the authenticated same-origin request helper, with an empty JSON body. The server requires a verified Solana wallet and selects its destination; the caller cannot choose a recipient.

| Response | Meaning |
| --- | --- |
| `{ "status": "unconfigured", "error": "…" }` with HTTP 503 | Site minting is unavailable; the request helper displays the explicit error. Do not redirect a tUSDC tenancy to Circle's different token. |
| `{ "status": "pending", "signature": "…" }` | Mint submitted but not yet confirmed; repeat the endpoint to recover the same request. |
| `{ "status": "confirmed", "signature": "…", "amountAtomic": "10000000000" }` | Confirmed 10,000 tUSDC at 6 decimals (the amount is configurable). |
| `{ "error": "…" }` with an error status | Authentication, origin, wallet, limit, configuration or transaction failure; no success claim. |

`SOLANA_TEST_USDC_MINT_AUTHORITY` is a server-only dedicated devnet keypair encoded as a **JSON byte array**, kept in the deployment Secret; never use a mainnet key or expose it as `NEXT_PUBLIC_`, in the manifest or in source control. `SOLANA_TEST_USDC_AMOUNT` is whole tokens, default `10000`; `SOLANA_TEST_USDC_DAILY_CAP` is requests per UTC day, default `200`. A request is allowed once per 24 hours per account **and** wallet. Durable reservations and the persisted signed transaction prevent concurrent/retried requests from producing duplicate mints; retries reconcile or rebroadcast that same transaction. Storage must survive restarts and be shared by replicas. Adding configuration does not deploy a program or send a transaction.
The faucet requires a devnet manifest with `ledgerDepositMint` selected, plus both the mint-authority and fee-sponsor settings. Unknown RPC evidence never permits rebroadcast; only proven signature absence with the original blockhash still valid permits sending the exact saved bytes again. An expired, absent transaction becomes terminal and still consumes the 24-hour quota; it is not replaced by a fresh mint.


**Pending, not deployed:** Local custody fixes enforce canonical classic-Token ATAs for both initialization modes and replace one atomic settlement transfer with recorded, independently claimable tenant/landlord obligations. The program ABI gains `payout(landlord, nonce)` and a 499-byte account layout; no present devnet tenancy uses this version. The client requires an explicit future `escrowVersion: "pull-v2"` manifest with a newly reviewed program ID and binary hash; existing joint/staged manifests remain on the 483-byte, direct-transfer version. The server now rejects noncanonical destinations even on existing programs and binds each newly prepared operation/review to genesis, program ID and code hash. The staged setup receipt stays finalized after the tenancy advances, subject to immutable binding checks. Before any new custody deployment, separately authorize a fresh program key, change `declare_id!`, rebuild/retest, review upgrade authority and artifact, and publish a **new** manifest; do not alter pinned historical hashes or deploy/upgrade based on this local proof alone.
