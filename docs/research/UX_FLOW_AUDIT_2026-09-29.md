# UX and flow audit · 29 September 2026

**Method.** Six read-only reviewers read the code, the CSS and the published data, one slice each: first run with Today, Me and Ideas; Home (the rental journey); Money; Places; the shared shell and styles; and the two-chain question. Nothing was run against a live Privy session, no chain was read, and nobody clicked the flows through as a second person. Line numbers are the reviewers'. Five claims that carry the ranking were re-checked against the code and hold: the recovery skip is ignored in production (`recovery.ts:177`, `configuration.ts:4`); test tools are off with a database or on Vercel (`test-capability.ts:6`, `test-signer.ts:27`); the TSLA buy spends the whole balance (`robinhood-demo.ts:192`); no error boundary exists; no `pushState` exists. Seen in a browser the same day: the setup wizard, Today with the getting-started guide, the Me adapter directory. Contrast ratios are computed by hand.

The [27 September audit](LEDGER_APP_AUDIT_2026-09-27.md) was re-checked. Its main items are fixed (mobile navigation, "More to build", raw review words, partial totals, duplicated finance). What remains from it is folded in below.

## The problems that matter most

Ranked by what would stop a judge, landlord, tenant or arbitrator. Size: S = hours, M = a day, L = days. "Owner" means it needs your decision first.

| # | Problem | What a person meets | Evidence | Size |
|---|---|---|---|---|
| 1 | **The front door needs a second browser and hides the whole product behind it.** | "Four quick steps" ends with "open a different browser, choose Continue with email, approve two signatures". Until then every area, including public Places and Ideas, shows only the wizard. The skip flag is ignored in production builds. A returning person sees the sign-up wizard flash on every load; there is no "welcome back". | `home.tsx:73-78`, `onboarding.tsx:92-134` | M · Owner |
| 2 | **One person cannot complete, or even preview, the Home journey on a hosted build.** | Alone, a person can post a listing and nothing else. The sample home, test applicant, test landlord, test arbitrator and simulated interest live in Test tools, which switch off with a database or on Vercel. The journey needs three accounts. | `home.tsx:228,790-816` | S for an honest empty state · L for a hosted demo mode · Owner |
| 3 | **Money can strand the demo wallet.** | "Invest in TSLA" spends the whole test-USD balance in one click. Pressed before the share market exists, it blocks pledge and borrow for that wallet for good. With no funds a person sees $0.00 and no route to funds: the faucet link is only in Home, the earn button only in Test tools. | `assets.tsx:250`, `ownership-demo.ts:31`, `share-workflows.ts:107` | S to M |
| 4 | **The arbitrator hand-off is fragile.** | Acceptance is impossible until an arbitrator joins. The invite link lives only in component state (lost on reload). Pressing the button again kills a link already sent. The landlord's card does not refresh when the arbitrator joins. The link uses the localhost origin. The invitee meets the whole wizard first, with no word about the invitation. | `home.tsx:264,329`, `agreements.ts:121-146`, `journey.ts:62` | S to M |
| 5 | **Test values look like real money.** | Dollar figures without "test" (the subtotal, fixed today). A deposit "earning in lending" although devnet lending pays 0. A real mainnet validator stake on a page of test tokens. Local stakes drops "fictional" and says "invest". Places calls the fictional project "proposed" beside a real planning area. | `journey.ts:90,99`, `local-investments.tsx:172-217`, `civic-place-lenses.tsx:345` | S |
| 6 | **One failed read tells a false story, and a render error blanks the app.** | If `/api/journey` or `/api/listings` fails once, Home says "Find a place to call home" even with a locked deposit and Money says "Reading your tenancies…" forever, with no retry. There is no error boundary. | `home.tsx:93-114,157`, `money-area.tsx:37` | S to M |
| 7 | **Irreversible money steps are taken without the numbers.** | The tenant agrees to a deduction without seeing its reason or the split. The arbitrator decides without either argument. Pledge, borrow and repay sign on the first click. Loan health is a bare "40.00×". "Share-backed deposit" says to agree a flat in Home but pledges into a separate operator-run test tenancy. | `home.tsx:388-410`, `share-workflows.tsx:202,238-250`, `share-workflows.ts:420` | M |
| 8 | **Nobody is told anything; stalled counterparts have no exit; spinners can hang.** | No notification of any kind. Applicant, landlord, tenant and arbitrator wait on stale screens. No cancel, withdraw or timeout. "Confirming…" and "Paying out…" can spin forever, and payouts only run while a party's browser is open. | `home.tsx:37,119-127,271-276`, `listings.ts:193` | S for copy · M to L for behaviour · Owner |
| 9 | **Places opens on Strausberg, and choosing a city is a trap.** | Every city gets three Strausberg story buttons, one a fictional project. The city input is pre-filled "Strausberg" and accepts any text ("asdf" ticks the guide step). The eight-city list only explores. "Explore & follow projects" lands on a closed box that lists motorway segments for seven of eight cities. "Where can I have a say?" is never answered although open consultations are computed. | `civic-place-lenses.tsx:311-315`, `city.tsx:11,43`, `city.ts:75` | M |
| 10 | **The shell forgets everything.** | Back leaves the app. Switching area resets the area: Money returns to Holdings and drafts vanish. "Since your last visit" is emptied by rendering. The tab title never changes. There is no account indicator, and sign-out sits inside a closed disclosure in Me. | `workspace.tsx:10-15`, `today.tsx:64-84`, `me.tsx:86` | M |

