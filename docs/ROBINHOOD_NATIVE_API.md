# Robinhood native finance API

This API prepares and reconciles the restricted `RentalEscrow` actions. It is
separate from the persisted demonstration ledger. A fixture, HTTP success, user
claim, transaction hash, or successful simulation never books native money.
Sending is disabled by default. No live escrow deployment or mainnet transaction
was created while implementing these routes.

## Configuration and deployment binding

Read and planning configuration:

| Variable                                          | Required behavior                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ROBINHOOD_RPC_URL`                               | Operator-selected HTTPS RPC, verified chain 4663                                 |
| `ROBINHOOD_ESCROW_ADDRESS`                        | One fixed tenancy escrow; requests cannot substitute it                          |
| `ROBINHOOD_ESCROW_CODE_HASH`                      | Keccak-256 of this deployment's complete runtime, including its immutable values |
| `ROBINHOOD_AGREEMENT_ID`                          | Recorded `agreement:<id>`; required before funding                               |
| Privy identity and durable database configuration | Same verified identity and Store used by the application                         |

The canonical USDG and Morpho vault addresses come from the reviewed mainnet
manifest. `observeConfiguredEscrow` reads the escrow at one block, checks its
dependency addresses and chain, then checks the runtime twice:

1. The complete code hash must equal the configured deployment hash.
2. After zeroing only the compiler's recorded immutable slots, the runtime must
   match the compiled `RentalEscrow` fingerprint in
   `src/finance/robinhood/deployment.ts`.

A different contract with plausible getters cannot pass. A proxy is not accepted.
The normalized check does not validate the safety of third-party USDG/Morpho
upgrades; those remain protocol dependencies. This is a hackathon implementation,
not an independent security audit.

The deployment operator must build with `contracts/evm/foundry.toml`, verify the
constructor's parties, personal wallet, security, release policy and agreement
hash, and derive the full code hash from the resulting deployed runtime. Do not
use the normalized hash as `ROBINHOOD_ESCROW_CODE_HASH`. The fingerprint check can
be reproduced after a local build:

```sh
cd contracts/evm
~/.foundry/bin/forge build --offline
cd ../..
node --experimental-strip-types contracts/evm/script/check-runtime.mjs
```

Any contract/compiler change requires explicit review and a new fingerprint.
The API does not deploy or upgrade contracts.

Sending additionally requires all of:

| Variable                              | Meaning                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `ROBINHOOD_SEND_ENABLED=1`            | Explicit operator opt-in to sending                                                     |
| `ROBINHOOD_SPONSOR_PRIVATE_KEY`       | Dedicated server-side gas account, distinct from every party and the personal portfolio |
| `ROBINHOOD_SPONSOR_MAX_GAS`           | Integer gas ceiling, 21,000–2,000,000                                                   |
| `ROBINHOOD_SPONSOR_MAX_FEE_WEI`       | Positive integer max-fee-per-gas ceiling, at most 100,000,000,000 wei                   |
| `ROBINHOOD_SPONSOR_MAX_TOTAL_FEE_WEI` | Positive integer total fee ceiling, at most 100,000,000,000,000,000 wei                 |

These are ceilings, not fee predictions. The server obtains a fresh gas estimate,
adds a 20% gas margin, and rejects estimates over any configured ceiling or the
sponsor's balance. Every signed EIP-1559 transaction has zero native value and
targets only the exact authorized escrow relay calldata. Keep the key in local or
deployment secrets, never a `NEXT_PUBLIC_` variable, browser, response, or repository.
The sponsor must be dedicated to this service; its database reservation cannot
coordinate external use of the same key. No such key has been configured here.

## HTTP contract

All routes run in the Node runtime. Requests require
`Authorization: Bearer <Privy access token>`. The server verifies the token and
provider wallet ownership, then matches the EVM wallet to an immutable tenant,
landlord or arbitrator address. Concurrent requests with the same verified
access token share the provider check for at most 30 seconds (and never past
token expiry); failed checks are not cached. Mutating requests also require the
application Origin and `Content-Type: application/json`. Responses are `no-store`.
There is no demonstration-cookie authorization on these routes.

| Method and route                                       | Request / result                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/finance/robinhood`                           | Fresh snapshot, assigned party wallet ID/role, configuration gates and optional preview-derived planning hints                                             |
| `POST /api/finance/robinhood/operations`               | `{operationId, walletId, intent}`; lowercase UUID v4, exact allowed intent fields; returns persisted signing review                                        |
| `GET /api/finance/robinhood/operations/:id`            | Stored operation for the same verified subject and wallet; never takes a client transaction hash                                                           |
| `POST /api/finance/robinhood/operations/:id/authorize` | `{signature}` only; verifies the stored digest and re-simulates before preparing a sponsor transaction                                                     |
| `POST /api/finance/robinhood/operations/:id/retry`     | `{}` only; verifies current ownership, recovery and deployment, reconciles, then may resend the exact saved transaction without another signature or nonce |
| `POST /api/finance/robinhood/operations/:id/reconcile` | `{}`; read-only native receipt reconciliation                                                                                                              |

