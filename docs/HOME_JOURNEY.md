# Home: the signed-in journey

**Home** is the real, passkey-signed flow on the Solana test network (test USDC only).

## Lean screen contract · 2026-10-03

Navigation is Home · Money · Places · Me, with Roadmap secondary. The brand and error recovery links return to Home. There is no top-bar breadcrumb; account, sign-out and the global test-network chip remain. Each screen uses one bottom honesty line; item-specific Illustration, Prototype and simulated labels stay with their items. Deposit earnings belong to the tenant (§551 BGB); no legal advice. Mobile heroes are at most 230 px tall and controls have 44 px tap targets.

## Onboarding

Account setup starts directly, without picking a global role. A person can **Find a home** to apply, **Rent out a home** to post a listing, or join a tenancy through a private invitation; roles in tenancies come from recorded agreement parties, not account setup. Setup walks through two steps with live status:

1. Create an account with a passkey.
2. Create the two wallets (automatic).

Tenancy actions need a verified passkey and the appropriate owned wallet, not an email or a second-browser recovery proof. A second passkey on another device is recommended in Me, not required. Losing every passkey means losing the test account; nothing here has monetary value ([ADR 0014](adr/0014-passkey-only-test-accounts.md)).

Home is the default signed-in screen at `/`; Today is removed. Its page heading is an h1 only. Invitations, applicant review and application status come first when relevant. The current tenancy follows as one Hero: the fictional Neighbourhood Homes 3D map where applicable (other flats use their flat map), the home name, one status sentence and 2–4 plain-language figures. Living tenants see Deposit, Earned for you, Rent this month and To the house. Landlords have two figures: Deposit held and Rent this month received; the rent note includes the house's 20 % share and next payment date, not a separate Next rent figure. Arbitrators see the deposit and any deduction. Setup shows the required deposit and rent; setup and move-out have a compact checked phase line (“Find · Apply · Agree · Secure · Live”, with the current phase highlighted and later phases through Paid out during move-out). There is no step counter while living. An ActionBox holds the step that needs this person, with exact reviews and blockers unchanged.

About this tenancy is a full-width row list directly below the Hero, not inside it. Rent & receipts, Move-in handover (including the landlord’s registration print), Service charges · example, Moving out, and Agreement & activity are labelled MoreRows, closed by default and mounted on first open. An arbitrator sees only Agreement & activity while nothing needs them. Row meta text says what is inside and its state, such as “Confirmed by both” or “October paid”. Rent has one fetch/poll loop: its status feeds the figure, due/in-progress payment is the ActionBox, and history lives in the rent row. Other tenancies are rows, open when they need this person. Neighbourhood belongs to Places, not Home. Newcomers see Find a home and the listing browser; deposit options sit behind How the deposit works. Browse other homes, Rent out a home and your listings, Past homes and enabled local rehearsal tools form the final MoreList.

“Choose the deposit when publishing” opens the publishing form. The landlord's deposit-earnings note says “belongs to the tenant”.

## Flow
The path remains **Find → Apply → Agree → Secure → Live → Move out → Paid out**. At publish the landlord chooses **cash** (site tUSDC, Solana) or **shares** (official test TSLA, Robinhood Chain testnet 46630). Applicants and the distinct invited arbitrator need the matching verified wallet. The following legacy cash flow stays unchanged; share settlement is described below.

New publications enforce the §551(1) BGB three-month net cold rent cap on the server and in the form: cash security may be at most **3 × monthly cold rent**, while share-backed USD security may be at most **2 × monthly cold rent**, because 150% share cover reaches three months. The form prefills the maximum when changing deposit form and tracks rent changes until a custom deposit is entered; rent and security are compared exactly in six-decimal test-dollar atomic units, not TSLA quantities. Existing listings and agreements are unchanged. Not legal advice; test networks only, with no statement that token escrow meets legal requirements.


