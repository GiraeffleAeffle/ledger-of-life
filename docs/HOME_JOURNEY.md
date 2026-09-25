# My home: the signed-in journey

**My home** is the real, passkey-signed flow on the Solana test network (test USDC only). The fictional walkthrough stays separate under **Demo walkthrough**.

## Flow

1. **Homes.** A landlord posts a home: title, monthly rent, deposit amount and earnings policy. Signed-in people apply with a short note; applicants never see each other. The landlord chooses one applicant, which creates the agreement with landlord and tenant already bound.
2. **Agreement.** The landlord invites a neutral arbitrator with a one-time private link. Tenant and landlord then accept the same terms.
3. **Deposit space.** The landlord approves once to create the empty escrow for those terms.
4. **Deposit.** The tenant approves once. The deposit is locked for this home and supplied to Kamino lending in the same transaction (`fund_and_supply`).
5. **Move-out.** The landlord proposes a deduction (0 if none) with a reason. The tenant either agrees and settles in one approval (`accept_and_settle`: accept, redeem from lending, settle), or disputes. On a dispute, the arbitrator decides and settles in one approval (`resolve_and_settle`).
6. **Paid out.** No approval is needed. The fee sponsor sends each side's payout to its own account, one transaction per side.

Each person sees a six-step progress line and exactly **one** next step. Waiting states, network confirmations and payouts refresh automatically; there are no "check result" buttons. Across the whole tenancy the three people approve 4 transactions without a dispute and 5 with one, instead of the previous 7–8.

## Architecture

- `src/server/listings.ts`: listings, applications and the choice that creates the agreement.
- `src/server/solana-tenancies.ts`: every agreement gets its own tenancy PDA inside the one reviewed deployment pinned in `SOLANA_DEPLOYMENT_MANIFEST`. There are no per-tenancy environment edits. Existing routes accept `?agreement=<id>`.
- `src/server/journey.ts`: `agreementStep` and `chainStep` compute the next step from the agreement and finalized chain state. `GET /api/journey` returns it for every tenancy the person belongs to. `POST /api/journey {action: "advance"}` runs sponsor payouts.
- Bundled actions (`solana-service.ts`) sign a fixed instruction sequence. Reconciliation checks the final nonce, the end phase and the net token effects.

## Requirements before the passkey run

- `SOLANA_DEPLOYMENT_MANIFEST` must point at the pull-v2 deployment ([evidence](evidence/SOLANA_PULL_DEVNET_DEPLOYMENT_2026-09-25.json)); settlement bundles require it.
- Each person needs a passkey, backup email and a Solana wallet, plus the one-time recovery check under **Connections**. The home screen links there when it is missing.
- The tenant needs test USDC in their wallet (Circle faucet). Payout token accounts are created automatically by the sponsor right before the landlord creates the deposit space.
- The public devnet RPC rate-limits. The gateway backs off on HTTP 429, but a keyed devnet RPC is recommended for a smooth demo.

## Portfolio

My home also shows **Your portfolio**: the person's `tSPYx` holding (the devnet Token-2022 copy of SPYx, no value), its value at the live mainnet SPYx price, distributions so far (the scaled-UI multiplier), and available test USDC. **Invest 5 test USDC** is one approval: an atomic transaction co-signed by the test market maker, which pays the fee. Devnet lending pays no interest, so the purchase uses the person's own test USDC rather than released deposit earnings. It needs `SOLANA_TEST_SIGNER_MODE=1` and the local test market (`scripts/solana-test-market.mjs setup`).

## Test helpers: one real account is enough

With `SOLANA_TEST_SIGNER_MODE=1` (local store, devnet and loopback requests only), My home shows dashed **test helper** buttons:

- **Test landlord posts a home**, then **Let the test landlord choose** after you apply.
- **Add a test applicant** to your own listing.
- **Use the test arbitrator instead** of sending an invite link.
- **Let the test party do their step** whenever you are waiting on a test person.

Test people sign with operator-held test keys through the same services. So you need **one** real account (passkey, backup email, one-time recovery check), ideally as the tenant, whose signatures are the ones that matter. Helper steps are fixtures, not wallet proof.

## Verified

A test-key run on devnet went through the real services: listing → application → choice → arbitrator invite → acceptance → setup → deposit → claim → dispute → arbitrator decision → two sponsor payouts (tenant 4.5, landlord 0.5, escrow empty). At every phase exactly one person had an action. This is not passkey evidence; the passkey run is still open.