Serious, but narrower:

- **Accessibility.** The default focus ring is 1.65:1 (3:1 needed). The default paragraph grey is 3.8 to 4.1:1 (4.5 needed) and 2.3:1 inside Today's news card. The caveats that keep test values honest are among the lowest-contrast text in the app. Reality chip meanings are tooltips only, unreachable on touch. (`globals.css:768,815,2642`, `reality-chip.tsx:9`)
- **Load.** About 13 authenticated requests on entering Money and about 9 a minute after. Hidden Money tabs keep polling and nothing pauses in a background tab. Places fetches Köln's 6 MB file three times per open. (`assets.tsx:66`, `use-city-signals.ts`)
- **Design system.** Ten colour tokens against about 240 hex-coloured lines outside them, eight competing greens, six button families plus an unstyled `secondary-button` used by 11 buttons (including "Show my city"). About 91% of `globals.css` belongs to a previous design. `home.tsx` is 821 lines.
- **Home honesty gaps.** The agreement digest covers only title, deposit, a flag and three wallets. The tenancy card never names the other party or the arbitrator. A landlord or arbitrator sees "$0.00 · No active deposit". The last step has no receipt, and the hero says "agreement next" after payout.

## Fixed while auditing

Today's subtotal says "test-asset" and carries a reality chip. The "Free to use" legend no longer says "spend or trade" (nothing can be sold or cashed out). The "Pledged" legend says "repay the loan or end the deposit". The Home Assistant form says the token is not limited to reading and the host can use it. Breakdown bars scale to the whole held, not the largest part. The debt bar is solid, so hatching stays free to mean "simulated".

## Status after three rounds of fixes (29 September)

Checked in a browser on the integrated app with a fresh virtual-passkey account: every area loads with no console error and no failed request, nothing overflows at 390 px, the URL, tab title, Back and Forward follow the area, and the Places sheet stays clear of the Outcomes and Connections panels (measured while scrolled into each). Not checked with a real funded wallet, a real second browser, a real Privy cancel or a live devnet tenancy: those flows are covered by types and unit tests only.

| # | Problem | Status |
|---|---|---|
| 1 | Front door | **Fixed** ([ADR 0011](../adr/0011-ask-for-recovery-at-the-first-wallet-action.md)). Setup ends after the two wallets; a returning person sees "Checking your sign-in…", not the welcome steps. |
| 2 | Home for one person | **Partly.** Home says a tenancy needs three accounts and walks through the steps. A one-person hosted journey (labelled demo parties or seeded accounts) is not built; it needs the hosting decision. |
| 3 | Money can strand the wallet | **Fixed in code, unverified funded.** The TSLA buy takes an amount and a review; a "Get test funds" card names both wallets, the faucet and where test USD comes from; disabled controls say why; Money says once that nothing can be sold. |
| 4 | Arbitrator hand-off | **Mostly.** The link survives a reload, says how long it lives and warns before a new link replaces it; the landlord's card refreshes; the invited person sees the home and deposit first and can decline. Still: the link uses the current origin, so it only works on the same web address, until hosting is decided. |
| 5 | Test values look real | **Fixed.** "Test" beside every dollar figure, simulated deposit earnings, the validator labelled public mainnet data, "fictional test issuer" and "fictional test project" restored, journey copy says test USDC. |
| 6 | A failed read tells a false story | **Fixed.** Home reads the journey and the listings independently, names what failed and offers Retry; Money shows the same error; an error boundary keeps the shell alive. |
| 7 | Irreversible steps without the numbers | **Fixed.** Claims and decisions show reasons, limits and the split; loans show rate, limit, liquidation rule and price-fall distance with a review step; the share-backed deposit says it is separate from the Home tenancy. |
| 8 | Nobody notified, stalled counterparts | **Partly.** Home says nothing notifies anyone, polls listings, offers close and withdraw before a tenant is chosen, "Check again" after 90 seconds and payout retries while Home is open. **Not possible without a program change:** cancelling after a tenant is chosen, replacing an absent arbitrator, or a dispute timeout. |
| 9 | Places | **Fixed.** Eight-city picker, dated "what is changing" block answering "where can I have a say?", Strausberg stories only for Strausberg, snapshot age on the page, a project list without motorways, one shared city download. |
| 10 | The shell forgets | **Mostly.** Area and Money tab in the URL, per-area title, focus and announcement, account label with Sign out, "since your last visit" kept until marked seen. Still: leaving an area drops its unsaved state (a Money amount, a Local AI draft). |

