# Solana test escrow service

These Node routes connect accepted tenancy agreements and the original recovered Privy wallets to the restricted native escrow. They support one explicitly configured tenancy on **devnet or localnet**. The original deployed program requires tenant and landlord to sign the same short-lived setup transaction. The separately [verified staged deployment](../../../../docs/evidence/SOLANA_STAGED_DEVNET_DEPLOYMENT_2026-09-24.json) lets the landlord alone sign empty-escrow creation and the tenant fund later. The separate fee sponsor adds only its own signature after the required party signatures verify. The route does not deploy a program, mint funds, create payout accounts, or enable mainnet transactions. Missing configuration leaves initialization unavailable; malformed or unverifiable configuration prevents financial operations.

The native Anchor/Kamino execution proof is described in [`programs/rental_escrow/README.md`](../../../../programs/rental_escrow/README.md). A separate [operator-key devnet rehearsal](../../../../docs/SOLANA_DEVNET_REHEARSAL.md) completed funding → Kamino supply → redemption → no-claim settlement. A Privy-connected joint-signature tenancy subsequently finalized setup, funding and supply and remains active. The staged instruction separately passed LiteSVM, was deployed with verified bytes, and initialized another Privy-backed escrow. That second tenancy finalized exact funding, supply, redemption, zero-claim acceptance and full tenant payout.

## Required operator configuration

Set these **server-only** variables; none may use a `NEXT_PUBLIC_` prefix:

| Variable                     | Value                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOLANA_RPC_URL`             | The reviewed test RPC. HTTPS is required except for a loopback HTTP endpoint.                                                                                              |
| `SOLANA_DEPLOYMENT_MANIFEST` | JSON matching the schema below, recorded from the actual deployment and reserve accounts.                                                                                  |
| `SOLANA_SPONSOR_KEYPAIR`     | A dedicated test sponsor's 64-byte Solana keypair as a JSON integer array, held in local environment storage or a secret manager. It must differ from every tenancy party. |

The following is a **schema example, not usable deployment configuration**. The [deployment evidence](../../../../docs/evidence/SOLANA_DEVNET_DEPLOYMENT_2026-09-23.json) now provides verified devnet program and reserve fields. The example still needs a separate accepted **application** agreement, matching Privy-owned tenancy, fee sponsor and reviewed server configuration. Do not substitute the closed operator-key tenancy.

Run `node --experimental-strip-types scripts/probe-solana-devnet.mjs` from the repository root to repeat the public devnet account probe. It checks the pinned genesis, test mint, KLend executable, reserve/market/vault identities, receipt mint and configured oracle-account presence without creating accounts or sending transactions. The [23 September snapshot](../../../../docs/evidence/SOLANA_DEVNET_RESERVES_2026-09-23.json) contains 21 matches, 17 passing account-state checks. The [operator receipts](../../../../docs/evidence/SOLANA_DEVNET_ESCROW_REHEARSAL_2026-09-23.json) prove the selected reserve's refresh, deposit and redemption through this escrow. Recheck live state before any new tenancy or transaction; keep app writes disabled until a Privy-backed agreement and matching initialized tenancy are reviewed.

```json
{
  "cluster": "devnet",
  "setupMode": "joint",
  "genesisHash": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "escrowProgram": "<deployed-test-program-address>",
  "programSha256": "<64-lowercase-hex-sha256-of-built-so>",
  "programCodeLength": 1000,
  "upgradeAuthority": "<reviewed-upgrade-authority-or-null>",
  "depositMint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "market": "<test-KLend-market>",
  "reserve": "<test-KLend-reserve>",
  "receiptMint": "<receipt-mint-recorded-in-reserve>",
  "liquiditySupply": "<liquidity-vault-recorded-in-reserve>",
  "marketAuthority": "<derived-KLend-market-authority>",
  "oracleAccounts": ["<configured-test-oracle-if-required>"],
  "maxObservationAgeMs": 15000,
  "agreementId": "<accepted-application-agreement-id>",
  "tenancyAddress": "<initialized-tenancy-PDA>",
  "maximumSponsorLamports": "100000"
}
```

`programCodeLength` is the exact byte length of the reviewed `.so`, not the placeholder `1000`. The service validates the program loader, executable flag, ProgramData address, upgrade authority, code length and SHA-256. Upgradeable-loader allocation padding after the recorded code must be all zero. An immutable legacy BPF deployment requires `upgradeAuthority: null`. A changed executable or authority requires a new review and proof; updating an environment value alone does not establish that proof.

For localnet, use its actual genesis hash and `cluster: "localnet"`. The asset remains the explicitly configured test USDC mint. The mainnet genesis is rejected even when mislabeled as localnet. Every operation checks RPC genesis, program bytes, tenancy PDA, mint identities, reserve/market ownership, configured vaults/oracles and token-account authorities. A mainnet reserve address does not imply a matching devnet account. The locally modified SVM reserve cannot be represented as an issuer-backed or deployed devnet reserve.

The sponsor ceiling applies to the **simulated native balance debit plus transaction fee**, including possible rent. It is deliberately conservative if the simulation already deducted the fee. The cap cannot exceed `10000000` lamports in this prototype. A changed finalized bank between the balance observation and simulation requires a fresh review. Normal escrow operations use preexisting token accounts; the initialization route also simulates and caps the rent for its tenancy, cash and receipt accounts.

## CLI deployment and initialization boundary

The first two steps below were completed for the operator-key devnet rehearsal. Steps 3–5 remain for a **new, Privy-backed application tenancy**. LiteSVM does not supply an RPC server.

1. Build the reviewed program with `test-deployment`, following the native README. The default build intentionally rejects initialization. The current SBF is 397,336 bytes, SHA-256 `03193455b06f9ee8c6f96ff5504f5fb97fb3ed839164676e3e9afcec55ca4377`; the earlier binary is retained separately after the null-oracle fix. The original operator machine keeps both binaries and matching keys in ignored `.testnet-secrets/solana/`. If a new operator uses another program keypair, update `declare_id!` and `Anchor.toml`, rebuild and repeat the native proof. Never commit a keypair.
2. The reviewed binary is deployed on devnet at program `BiwaGavQUsSsg48UPpRAGWoXSiUnzgvdDs7rd8WizvPD`, upgrade slot `502957809`, with dedicated authority `JCgJEV37VwWxzd2JqzFNaC847hrtPjQq9TU6c6HHxQao`. The [deployment evidence](../../../../docs/evidence/SOLANA_DEVNET_DEPLOYMENT_2026-09-23.json) pins ProgramData and signature. The service verifies executable bytes and authority again before each operation. A future upgrade requires a new review and manifest hash.
3. Record a complete Solana agreement in the application. Its tenant, landlord and assigned arbitrator must use provider-verified, sole-owned wallets and have a passkey. Tenant and landlord must accept the same `agreementDigest`. No email or second-browser recovery proof is required.
4. Precreate the tenant and landlord **associated** test-USDC payout accounts. Derive the tenancy PDA from `sha256("rental-lease-v1:solana:" + genesisHash + ":" + escrowProgram + ":" + agreementId)` and the tenant wallet. Configure that PDA and agreement ID in `SOLANA_DEPLOYMENT_MANIFEST` alongside the reviewed program and reserve fields, and set a dedicated fee sponsor. The server verifies the payout-account authorities, program bytes/upgrade authority, reserve and sponsor cost before offering a signing window.
5. With `setupMode: "joint"` (the default for the original deployment), tenant and landlord must sign the **same** initialization message before its blockhash expires. The arbitrator observes but does not sign. The server verifies each Ed25519 signature, adds only its fee signature, persists the fully signed bytes before broadcast, then verifies both the finalized receipt and the on-chain agreement binding. With `setupMode: "staged"` on the separately verified program, only the landlord signs empty-escrow creation; the tenant separately signs funding later. This source path is blocked for the old program ID. An ambiguous broadcast can only retry the identical persisted transaction while it remains valid; a new transaction is not silently substituted.

After all parties join and the two acceptances are recorded, the read-only planner prints the exact public manifest and derived payout accounts, and reports which payout accounts are missing:

```sh
node --env-file-if-exists=.env.local --experimental-strip-types scripts/plan-solana-app-tenancy.mjs AGREEMENT_ID
```

It reads the app's configured database and the pinned public deployment evidence. It makes no wallet or environment changes. The operator creates missing associated token accounts, stores the manifest as a server-only environment value, configures a separate test fee sponsor, and restarts the app. The planner's output is public account metadata; never add the sponsor keypair to a repository or browser environment.

The existing joint-signature application agreement has proved setup, funding and supply and remains active. A different Privy agreement proved staged setup, funding, Kamino supply/redemption, zero-claim acceptance and final settlement. Its finalized on-chain state is `closed` with zero escrow cash and receipts; independent token reads found 10 test USDC at the tenant's fixed payout account and zero at the landlord's. The independent operator rehearsal does not grant this server authority over its tenancy or user wallets.

## HTTP contract

All endpoints require the application's verified bearer token. Writes additionally require the expected same-origin request. Financial values are canonical decimal strings of atomic units; no JavaScript floating-point money crosses the boundary.

| Endpoint                                            | Input and result                                                                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/finance/solana`                           | Availability, verified party/`walletId`, `feePayer`, cluster/genesis, tenancy balances, operation history and trading availability.                                          |
| `GET /api/finance/solana/initialize`                | Configured agreement, derived tenancy, current initialization state and the current party's wallet ID.                                                                      |
| `POST /api/finance/solana/initialize`               | `{ "action": "prepare" | "sign" | "reconcile" | "retry" }`; `sign` also carries `signedTxBase64`. Joint mode requires tenant and landlord; staged mode requires the landlord only. All writes require same origin. |
| `POST /api/finance/solana/operations`               | `{ "requestId": "stable_request_id", "action": { "kind": "fund" } }`; returns `{ "operation": ... }`.                                                                        |
| `GET /api/finance/solana/operations/:id`            | The persisted operation and receipt state.                                                                                                                                   |
| `POST /api/finance/solana/operations/:id/authorize` | `{ "signedTxBase64": "<actor-signed-transaction>" }`; returns the persisted send/unknown state.                                                                              |
| `POST /api/finance/solana/operations/:id/reconcile` | `{}`; reads chain evidence and returns the receipt state. It neither signs nor sends a new transaction.                                                                      |
| `POST /api/finance/solana/operations/:id/retry`     | `{}`; the original recovered actor can reconcile and conditionally resend only the already persisted signed transaction. No transaction bytes or new signature are accepted. |

