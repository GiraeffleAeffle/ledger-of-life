# Share-deposit API reference

All routes require the existing authenticated account. POST additionally requires same-origin JSON. Responses are private/no-store. The server never accepts a caller-selected role or signs for a party. Amounts are exact raw decimal strings: USD-6 for USD, 18 decimals for test TSLA; native value is always zero, chain 46630.

## Listing and accepted terms

`POST /api/listings` creation accepts `depositForm: "cash" | "shares"` (omitted means cash), `requiredSecurity` in USD-6 and optional `responseWindow`, `returnWindow`, `arbitrationWindow` whole seconds (1 hour–400 days; defaults 7/7/30 days). Shares use the manifest factory and fixed official stock/feed, 15000 initial ratio and 12500 warning ratio. Cash retains site tUSDC and simulated yield. Share listing parties require verified EVM wallets, including the distinct invited arbitrator.

Public listings, invitation previews, agreement views and account exports carry `depositForm`. New agreements with an explicit form use `rental-agreement-v2`, canonical ordered discriminated deposit terms. Legacy agreements without the field retain their exact v1 digest; accepting and reading them does not migrate their bytes.

## GET /api/share-deposit

- `?rentalId=<agreement id>` returns `{view}`. `ShareDepositView` in `src/domain/share-deposit.ts` includes `kind: "shares"`, deployment, escrow, chain/state, accepted form/hash, caller role, actual `walletShares` and `lockedShares`, fresh-price `requiredShares`/`coverBps`, `needsTopUp`, fixed claim shares/quote/evidence, response/return/arbitration deadlines, outstanding landlord award, custody shortfall, server-derived `actions`, warnings, explorer URL and existing `priceJob` health.
- `?listingId=<listing id>` returns `{deployment, quote, requiredShares, walletShares, walletAddress, priceJob}` for the verified EVM applicant wallet before Apply. Missing deployment returns null amounts/quote; stale price returns null required shares. A missing verified wallet refuses the quote rather than using a browser-supplied address. Robinhood’s faucet gives five test TSLA per claim.

`quote` is `{priceUsd6, sourceTime, copiedAt, fresh}`; timestamps are Unix seconds. Never interpret stale/unavailable valuation as zero coverage. A missing/null manifest yields `deployment: "not_deployed"`, “Share deposit not deployed yet” and no actions. The current reviewed deployed manifest is shipped in the image, not hard-coded in the service.
Unavailable/failed oracle reads, zero price and zero source time return `quote:null`, not a $0 quote dated 1970. `maximumWithdrawShares` is full custody in AwaitingLock, the positive custody remainder above the exact rounded-up 150% requirement in Active with a fresh price, and null when not withdrawable or unpriced. Zero withdrawal is a 400; Active withdrawal below 150% and acceptance below fixed claim shares are 409 refusals. Gas-estimation refusal is also a 409 naming the action, not a misleading service outage.
`view.receipts` retains `{planId,walletId,transactionHash,action,status}` across reloads for agreement parties. `view.paidOut` requires Closed, empty actual custody, no outstanding landlord award or current custody shortfall, and a matched confirmed payout receipt; empty custody alone may be an issuer burn. Share agreements never authorize Solana sponsor work through `POST /api/journey {action:\"advance\"}`; cash account setup and sponsor payouts remain unchanged.

## POST /api/share-deposit: prepare

Request: `{action: "prepare", rentalId, operation, shares?, usd6?, maxShares?, side?, evidence?}`. Response: `{plan}`; `ShareDepositPlan` contains durable id, rental/action, wallet id/from, chain/target/calldata/value, EIP-1559 transaction including exact nonce/gas/fees, expiry, and human review plus `{factory, escrow, stock, functionName, args, terms, role, approvalShares, priceUsd6}`. Terms contain the eight accepted creation fields, with numeric values as decimal strings; escrow is always the predicted CREATE2 address, including before creation. The client signing policy can independently derive it from the bundled factory/implementation pins. Approval shares are the exact finite reviewed amount. Bigints in review args are strings. Wallet operation id is `share-deposit:<planId>:0`. Reviews disclose contract/function/chain/value, exact human shares, available USD-at-quote and source/copy times. A proposal’s share estimate can change if a new oracle quote arrives before mining; on chain the conversion becomes fixed at proposal.