1. **Homes.** A landlord posts a home: title, monthly rent, deposit amount and earnings policy (no photo is preselected). Signed-in people apply with a short note; applicants never see each other. An applicant may withdraw while the listing is open, and the landlord may close a listing before choosing. Choosing one applicant cannot be undone: it creates the agreement with landlord and tenant already bound, and Home asks for confirmation first. Once a tenant is chosen there is no cancel.
2. **Agreement.** The landlord invites a neutral arbitrator with a one-time private link, valid once for 24 hours. Making a new link stops the old one, and Home says so before it does. The link is kept on the landlord's device (`ledger-of-life:invite:v1:<account>:<agreement>`) so a reload does not lose it. The invited person sees the home's name and the deposit at stake before joining (`preview`, gated by the one-time token), and "Not now" records nothing. Tenant and landlord then accept the same terms: the home, the deposit and who keeps earnings. The terms do not cover rent or dates.
3. **Deposit space.** The landlord approves once to create the empty escrow for those terms.
4. **Deposit.** The tenant approves once. Site-minted tUSDC stays as cash in the home's escrow, with separately labelled simulated yield. Older Circle devnet USDC agreements lock and supply the deposit to Kamino lending in the same transaction (`fund_and_supply`).
5. **Living here / move-out.** The current tenancy leads with its status and figures, not a step counter. The existing move-out deduction form stays reachable through its labelled row, with the same required reason and deposit maximum. The tenant sees the landlord’s reason and split before agreeing and settling in one approval (`accept_and_settle`), or disputes. On a dispute, the arbitrator decides and settles in one approval (`resolve_and_settle`). Signing reviews, blockers, confirmations, polling and receipts are unchanged.
6. **Paid out.** No approval is needed. The fee sponsor sends each side's payout to its own account, one transaction per side. Completed tenancies appear under **Past homes**.

Setup and move-out show a compact checked phase line, while living shows no step counter. Each person sees exactly **one** next step when action is required. A tenant deciding on a deduction sees the landlord's reason and the split before agreeing; an arbitrator sees both reasons, the range from 0 to the claim and the split. Waiting steps show their explanation and “Nothing notifies them: tell them yourself.” An always-mounted `TenancyAutomation`, one per active tenancy while Home is open and independent of closed detail rows, advances cash payouts immediately and then every 15 seconds; cash network confirmations reconcile every 4 seconds. Thus “retried every 15 seconds while Home is open” remains accurate for cash payouts, which do not run otherwise. A confirmation that takes more than 90 seconds offers **Check again**. Across the whole tenancy the three people approve 4 transactions without a dispute and 5 with one, instead of the previous 7–8.

If Journey or Listings cannot be read, Home keeps whatever loaded, names what failed and offers **Retry**; it never says "Find a place to call home" when the tenancy reading failed. After three failed background polls it says updates are paused.

Monthly fictional-building rent is separate from the deposit. The tenant selects **Pay transfer N** to show the exact amount, recipient, token, chain and transaction inline, then **Sign and send transfer N** to approve and submit. Reviews last two minutes. The landlord remainder goes first; once it confirms, the fixed 20% building-share review appears automatically. An expired review rejected with 409 clears unpersisted client approval and prepares a fresh review; it never signs again automatically. Ambiguous submissions retain approved bytes and offer **Retry the same signed transfer**, including persisted approvals after reload. The server persists signed bytes before sending and refuses a second payment for the same Berlin calendar month. Landlords only read rent status and receipts.

When the current Berlin month's rent is confirmed, the closed rent row says **Rent for Month YYYY paid** (tenant) or **received** (landlord). Opening it shows the split, both receipts and when the next month can be paid. Exact token units and recipients remain in payment history; due/in-progress transfers retain their exact signing reviews. **Refresh** is a small text action. Money alone owns personal holdings and local stakes. Fictional units have no value or rights.

While living, tenants and landlords have a labelled **Service charges · example** row; opening it reveals the prototype’s simulated prepayment, costs and balance. It is hidden for arbitrators. The landlord can edit the server-stored monthly test prepayment. Example annual building costs use m², units and consumption keys, and a daily Home Assistant consumption sensor is read when present. Without one, a labelled example week is used. The balance and projected surplus are calculations only: no escrow prepayment or release exists.

## Share-backed tenancy