Supported actions are `fund`, `supply`, `redeem`, `release_earnings`, `propose_claim`, `respond_to_claim`, `resolve_claim`, and `settle`. Amount-bearing actions use `amountAtomic`; redemption uses `receiptAtomic` and `minimumReceivedAtomic`; a claim response uses boolean `accept`. Funding always uses the fixed tenant payout account as the source and exact required principal. The browser cannot supply program IDs, CPI targets, arbitrary instructions, recipients, fee payers or account lists.

The public operation includes `id`, `walletId`, `actor`, `action`, `nonce`, `state`, `expiresAt`, `lastValidBlockHeight`, `messageSha256`, unsigned `transactionBase64`, simulation budget and expected token deltas. The fully signed bytes remain server-side. The lifecycle is `prepared → signed → broadcast/unknown → finalized/failed`; an unsigned plan whose blockhash has expired can become `expired`. One active operation reserves the tenancy's nonce atomically. Reusing a request ID for the same action returns the existing operation; another action is rejected. A demonstration lane is bounded to 500 operations and then needs operator archival.

For Privy, decode `transactionBase64` into a `Uint8Array` and pass the exact bytes, `walletId`, `feePayer`, `operationId`, human-readable action description, `expiresAt`, and `chain: "solana:devnet"` to the sign-only wallet helper. Return the resulting bytes as base64. The user's wallet must already be a required signer. `walletChain` is **null for localnet** because this Privy integration does not claim localnet support. Localnet execution remains a native/operator test path, not a working Privy browser journey.

