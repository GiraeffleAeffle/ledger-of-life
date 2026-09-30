# Home: the signed-in journey

**Home** is the real, passkey-signed flow on the Solana test network (test USDC only).

## Onboarding

Account setup starts directly, without picking a global role. A person can **Find a home** to apply, **Rent out a home** to post a listing, or join a tenancy through a private invitation; roles in tenancies come from recorded agreement parties, not account setup. Setup walks through three steps with live status, and ends there:

1. Create an account with a passkey.
2. Add a backup email.
3. Create the two wallets (automatic).

The second-browser recovery proof is **not** part of setup. It is asked the first time a wallet acts on a tenancy. The landlord meets it at the deposit-space step. The tenant and the arbitrator meet it as a "Prove you can recover your wallets" step in the tenancy card once the space exists, because the server refuses their wallet reads until it is done. Today also carries a reminder card until it is done. The person remembers their two wallets, opens the app in a different browser with **Continue with email**, and approves two signatures there; the first browser notices by itself. Local demo builds that skip the proof (`DEMO_SKIP_RECOVERY=1`, never in a production build) skip the backup email too.

After setup, Home shows a short walkthrough of the journey until the person has a tenancy (open when no test tools can play the other people), then the person's own tenancies and the listings. A tenant who needs test USDC for a deposit can use the Circle devnet faucet.

## Flow

1. **Homes.** A landlord posts a home: title, monthly rent, deposit amount and earnings policy (no photo is preselected). Signed-in people apply with a short note; applicants never see each other. An applicant may withdraw while the listing is open, and the landlord may close a listing before choosing. Choosing one applicant cannot be undone: it creates the agreement with landlord and tenant already bound, and Home asks for confirmation first. Once a tenant is chosen there is no cancel.
2. **Agreement.** The landlord invites a neutral arbitrator with a one-time private link, valid once for 24 hours. Making a new link stops the old one, and Home says so before it does. The link is kept on the landlord's device (`ledger-of-life:invite:v1:<account>:<agreement>`) so a reload does not lose it. The invited person sees the home's name and the deposit at stake before joining (`preview`, gated by the one-time token), and "Not now" records nothing. Tenant and landlord then accept the same terms: the home, the deposit and who keeps earnings. The terms do not cover rent or dates.
3. **Deposit space.** The landlord approves once to create the empty escrow for those terms.
4. **Deposit.** The tenant approves once. The deposit is locked for this home and supplied to Kamino lending in the same transaction (`fund_and_supply`).
5. **Living here / move-out.** While active, the journey stops at "Living here". **Moving out?** explains the next steps; the landlord may then propose a deduction (0 if none) with a reason. Once proposed, the full six-step journey appears automatically. The tenant either agrees and settles in one approval (`accept_and_settle`: accept, redeem from lending, settle), or disputes. On a dispute, the arbitrator decides and settles in one approval (`resolve_and_settle`).
6. **Paid out.** No approval is needed. The fee sponsor sends each side's payout to its own account, one transaction per side. Completed tenancies appear under **Past tenancies**.

Each person sees the progress through their current phase and exactly **one** next step when action is required. A tenant deciding on a deduction sees the landlord's reason and the split before agreeing; an arbitrator sees both reasons, the range from 0 to the claim and the split. Waiting states, network confirmations and payouts refresh automatically; nothing notifies the other person, and Home says so. A confirmation that takes more than 90 seconds offers **Check again**, the reconcile call the card already makes. Payouts are retried every 15 seconds while Home is open and do not run otherwise. Across the whole tenancy the three people approve 4 transactions without a dispute and 5 with one, instead of the previous 7–8.

If Journey or Listings cannot be read, Home keeps whatever loaded, names what failed and offers **Retry**; it never says "Find a place to call home" when the tenancy reading failed. After three failed background polls it says updates are paused.

While living, each tenancy has a collapsed **Service charges · prototype** statement. Its landlord can edit
the server-stored monthly test prepayment; example annual building costs use m², units and consumption keys,
and a daily Home Assistant consumption sensor is read when present. Without a consumption sensor, a labeled
example week is used. The balance and projected monthly surplus are calculations only: no escrow prepayment
or release exists. In a future implementation, those prepayments would share the deposit escrow.