`ShareDepositFactory` creates an escrow for the accepted `rental-agreement-v2` terms; previous agreements retain their byte-identical v1 digest. The USD deposit, official stock/feed/factory, 150% activation ratio, 125% app-only warning, and response/return/arbitration windows are committed to acceptance. Defaults are 7/7/30 days; each window is fixed at creation. Before Apply the quote says how many test TSLA are needed and how many the verified tenant wallet holds; Robinhood’s faucet gives five per claim. Gas comes from the existing drip or the official faucet.

The landlord signs creation; the tenant signs an exact finite approval then pledge. At least 150% fresh-price cover activates the deposit. Extra withdrawals preserve 150%; below 125% Home shows the top-up request with an action tone and opens the share row, with no on-chain enforcement, forced sale or DEX. Shares locked here are never spendable wallet shares or loan collateral. Cash simulated yield is unchanged; shares pay no yield.

Share move-out opens its row with the agreed deadlines and “Silence is not consent”. A landlord proposal commits the move-out evidence hash and USD amount and converts it once (rounded up, capped at custody) to shares. Acceptance, contest, lowering, arbitration and payout are price-free. Expired response permits escalation, not an award. The tenant may request return; after the return window anyone can close unclaimed. After the fixed arbitration window anyone can close unresolved and return the deposit to the tenant. Each payout side has a fixed recipient, landlord priority up to its award and tenant the remainder; an issuer-blocked recipient need not block the other side. Closed is not Paid out until actual custody is empty.

The server verifies factory/implementation/dependency pins and complete escrow read-back before preparing calls, and issuer beacon, implementation, registry, code hashes, pause and party/escrow blocks before creation or inflow. Issuer powers to pause, block, burn or upgrade remain external risks, including on exits. Missing/null deployment means “Share deposit not deployed yet”, without signing actions. Quotes show source and copy times and the existing price-job health. Stale prices suppress coverage/valuation, not price-free exits. Test tokens have no monetary value; no legal advice. Proven on this site on 1 October 2026 with three fresh passkey accounts through all seven steps ([evidence](evidence/HOSTED_SHARE_DEPOSIT_ROBINHOOD_TESTNET_2026-10-01.json)); the timeout exits were not run on the hosted site and are contract-tested only.


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

Home has a collapsible **Local rehearsal tools · needs a local setup** panel only where operator test actions are allowed: `SOLANA_TEST_SIGNER_MODE=1`, the local store (no `DATABASE_URL`) and devnet or localnet, never on Vercel. The gate is the environment, not the request hostname. On a hosted build the panel is absent, and completing a tenancy needs a landlord, a tenant and an arbitrator, each with their own account. Required actions and waiting states explain the next step in the relevant card; there is no separate walkthrough. Where the panel exists it offers:

- **Add sample homes**, then **Let the test landlord choose** after you apply.
- **Add a test applicant** to your own listing.
- **Use the test arbitrator instead** of sending an invite link.
- **Let the test party do their step** while waiting.
- **Test landlord starts move-out** explicitly while the tenant is living in an active test tenancy; this lets a single test account advance the devnet workflow. Do not click it until ready to advance the devnet tenancy.

The test tools use operator-held test keys through the same services. You need **one** real passkey account whose signatures are the ones that matter. Helper steps are fixtures, not wallet proof.

## Verified

A test-key run on devnet went through the real services: listing → application → choice → arbitrator invite → acceptance → setup → deposit → claim → dispute → arbitrator decision → two sponsor payouts (tenant 4.5, landlord 0.5, escrow empty). At every phase exactly one person had an action. This is not passkey evidence; the passkey run is still open.

## What changed on 2026-10-02

- Home now puts the person's invitation, applicants, tenancy or application first instead of a generic journey scaffold. Listings are for people browsing homes; housing actions, handover and simulated service-charge figures are visible where relevant, with agreement records as fine print. The repeated walkthrough was removed, deposit options are compact, and flat maps initialize only when visible, using the supplied catalogue city centre or the home's approximate pin.
- Every application and listing awaiting applicant review remains reachable, including rejected applications. An unavailable tenancy reading never turns the person into a newcomer or repeats their chosen listing. Browsing is opt-in again on each Home visit; publishing links open the publishing form. A tenant’s own home keeps its full actions even alongside a let property, and confirmed-funding yield remains visible through move-out and payout. Past homes retain payout amounts and cancellation details.