Authorization revalidates identity, passkey and wallet ownership, accepted agreement, chain state, nonce, expiry and the **exact actor-signed transaction** in simulation. It verifies the actor's Ed25519 signature, adds only the configured sponsor signature, checks that the actor signature and message remain unchanged, and persists the immutable fully signed bytes and transaction signature **before** any broadcast. A failed storage write prevents broadcast. An ambiguous result retains those same bytes; authorization retries reconcile and can send only the identical persisted transaction. They do not create a replacement transfer or sign again.

The dedicated `retry` endpoint works after a browser reload without requesting another wallet signature. It requires the original operation subject, wallet ID and address, a current passkey and accepted agreement, and a verified current deployment. It reconciles first. Only a successful RPC lookup reporting the original signature absent permits rebroadcast, and then only before both the review's `expiresAt` and original `lastValidBlockHeight`, with an unchanged tenancy nonce. Missing receipt details, an unavailable block height, changed nonce or expiry leave the outcome `unknown` and keep the original nonce reserved. Timeout alone never marks a signed operation expired or permits a replacement intent. Already finalized/failed operations return their recorded result. The signed-transaction branch of `authorize` uses the same retry checks. Retries do not sponsor-sign, build a new envelope, or accept caller-supplied bytes through the `retry` endpoint.

Finalized token receipts are checked by raw account, mint, authority and bounded deltas against the persisted message. The finalized tenancy nonce must also have advanced. Claim actions require the corresponding recorded claim/approval phase when observing their immediate resulting nonce, since claim approval itself pays nothing. Missing receipt/state evidence remains `unknown`. Out-of-order polling and sends cannot regress a terminal state. The current RPC snapshot also requires the reserve accounts to remain readable and valid even for a closed tenancy; protocol unavailability can therefore delay history reconciliation.

`reconcileSolanaOperations(store, after?, environment?)` is the read-only job entry point. It scans persisted Solana lanes, processes the configured lane's already signed nonterminal operations and returns `{ available, scanned, reconciled, next }`. It does not issue new signatures or replacement transactions. Run it within the existing bounded reconciliation scheduler; no separate cron is installed here.

## Verification and remaining limits

`node --experimental-strip-types --test src/finance/solana/solana.test.ts src/server/solana-service.test.ts` exercises adapter and service tests. The service tests use real Kit Ed25519 signatures and SQLite persistence with deterministic RPC/gateway fixtures. They cover idempotency, nonce collision, replay/expiry, passkey and wallet ownership, arbitrary instruction rejection, substituted message/signature rejection, sponsor preservation of the actor signature, fee plus rent limits, durable-write-before-send, ambiguous retries, retry after reload without signing, expired/unknown lifetime and receipt evidence, claim-state finality, genesis/deployment gates, executable hash/authority and simulation-bank consistency. They do **not** constitute a live provider or browser proof. The separate native suite proves real compiled escrow and KLend execution in LiteSVM.

Personal investing stays outside rental escrow authority. Trading remains explicitly unavailable on this test chain. Jupiter's documented keyless tier permits price-only requests at 0.5 requests/second; the application must rate-limit those reads. Transaction builds require separate server API configuration plus issuer eligibility and a supported reviewed transaction route. A quote is not a fill; scaled xStocks balances are not freely withdrawable cash dividends. No issuer test deployment, live purchase/sale, banking account, cash-out or fiat guarantee is created by these routes.