Home keeps one link at the deposit step to the share-backed deposit, which is operated in **Money → Shares & loans**.
That section also holds the collapsed collateral calculator (150% initial collateral, a 125% example maintenance
level and an approved claim sale with illustrative slippage). `CollateralEscrow` runs on Robinhood Chain testnet as a separate workflow, not as a way to pay this tenancy's Solana deposit.

## Architecture

- `src/server/listings.ts`: listings, applications and the choice that creates the agreement.
- `src/server/solana-tenancies.ts`: every agreement gets its own tenancy PDA inside the one reviewed deployment pinned in `SOLANA_DEPLOYMENT_MANIFEST`. There are no per-tenancy environment edits. Existing routes accept `?agreement=<id>`.
- `src/server/journey.ts`: `agreementStep` and `chainStep` compute the next step from the agreement and finalized chain state. `GET /api/journey` returns it for every tenancy the person belongs to. `POST /api/journey {action: "advance"}` runs sponsor payouts.
- Bundled actions (`solana-service.ts`) sign a fixed instruction sequence. Reconciliation checks the final nonce, the end phase and the net token effects.

## Requirements before the passkey run

- `SOLANA_DEPLOYMENT_MANIFEST` must point at the pull-v2 deployment ([evidence](evidence/SOLANA_PULL_DEVNET_DEPLOYMENT_2026-09-25.json)); settlement bundles require it.
- Each person needs a passkey, backup email and a Solana wallet, plus the one-time recovery check in Me → Account settings. The Home setup action opens those controls directly when needed.
- The tenant needs test USDC in their wallet (Circle faucet). Payout token accounts are created automatically by the sponsor right before the landlord creates the deposit space.
- The public devnet RPC rate-limits. The gateway backs off on HTTP 429, but a keyed devnet RPC is recommended for a smoother test-network rehearsal.

## Portfolio

Money shows **Your portfolio**: the person's `tSPYx` holding (the devnet Token-2022 copy of SPYx, no value), its value at the live mainnet SPYx price, distributions so far (the scaled-UI multiplier), and available test USDC. **Invest 5 test USDC** is one approval: an atomic transaction co-signed by the test market maker, which pays the fee. Devnet lending pays no interest, so the purchase uses the person's own test USDC rather than released deposit earnings. It needs `SOLANA_TEST_SIGNER_MODE=1` and the local test market (`scripts/solana-test-market.mjs setup`).

## Test helpers: one real account is enough, where they exist

Home has a collapsible **Test tools** panel only where operator test actions are allowed: `SOLANA_TEST_SIGNER_MODE=1`, the local store (no `DATABASE_URL`) and devnet or localnet, never on Vercel. The gate is the environment, not the request hostname. On a hosted build the panel is absent, and one account can post a home or apply to one but cannot complete a tenancy: it needs a landlord, a tenant and an arbitrator, each with their own account. Home says so, and shows the walkthrough. Where the panel exists it offers:

- **Add sample homes**, then **Let the test landlord choose** after you apply.
- **Add a test applicant** to your own listing.
- **Use the test arbitrator instead** of sending an invite link.
- **Let the test party do their step** while waiting.
- **Test landlord starts move-out** explicitly while the tenant is living in an active test tenancy; this lets a single test account advance the devnet workflow. Do not click it until ready to advance the devnet tenancy.

The test tools use operator-held test keys through the same services. You need **one** real account (passkey, backup email; the recovery proof before the first wallet action) whose signatures are the ones that matter. Helper steps are fixtures, not wallet proof.

## Verified

A test-key run on devnet went through the real services: listing → application → choice → arbitrator invite → acceptance → setup → deposit → claim → dispute → arbitrator decision → two sponsor payouts (tenant 4.5, landlord 0.5, escrow empty). At every phase exactly one person had an action. This is not passkey evidence; the passkey run is still open.
