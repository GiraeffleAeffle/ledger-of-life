# Home: the signed-in journey

**Home** is the real, passkey-signed flow on the Solana test network (test USDC only).

## Onboarding

Account setup starts directly, without picking a global role. A person can **Find a home** to apply, **Rent out a home** to post a listing, or join a tenancy through a private invitation; roles in tenancies come from recorded agreement parties, not account setup. Setup walks through two steps with live status:

1. Create an account with a passkey.
2. Create the two wallets (automatic).

Tenancy actions need a verified passkey and the appropriate owned wallet, not an email or a second-browser recovery proof. A second passkey on another device is recommended in Me, not required. Losing every passkey means losing the test account; nothing here has monetary value ([ADR 0014](adr/0014-passkey-only-test-accounts.md)).

After setup, Home shows a short walkthrough of the journey until the person has a tenancy (open when no test tools can play the other people), then the person's own tenancies and the listings. A tenant who needs test USDC for a deposit can use the Circle devnet faucet.

## Flow
The path remains **Find → Apply → Agree → Secure → Live → Move out → Paid out**. At publish the landlord chooses **cash** (site tUSDC, Solana) or **shares** (official test TSLA, Robinhood Chain testnet 46630). Applicants and the distinct invited arbitrator need the matching verified wallet. The following legacy cash flow stays unchanged; share settlement is described below.


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

## Share-backed tenancy

`ShareDepositFactory` creates an escrow for the accepted `rental-agreement-v2` terms; previous agreements retain their byte-identical v1 digest. The USD deposit, official stock/feed/factory, 150% activation ratio, 125% app-only warning, and response/return/arbitration windows are committed to acceptance. Defaults are 7/7/30 days; each window is fixed at creation. Before Apply the quote says how many test TSLA are needed and how many the verified tenant wallet holds; Robinhood’s faucet gives five per claim. Gas comes from the existing drip or the official faucet.

The landlord signs creation; the tenant signs an exact finite approval then pledge. At least 150% fresh-price cover activates the deposit. Extra withdrawals preserve 150%; below 125% Home requests a top-up, with no on-chain enforcement, forced sale or DEX. Shares locked here are never spendable wallet shares or loan collateral. Cash simulated yield is unchanged; shares pay no yield.

A landlord proposal commits the move-out evidence hash and USD amount and converts it once (rounded up, capped at custody) to shares. Acceptance, contest, lowering, arbitration and payout are price-free. Silence is never consent: expired response permits escalation, not an award. The tenant may request return; after the return window anyone can close unclaimed. After the fixed arbitration window anyone can close unresolved and return the deposit to the tenant. Each payout side has a fixed recipient, landlord priority up to its award and tenant the remainder; an issuer-blocked recipient need not block the other side. Closed is not Paid out until actual custody is empty.

The server verifies factory/implementation/dependency pins and complete escrow read-back before preparing calls, and issuer beacon, implementation, registry, code hashes, pause and party/escrow blocks before creation or inflow. Issuer powers to pause, block, burn or upgrade remain external risks, including on exits. Missing/null deployment means “Share deposit not deployed yet”, without signing actions. Quotes show source and copy times and the existing price-job health. Stale prices suppress coverage/valuation, not price-free exits. Test tokens have no monetary value; no legal advice. Hosted three-account proof remains pending.


## Architecture

- `src/server/listings.ts`: listings, applications and the choice that creates the agreement.
- `src/server/solana-tenancies.ts`: every agreement gets its own tenancy PDA inside the one reviewed deployment pinned in `SOLANA_DEPLOYMENT_MANIFEST`. There are no per-tenancy environment edits. Existing routes accept `?agreement=<id>`.
- `src/server/journey.ts`: `agreementStep` and `chainStep` compute the next step from the agreement and finalized chain state. `GET /api/journey` returns it for every tenancy the person belongs to. `POST /api/journey {action: "advance"}` runs sponsor payouts.
- Bundled actions (`solana-service.ts`) sign a fixed instruction sequence. Reconciliation checks the final nonce, the end phase and the net token effects.

## Requirements before the passkey run

- `SOLANA_DEPLOYMENT_MANIFEST` must point at the pull-v2 deployment ([evidence](evidence/SOLANA_PULL_DEVNET_DEPLOYMENT_2026-09-25.json)); settlement bundles require it.
- Each person needs a passkey and a Solana wallet. No email or recovery ceremony is required.
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

The test tools use operator-held test keys through the same services. You need **one** real passkey account whose signatures are the ones that matter. Helper steps are fixtures, not wallet proof.

## Verified

A test-key run on devnet went through the real services: listing → application → choice → arbitrator invite → acceptance → setup → deposit → claim → dispute → arbitrator decision → two sponsor payouts (tenant 4.5, landlord 0.5, escrow empty). At every phase exactly one person had an action. This is not passkey evidence; the passkey run is still open.