Amounts, shares, nonces and deadlines use unsigned decimal atomic strings. USDG
has 6 decimals, and the reviewed vault shares have 18. There are no floats or
JavaScript `Number` money calculations. Clients cannot provide an RPC URL, chain,
recipient, spender, target, calldata, native value, replacement fee, nonce or
transaction hash.

Supported intents:

```json
{"kind":"acceptAgreement"}
{"kind":"fund"}
{"kind":"supply","assets":"3000000000","minShares":"2970000000000000000000"}
{"kind":"releaseEarnings","assets":"10000000","maxSharesBurned":"11000000000000000000"}
{"kind":"proposeClaim","assets":"120000000","evidenceHash":"0x...64 hex digits..."}
{"kind":"acceptClaim","minimumAssets":"3000000000"}
{"kind":"contestClaim"}
{"kind":"resolveClaim","landlordAssets":"120000000","minimumAssets":"3000000000"}
{"kind":"settle","minRedeemedAssets":"2999000000"}
```

These amounts are examples, not current executable quotes. A settlement floor
must reflect the parties' explicit decision if there is a shortfall. The contract
enforces liquidity, role, state, claims, principal, policy, consent and slippage.
GET planning hints use same-block previews. Supply checks
`idle USDG remaining + previewRedeem(previewDeposit(supply amount))` against the
contract's security requirement and leaves a small cash remainder when vault
rounding would otherwise make the accounting value fall short. The search is
bounded and returns no hint if it cannot find a safe amount. The hint retains its
2 basis point minimum-share bound; simulations remain mandatory and the hint does
not guarantee execution or liquidity. Release uses eligible earnings and
`previewWithdraw` with 2 basis point bounds at the same observed block.
`planningHints.settle` applies the same haircut to `previewRedeem(trackedShares)`
for the vault-specific redemption minimum; it uses zero when no vault shares
remain. The contract independently preserves the approved total-assets minimum.
A failed preview yields an unavailable hint; it never yields an invented amount.
The UI must review the final exact bounds.
Simulations remain mandatory because a preview does not prove cash liquidity.

The authenticated GET also includes `agreementId` or `null`, for linking private
claim and arbitration records to the same recorded tenancy. The plan result includes `id`, `walletId`, `chainId`, `escrowAddress`, `intent`,
`action`, `digest`, `expiresAt`, `description`, `state`, `transactionHash` and
`reconciliation`. It never exposes the sponsor key, role signature or raw sponsor
transaction. Pass the action directly to the wallet's `signEvmTypedData` review.
The action expires after five minutes. Repeating a UUID with identical subject,
wallet and intent returns the original plan; changed terms return
`idempotency_conflict`.

The typed schema is the contract's exact `RentalEscrow` EIP-712 schema, documented
in `contracts/evm/README.md`. The server accepts canonical 65-byte low-S EOA
signatures for the verified embedded wallet. ERC-1271 is supported by the
contract but is not represented as a working consumer wallet integration.

## Funding gates

Planning, authorization and retries call `requireWalletAccess`, which requires
a provider-verified passkey and the selected sole-owned wallet. No email or
second-session recovery proof is required ([ADR 0014](adr/0014-passkey-only-test-accounts.md)).

Funding additionally requires the recorded agreement to match the escrow's
agreement hash, parties, USDG network, required security and release policy. The
personal recipient must be the recorded tenant's EVM wallet. The caller's Privy
subject and wallet ID must be that recorded tenant. Both tenant and landlord must
have accepted the same digest in the application; the contract separately
requires both on-chain consent actions.

The tenant must already have enough USDG allowance for the fixed escrow.
Otherwise the API returns `funding_approval_required` with a bounded, exact-amount
approval plan and `execution: unconfigured`. It does not submit that approval.
The signed relay cannot authorize a token approval for an EOA; user-owned wallet
transaction sponsorship or a supported permit flow needs separate integration.
Funding balance failures and all other native simulation failures remain blocked.

