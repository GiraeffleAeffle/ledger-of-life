# Implementation plan

> Historical prototype exploration. Current scope and evidence are in the [build spec](HACKATHON_BUILD_SPEC.md) and [implementation status](IMPLEMENTATION_STATUS.md).

## Current boundary

The app is a Next.js/React prototype. Browser state and a pure TypeScript reducer drive fictional role workflows. It has no backend authorization boundary, external finance integration, or persistent tenant data. The frontend and legal illustrations are useful while the brand and chain are undecided.

## Next vertical slices

### 1. Select chain and prove one escrow lifecycle

Solana is the current recommendation, not an implemented dependency. Use official Solana tooling and a narrow audited-token interface. If selected, implement and test:

- Immutable tenancy participants and token mint; separate escrow authority from application operators.
- Exact token amounts and rent/fee handling. A test token must not be called mainnet USDC.
- Partial funding with an explicit outstanding balance; no claim that uncollected money is secured.
- Settlement only under the defined tenancy end, agreement, and dispute rules. No server may silently supply a second signature for a party.
- Fixed payout recipients. A request parameter cannot redirect a tenant's refund.
- Proposal versioning and replay protection; reasoned dispute decisions only by the assigned authority.
- A timeout/court-order/appeal design reviewed against the chosen jurisdiction. Do not invent legally binding deadlines from an example.
- Conservation and isolation tests: tenants, tokens, roles, proposals, and escrows cannot be mixed; early, duplicate, and unauthorized payouts fail.
- An end-to-end testnet artifact with network, mint, program, transaction signatures, final balances, and a reproducible runner.

Keep deposit yield disabled. A separate personal savings adapter can follow only after provider and custody decisions. Never route through a lending protocol simply to make the dashboard show earnings.

### 2. Connect the interface to verified state

Bind every workspace area to authenticated identities and server-enforced tenancy membership. Handle email verification, wallet ownership, enrollment, recovery, and assigned arbitrators. Model submitted, confirmed, failed, and reconciled transactions separately. Reject client-supplied balances or claims of authority.

Keep test-network and sample states clearly labeled and separate from actual account balances. Keep network, token, recipients, and amounts visible before a signature.

### 3. Add private evidence and operator controls

Private object storage, scoped signed URLs, file limits and validation, appropriate retention, deletion, and an audit history. No leases, photos, addresses, names, or unsalted predictable evidence hashes on a public chain. A hash does not automatically make personal information anonymous.

Add reconciliation, incident handling, withdrawal failures, pause/recovery plans, rate limits, and monitoring. Settlement approval and actual payout must remain distinct in the UI and ledger.

### 4. Validate a real-money pilot

One market, one approved custody/banking arrangement, one operator cohort, reviewed contract terms, and tested refund/interest reporting. Obtain independent security review for deployed custody code. Verify stablecoin, lending, and investment eligibility separately; keep legal approval and security evidence attached to a versioned deployment.

## A three-minute demo

- 0:00–0:30: Show the renter's deposit, its source, and one next action.
- 0:30–1:10: Compare move-in evidence against a proposed deduction and request review.
- 1:10–1:50: Switch to the assigned human arbitrator and explain an allocation.
- 1:50–2:30: Execute the actual testnet settlement and show the receipt and reconciled balances (future slice; currently simulated).
- 2:30–3:00: Show the operator's saved work and the separate, optional savings direction.

Use the competition deadline for the submission, not as a reason to accept real customer deposits before the pilot requirements are met.