| Operation | Role | Input / behavior |
|---|---|---|
| create | landlord | Accepted complete terms; creates empty factory clone |
| approve | tenant | `shares`; exact finite TSLA allowance to bound escrow |
| pledge | tenant | `shares`; requires that exact allowance and enough wallet TSLA |
| activate | any agreement party | AwaitingLock, fresh 150% cover |
| withdraw | tenant | `shares`; AwaitingLock price-free; Active preserves fresh 150% |
| proposeClaim | landlord | `usd6`, `evidence` (10–8,000 chars); USD capped at security; evidence record hash committed; zero closes with full return |
| acceptClaim | tenant | `maxShares`; current fixed claim at most this reviewed upper bound |
| contestClaim | tenant | `evidence`; latches arbitration authority/start |
| lowerClaim | landlord | `usd6`; strictly lower, uses stored proposal price without resetting windows; zero closes |
| escalateClaim | any agreement party | Response deadline reached; no consent/automatic landlord award |
| resolveClaim | arbitrator | `shares`, `evidence`; arbitration authority and unexpired window; clamp to current lowered claim |
| requestReturn | tenant | Active; starts immutable return deadline once |
| closeUnclaimed | any agreement party | Return window expired without timely claim; zero landlord award |
| closeUnresolved | any agreement party | Arbitration window expired; zero landlord award |
| payout | any agreement party | `side: "landlord" | "tenant"`; fixed recipient, landlord priority up to outstanding award |

Evidence records are part of the durable plan and saved into the agreement only after its matching confirmed receipt. No optional permit request is exposed; ordinary exact approval then pledge is the app convention.

Every preparation verifies the manifest’s factory/implementation/dependency code pins, factory implementation, `(landlord, agreementHash)` escrow lookup, CREATE2 prediction, clone runtime and every escrow term versus the accepted agreement. Creation/approval/pledge additionally reuse issuer beacon/implementation/registry hashes, pause and party/escrow block safety checks. Exit calls are not app-gated by issuer safety, but issuer restrictions can still cause the token transaction to revert.

## POST /api/share-deposit: submit

Initial request: `{action: "submit", planId, signed}` with raw signed EIP-1559 bytes. The server rejects any signer, chain, value, calldata, nonce, gas, fees or access list difference from the durable review. Only a successful broadcast or a node-known transaction binds the hash and pending history; an unknown rejected broadcast removes any old pending binding. Repeat reconciliation: `{action: "submit", planId, transactionHash}` using that bound hash. Response: `{planId, transactionHash, status: "pending" | "confirmed" | "failed", view}`. An exact mined revert becomes terminal `failed`, never permanently pending, and currently valid actions remain available. Only a successful exact receipt with expected escrow/token events confirms a plan. Closed alone is not Paid out; actual empty custody is required.

Errors return `{error}`: 400 malformed input/amount/evidence, 401 invalid session, 403 missing verified wallet/wrong party or role/unavailable rental or plan, 409 unavailable deployment/state/window, changed agreement/read-back/pins, stale quote for a priced action, unsafe inflow, expired review or mismatched transaction/receipt. Unexpected RPC/configuration failures use the existing 503 service response.

Test TSLA has no monetary value. Shares earn no yield and settle in kind, with no forced sale, DEX or legal advice. Below 125% is only a top-up prompt. Silence never awards the landlord; after the arbitration window anyone can return custody to the tenant. Proven on the hosted site on 1 October 2026 with three fresh passkey accounts ([evidence](evidence/HOSTED_SHARE_DEPOSIT_ROBINHOOD_TESTNET_2026-10-01.json)); timeout exits are contract-tested only.