## Persistence, retries and reconciliation

An operation moves from `planned` to `prepared`, then `submitted` or
`broadcast_unknown`, then `confirming` and `completed` or `reverted`.
`unverified` means the receipt did not prove the exact expected action. A failed
RPC observation preserves uncertainty. The UI should retain the operation ID and
transaction hash and use reconciliation, never recreate a payment automatically.

The service reserves the dedicated sponsor account in Store. Only one prepared
transaction can occupy its nonce queue at a time. Preparation has a 60-second
lease with a unique fencing token: an expired preparer cannot persist or
broadcast after another request takes the reservation. A preparation failure
releases only its own reservation.

Before any broadcast, the complete signed raw transaction and its derived hash
are persisted first in the sponsor reservation and then in the operation. If the
second write fails, retry recovers the same envelope from the reservation. If a
broadcast response is lost, the same operation reuses identical signed bytes.
It never selects a replacement nonce, raises fees, or fabricates success. An
already prepared reservation has no automatic expiration and is released only
after confirmed completion or confirmed reversion. If a prepared transaction
expires without a conclusive receipt, retain its record for operator diagnosis;
do not delete the reservation or submit a new payment blindly.

After a browser reload, load the existing operation ID and use `/retry` to resend
saved bytes. The retry body accepts no signature, transaction hash, fee, amount or
recipient. It never invokes sponsor transaction preparation or nonce selection.
It can also recover the same signed envelope from the sponsor reservation after
an interrupted operation write; `no_saved_transaction` means no signed envelope
exists and nothing was created. The UI should save the operation ID before its
initial planning request and use it as an untrusted locator for authenticated GET.

Retry rechecks the verified party wallet, durable recovery, current compiled
deployment, dedicated sponsor, fee ceilings and funding gates where applicable.
It reconciles before considering a send. Confirmed, confirming, reverted and
unverified records are not rebroadcast. A retry requires a reliable pending
receipt observation, the original escrow nonce, a matching sponsor reservation,
an unexpired authorization and successful simulation of the exact saved call.
Unavailable observations, expired authorization or a changed nonce retain the
saved record and produce an explicit error; the UI must keep reconciliation
available and must not automatically create a replacement financial intent.

Reconciliation checks the exact transaction destination, calldata and zero
value, the canonical receipt block, the signature-authorization event, and the
expected financial event with its exact operation nonce. Three confirmations are
required, including for a reverted transaction, before releasing the sponsor
reservation. Three L2 blocks are an application confirmation threshold, not a
claim of irreversible L1 finality. A deeper reorganization still needs operator
handling; this service does not automatically reverse other application ledgers.

The exported worker is:

```ts
reconcileRobinhoodOperations(store, publicClient, config, (after = ''), (limit = 50));
// => { results: [{ id, state }], nextCursor: string | null }
```

Only invoke it behind the application's worker authentication. It scans stored
native operations, reads receipts and updates their evidence; it never signs,
broadcasts, pays anyone, or writes the demonstration workspace. Unconfigured
native finance should be skipped explicitly by the worker.

## Evidence and remaining integration work

The server suite uses SQLite persistence and real generated-key EIP-712 and
EIP-1559 cryptography with injected RPC observations. It covers party/subject
binding, unknown request fields, recovery, accepted agreement matching, funding
allowances, duplicate and concurrent requests, gas/fee/recipient tampering,
interrupted database writes, an expired preparation lease, ambiguous broadcast,
database restart without re-signing, authenticated retry gates, partial-vault
settlement bounds, and exact receipt reconciliation. These tests make no network
transactions. The compiled-runtime check also tests altered immutable values and
rejects modified program bytes. Run:

```sh
node --experimental-strip-types --test src/server/robinhood-service.test.ts src/finance/robinhood/native.test.ts
```

The separate Foundry suite proves the restricted escrow/relay locally and the
pinned Robinhood Morpho proof executes real protocol code on a local fork; see
`contracts/evm/README.md`. Neither is an end-to-end deployed user session.

Still required for connected execution: configured Privy ownership/recovery,
durable hosted storage, a reviewed tenancy deployment, accepted agreement,
funded user-owned wallet, initial USDG approval, a dedicated funded gas sponsor,
and explicit send enablement. Stock Tokens acquisition and disposal, issuer
eligibility, 0x institutional route access, personal trade gas and fiat withdrawal
remain separate provider-gated work. The current server does not turn a gated
stock quote or the demo's portfolio into a native trade.