Also done: contrast (focus ring 1.65:1 → 7.6:1, muted text 3.8:1 → 5.4:1), the unstyled `secondary-button`, chip meanings as text, Money polling that pauses on hidden tabs, and the holdings subtotal no longer waiting on Home Assistant or the validator. Not done from the audit: the design-system consolidation (eight greens, six button families, 91% dead CSS), splitting `home.tsx`, and de-duplicating the holdings, portfolio and ownership reads.

## Where a picture would beat the text

Every picture needs a reality chip. Proposed rule for the whole app: **hatched = simulated**, **dashed outline = planned or roadmap**, **solid = observed**. Nothing else uses hatching.

| Screen | Picture | Replaces | Must not mislead |
|---|---|---|---|
| Home, tenancy | Three-lane timeline (tenant, landlord, arbitrator) with "your move / their move / waiting for the network" | Two progress lines and the "Waiting for…" paragraphs | Waiting time is not an SLA; no reminder is sent; fixture parties must not look like people |
| Home, tenancy | Deposit split: deposit → landlord deduction, tenant remainder, with earnings hatched | The earnings paragraph; the arbitrator's bare number field | A preview must not look like a payout; simulated interest is not principal |
| Home, listings | Compact rows: thumbnail, city, rent, deposit | Cards of 550 to 650 px each | Stock photos and fixture homes marked "sample" |
| Money, shares & loans | Loan-health ruler: borrowing room, no new borrowing, others may take shares at a 10% discount; marker for now | "Loan-to-value 2%" and "Health 40.00×" | A green zone reads as safe; the price is operator-set and simulated |
| Money, holdings | The breakdown (built) plus a second view by how real each dollar is | The paragraph under the subtotal | A bar of dollars invites reading wealth; keep "test" on the axis |
| Money | Two lanes, "Solana devnet wallet" and "Robinhood Chain testnet wallet", one name per token, a wall marked "no bridge" | Small print about separate networks | Arrows across the wall imply conversion |
| Money | One dated activity timeline with chain badge, amount, status, explorer link | The five raw rows and the hash in a disclosure | Created is not finished; prepared and expired must not look done |
| Places | Dated "what's coming" strip for the chosen city with a snapshot stamp and closed items greyed | Closed lists and the missing "have a say" answer | End dates are not deadlines; motorway segments 25 km out must be filtered |
| Places | Plan versus actual budget bars, with an explicit empty "actual: not published" | The meter that scales 2026 against 2025 | An empty bar reads as €0; years are not like-for-like |
| Places | Eight-city coverage grid that is also the city chooser | The free-text box and the explore dropdown | "Covered" is not complete; uncovered towns are not "coming" |
| Me | Who can see what: rows = your data, columns = you, counterparties, arbitrator, host, public chain | Twelve paragraphs of "who can see it" | The host can read and use the Home Assistant token; do not flatten that into a tick |
| First run | Two lanes for the recovery hand-off: "this browser" and "other browser" | The four-step wizard's step 4 prose | Draw only what the server knows |
| Ideas | Capability × reality matrix | The button wall | Build status is not how real something is; never green-for-good |
| Devices | GPU host break-even, measured demand as the only solid point | The euro planner numbers | Assumptions dashed and labelled; euros and test tokens never share an axis |

Tufte's 1983 book gives five rules that carry over: show the data; erase ink that carries none (no legend when direct labels do); draw sizes in proportion to values on one scale; put a small table beside any chart of fewer than about twenty numbers; never let the picture say more than the data. Sparklines are from his later work, not the 1983 book. Datawrapper's free plan is a fast sketchpad for public-data charts (city budgets, roadworks); its embeds carry no cookies or trackers and are hosted in Frankfurt and Stockholm, but published charts live on its CDN, its waterfall type needs the $39 Business plan, and personal ledger data must never leave the app.

## Design rounds

The aim is to get from "I can't say it in words" to something nice by reacting to pictures instead of describing them. `/design` (development only) holds real components with invented numbers; each round adds options there.

1. **References (15 min).** Three products whose feel you like, one you don't, and one sentence each on what exactly: density, calm, colour, numbers. Screenshots or links.
2. **Screens (15 min).** Pick at most four for the demo. Suggested: first run and Today; Money → Holdings (breakdown built); the Home tenancy card; Places.
3. **Options, one screen per sitting.** Two or three variants each, in empty, typical and stressed states. Answer with letters and "more like, less like".
4. **Lock and build.** The chosen variant replaces the real component. Check the Tufte rules, the reality chip, the empty, loading, error and stale states, and 390 px. Then the next screen.
