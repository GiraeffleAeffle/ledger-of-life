# Information architecture: where a feature lives

Status: 2026-10-03. This page owns the placement rule and the order in which a person meets things. [`LEDGER_OF_LIFE.md`](LEDGER_OF_LIFE.md) describes what each area contains, [`ontology.yaml`](ontology.yaml) defines the concepts, [`src/data/sections.ts`](../src/data/sections.ts) lists every jump target and its one owning area, [`src/data/ledger-catalogue.ts`](../src/data/ledger-catalogue.ts) holds the topics, capability status and each capability's single destination, and [`src/data/path.ts`](../src/data/path.ts) holds the public thread and its four stages.

## The rule

1. **Each area answers one question.** If something does not help answer it, it belongs elsewhere.
2. **A feature has one home**: one area, and inside it one section. The home is where the person *operates* it (buys, connects, signs, reads its live value).
3. **Every other place shows a reference**: at most one line of status and one link to the home. A reference never repeats a control, a calculator or a promotional card.
4. **Topics are subject matter; areas are places to operate.** The five catalogue topics organise the Me directory and Roadmap. Energy & devices is operated in Money. Home shares are bought as fictional units in Money → Local stakes, not operated in Home.
5. **Rental security and personal money never share a card** ([ADR 0001](adr/0001-separate-rental-security-and-personal-portfolio.md), [`CONTEXT.md`](../CONTEXT.md)).
6. **Status first, facts once.** Each screen has at most one Hero, one status line, 2–4 figures and one primary action. Everything else is a labelled MoreRow, closed by default and mounted on first open, or removed. Specific honesty labels stay with their items; the global test-network chip avoids repeated disclaimers.
7. **Plain headings.** An area has an h1 only, without eyebrow or subtitle. The top bar has no breadcrumb and retains account, sign-out and the test-network chip.

Current screen contract: Home’s tenancy Hero answers “Is my home OK?”. Money answers “What do I own?”, and Places “What is happening in my city?”. At 390 px there is no horizontal overflow, tap targets are at least 44 px and hero pictures are at most 230 px tall. A single ScreenNote ends each screen with its applicable conservative legal and honesty wording. Historical change notes below describe earlier layouts, not the current navigation.

## The thread and the next step

The public door retains the thread **Find a home, secure the deposit, keep your assets, help build your city** (`THREAD` in `src/data/path.ts`). Its stages explain the product there; they are not counters or eyebrows on signed-in screens.

| # | Stage | Operated in | Counts as done |
|---|---|---|---|
| 1 | Find a home | Home | a listing, an application or a tenancy exists |
| 2 | Secure the deposit | Home (tenancy card) | a deposit is locked (living or later) |
| 3 | Keep your assets | Money | never done; a status (free, locked, pledged, lent, owed) |
| 4 | Help build your city | Places (local stakes and the AI desk are operated in Money) | a city is known |

- **One next step** (`src/components/next-step.ts`, `next-step-card.tsx`). Existing invitation, tenancy, applicant, waiting and read-failure precedence stays intact. Home owns the action; other areas show only urgent reminders linking back. Failed or pending reads never imply done or empty.
- **Home replaces Today.** `/` opens Home. The brand and error recovery return there; the overview area and four-row path strip are removed.
- **Navigation:** Home · Money · Places · Me; Roadmap is secondary. URL-derived areas and tab ids, browser history, account state, invitation hashes and section navigation remain stable.
- **What is real here** lives in one place: the "Test networks · no real money" chip opens the global explainer with availability labels and every reality-level meaning from `src/data/reality.ts`. Individual reality chips label data without repeating that disclosure.
- **Ways to hold the deposit** (Home, `deposit-options`) answers the deposit choice: cash tUSDC on Solana retains labelled site-paid simulated yield; share-backed deposits use official test TSLA on Robinhood testnet with no yield. The landlord selects one form at publish; applicants and arbitrator need the matching verified wallet. The share deposit is deployed and available on this site; it was proven on this site on 1 October 2026 with three fresh passkey accounts ([evidence](evidence/HOSTED_SHARE_DEPOSIT_ROBINHOOD_TESTNET_2026-10-01.json)). Missing reviewed deployment disables signing. Loan collateral is a separate Money workflow, never a replacement custody bucket.
- **Share signing boundary:** every review includes the eight accepted escrow terms. The wallet derives the CREATE2 address from those terms and the bundled factory/implementation pins, checks the signing party, and permits only enumerated escrow calls or exact, capped TSLA approval to that derived address. Failed receipts are terminal, not permanent pending blockers. Cash holdings/yield copy excludes share custody; past share tenancies show TSLA payout receipts.

## The five areas

In navigation order; the Roadmap is reached from the sidebar foot rather than the main navigation.

| Area | The one question | Operated here | Not operated here (link instead) |
|---|---|---|---|
| **Home** | Is my home OK? | Listings with approximate OSM pins, application, agreement, deposit, document-free move-in handover, browser-only registration confirmation, service charges, move-out, payouts | Shares, loans, stakes, device readings (Money); neighbourhood and full public project exploration (Places), welcome guide and public AI desk (separate public routes) |
| **Money** | Your test holdings, collateral, loans and recorded activity | Holdings, shared official-stock loans and lender positions, local stakes, devices that earn | The rental itself (Home), connection settings (Me), public projects (Places) |
| **Places** | What is happening in my city? | Header with city, Get settled, weather reading and Change city; one visit-change line (“Nothing new since your last visit.” when unchanged), one layer-chip row and map with 3D/2D switch; one row list for Map settings, Project outcomes & connections, Weather & air; Have your say (Open consultations, Followed projects, Browse projects), Events & news, Who does what, Nearby towns and Council | Anything with a personal balance. Fictional project markers are illustrations; buying is in Money |
| **Me** | Your access, private history and connections | Compact Sign-in & wallets (Deposit wallet on Solana, Shares wallet on Robinhood Chain), private Life timeline with earlier places on demand and a plain-caption note; individual connection rows only for EU identity wallet, Home solar (Home Assistant) and Validator activity; automatic sources in Built into your account (13), meta “Included with your account” or “N need you”; future sources in Planned connections (3). View reading appears only for configured connections | Readings and income from those connections (Money), the tenancy (Home) |
| **Roadmap** (id `ideas`) | What is built, what is a prototype, and what is planned? | Nothing. Every capability grouped by availability, with one link to where it works | — |

## Money has four sections

Money has four tabs: **Holdings · Borrow & lend · Local stakes · Devices & income**. Tab ids and URLs remain unchanged. There are no tab summary lines or chips. Panels retain workflow state, and section jumps select the tab and open any labelled row first.

Holdings owns the priced breakdown; there is no Today subtotal. If the total is unavailable, one status sentence replaces its figure, bar and legend. Get test money lists four plain needs with one action each. Money amounts use a "$" prefix and two decimals app-wide (for example, "$1,300.00"); token amounts keep their symbol. Funding and purchase controls reuse coherent holdings reads. Locked deposits wait for tenancy records. Exact money reviews keep network names, quantities, addresses, expiry handling, blockers, confirmations and receipts.

Me shows the passkey count with Add another, short wallet addresses with Copy and one sentence on who signs what. Its private Life timeline opens earlier places on demand; connection controls live inside grouped state rows. Device readings stay in Money → Devices & income, with Your devices rows, a compact Ask the city AI panel (Paid/Free and Options) and a hardware-economics row. Local stakes uses a House / Workshop / Agri-PV picker, one Hero and labelled detail rows, including for people with remaining earnings or action receipts after unstaking. Roadmap offers the deposit-options link only when Home renders that target; other people open their existing Home instead.

| Section | Jump target | What it is for | Reality |
|---|---|---|---|
| **Holdings** | `money-holdings` | Deposit entitlement, wallet shares/cash, lent value, debt and priced subtotal | Test network · mirrored live token price with provenance |
| **Borrow & lend** | `money-shares` | Loan and lending cards, one wallet line and one price line; no task panel until an action is picked, then one focused panel with exact reviews; advanced rows for prices/pool and paginated unsafe-loan liquidation. Wallet reads do not scan the registry. Share rental deposits are operated in Home | Test network · deployment required · borrower-funded interest |
| **Local stakes** | `money-stakes` | House / Workshop / Agri-PV picker; a Hero with the fictional house's 3D map, holdings, claimable and house income; rows for buy/sell, stake/unstake, income sources and stream update, building toggles, sources and token rights. `tHOME` and `tWORK` are fictional units; Agri-PV is an illustrative calculator with editable assumptions, no token and no purchase | Test network · simulated input · fictional units have no value and no rights |
| **Devices & income** | `money-devices` | Things you run that produce value: add a device (Home Node download with checksum, pairing code, CLI or AI-assistant setup), then see each host's GPU state, earnings and receipts, solar power and local-day kWh pushed by the node, validator ids, and where each device's income goes: GPU income to “the building (tHOME stakers) since <date>” or “your wallet” (saved on the server until the owner changes it or removes the device; new devices can pay the building from pairing) and solar income to the building | Live · test network; solar income simulated |

Borrow appears on the loan card once collateral is posted and there is no debt. Exact debt
lives in details; Repay carries the close-the-loan hint. Lend and Withdraw show the lender-risk
line. The stake row contains exact staked and wallet tHOME quantities and Max buttons;
displayed units round down. Agri-PV's first view says “Illustrative calculation. Not a forecast,
offer, yield promise or investment advice.” Devices & income ends with one tab-level note:
test receipts, simulated solar feed-in, outside Holdings, and AI can be wrong.

With no city selected, Places says “Choose or preview a city first”; an uncovered city says
“not covered yet”. The header shows weather, not PM₂.₅; air readings are in Weather & air.
Pending followed-project updates appear in the status line.

## Where the ambiguous features live

| Feature | Home (area → section) | Configured in | Referenced from, and what the reference shows |
|---|---|---|---|
| Rented home: listing, agreement, deposit, move-out (a landlord or tenant can cancel the tenancy until the deposit is locked); optional monthly test rent (below) | Home | Me (wallet) | Urgent next-step reminders in other areas, Money → Holdings (deposit entitlement), Me (timeline) |
| Monthly test rent with a building share (landlord marks a new listing as a flat in the fictional Neighbourhood Homes building; both parties sign rent terms) | Home (inside a living tenancy) | Me (verified EVM wallet) | Money → Local stakes shows only an aggregated “Rent shares” total and count (no flat labels or rent receipt hashes); exact rent receipts stay with tenant and landlord. The deposit stays separate |
| Service charges | Home (inside a living tenancy) | Me (Home Assistant, for consumption) | Ideas, Me directory |
| Shared official-stock loan and lending | Money → Borrow & lend | Me (wallet); verified shared deployment and hosted mirror job | Ideas, Me directory; no fake landlord/desk setup |
| Share-backed rental deposit | Home (same seven steps as cash) | Me (verified EVM wallet); pinned share-deposit manifest | Money → Holdings (“locked in your deposit”), never spendable wallet balance or loan collateral |
| Stocks: tSPYx and official faucet test TSLA | Money → Holdings (wallet/lent positions) and Borrow & lend (loan collateral) | Me (wallet) | Wallet/collateral/deposit TSLA use one mirror with source/copy times and price-job health; stale price makes a complete priced total unavailable |
| **Tokenized local companies and housing** (`tHOME`, `tWORK` test units) | Money → Local stakes | Me (wallet) | Places (issuer markers, an illustration with a link to buy), Ideas, Me directory; devices paying the building are also listed publicly by name, kind and availability only |
| Home ownership path (home shares) | Ideas (roadmap). Its nearest working surface is Money → Local stakes | — | Me directory |
| **Solar**: readings your Home Node pushes (local setups may read Home Assistant directly) | Money → Devices & income | Me → Home Assistant (local only) | Home (service charges read the same sensor), Me directory |
| Solar and heat plans of a city (public evidence, for example Solarpark) | Places → project evidence | Me (chosen city) | Places project map |
| Validator stake and rewards | Money → Devices & income | Me → validator | Me directory |
| **GPU**: local AI node, per-answer payment, host income scenario | Money → Devices & income | Money → Devices & income → your paired hosts (any signed-in account with a verified EVM wallet, up to two; operators keep allowlisted hosts) | Places (library profile), Ideas, Me directory |
| Free public AI desk for visitors | `/library` (no account, separate route) | — | Money → Devices & income offers it as the library access mode |
| Newcomer welcome guide | `/welcome/<city>` (no account; a separate route, outside the wallet route group) | — | Places (a "New here? Welcome guide" link in the city card); its interests are Places' interests |
| Recorded hosted run (the 1 Oct three-account share-deposit tenancy as the seven Home steps with receipts, plus loan, stake and paid-answer receipts) | `/replay` (no account, no cookies; a separate route, outside the wallet route group) | — | The door and Home's deposit options link to it |
| Electric car and other devices | Ideas (roadmap) | — | Me directory (planned) |

## Deciding where something new goes

Ask in order; the first yes decides.

1. Is it who the person is, or a connection they configure? → **Me**. Only configuration lives there; the readings and income live where the person uses them.
2. Does its life cycle belong to a dwelling or tenancy (listing, agreement, deposit, service charges, move-out)? → **Home**.
3. Does it hold a balance, position or debt, or produce or spend money for the person? → **Money**, then pick the section: Holdings for balances and positions, Borrow & lend for collateral workflows, Local stakes for issuer units, Devices & income for things the person runs.
4. Is it public information about a place with no personal position? → **Places**.
5. Is it not built yet? → **Roadmap** (area id `ideas`): one catalogue entry with a status and an availability, and, once it works, one destination.

Worked examples: your own solar panel reads a sensor and produces savings → question 3 → Money → Devices & income. A city's 48 MWp solar plan is public evidence → question 4 → Places. A share in a local workshop with a wallet balance → question 3 → Money → Local stakes; its map marker is a reference in Places. A GPU node that earns per answer → question 3 → Money → Devices & income. A flat you rent → question 2 → Home. A path to owning that flat → question 5 until it exists.

## Reference conventions

- A reference is one line plus one link. It uses the canonical name below and jumps with `goToSection`, which selects the tab, opens closed disclosures and focuses the target.
- Capability destinations (`Idea.destination`) and adapter actions (`LedgerAdapter.action`) come from the catalogue; the Roadmap and the Me directory read them from there. They are typed with `SectionId`.
- "Connect … in Me" is the only way a reading links to its settings.

## Canonical names

| Use | Do not use |
|---|---|
| Home solar | Home energy, Home assets & connected readings |
| Validator | Validator activity/reading, network infrastructure |
| Local AI & GPU hosting | Local intelligence, GPU building option, Useful services, AI answers (as a feature name) |
| Local stakes (test units) | Invest in the place I live, Project examples, Local investments |
| Share-backed deposit, Loan against shares | Stocks as your deposit, Shares as deposit, Borrow against shares |
| Borrow & lend, Devices & income, Holdings (Money sections) | Goals, Ownership path (as a section) |
| Home ownership path | A path towards ownership |
| Reality level chips | Prototype, illustration, test used as unlabeled prose |
| Find a home · Secure the deposit · Keep your assets · Help build your city (the four stages, from `src/data/path.ts`) | Set up your ledger, Getting started, Your home journey, Settle into my city (as a stage) |
| Your next step | What to do next lists, setup checklists, Next on your path |
| Ways to hold the deposit | Deposit options panel, Rental deposit tab |
| Roadmap (the area; its id stays `ideas`) | Ideas (as the area name) |
| Available on this site, Needs a local setup, Planned (availability) | Hosted-only, demo-only, coming soon, Localhost only |

## First run

The server renders area metadata immediately. With a session hint, it also renders the requested area's heading and shaped skeleton while sign-in and first home reads settle. Without a hint, a neutral skeleton has no area heading until sign-in is known, so first-time visitors never see an account page before the door. Wallet connector readiness and area clicks do not remount the signed-in workspace. In-app navigation updates the title and focuses the heading unless a section jump has already focused its destination.

A new person meets these in order, and each says what it is:

1. **The door** (`onboarding.tsx`, progress from `account-setup-state.ts`). Its heading is the thread, followed by public access and passkey/wallet setup. No email or document upload is requested. Until the wallet SDK answers, a session hint allows the URL's area heading and shaped skeleton; without it, loading stays neutral without an account-area heading.
2. **Home at `/`** opens with the person's situation. Current tenants see the home picture, deposit status and key numbers in one Hero; the fictional Neighbourhood Homes map is used where applicable.
3. **About this tenancy** is a full-width row list directly below the Hero, not inside it. Labelled rows hold rent and receipts, move-in handover, service charges, moving out, and agreement/activity, with state in each row's meta text. An arbitrator sees only Agreement & activity while nothing needs them. Deep-link ids remain on the row or its content. One ActionBox contains the required step. Setup and move-out show a compact checked phase line; no step counter appears while living. Living landlords have two figures, Deposit held and Rent this month received; the rent note includes the house's 20 % share and next payment date. Neighbourhood context belongs to Places.

A stage is known from existing records. Your city comes from your tenant home (including its approximate pin), then a chosen listing or open application, then an EU-wallet city. An explicit city choice overrides these defaults and can be cleared with "Use my home city". Landlord and arbitrator properties never supply a personal city. Uncovered home cities stay visible as not covered, with a nearest-city preview, rather than another setup demand.

Places owns neighbourhood context around the approximate home pin. Located public projects, places and future events use the same 1 km radius. Dates, source review and incomplete coverage remain explicit; a pin outside the city's bbox is not treated as nearby. The city feed and welcome-guide link also live in Places.

The landlord may place a listing pin by map click or drag, without an address field or geocoding request. Only coordinates rounded to a roughly 100 m grid are stored and published. Photos are self-hosted samples, not uploads. Existing Unsplash presets are served from the same local sample paths; unrecognised remote photos are not loaded. Maps use Places’ OSM source through the same-origin map proxy.

After deposit security, either tenancy party can record electricity/gas/water readings with units and date and short room notes. No photos, names, addresses or documents belong in this shared record. Both parties confirm the same revision; a revision clears both confirmations and stale confirmations are rejected. The service-charge illustration shows these entries as the parties’ move-in meter baseline; one cumulative reading is never fabricated into usage or a charge. The landlord’s §19 BMG registration confirmation is a separate client-side print form: required names and addresses exist only in browser memory and the print document, not the agreement, local storage or an API. Closing clears the form. It advises taking the signed confirmation to the Bürgeramt generally within two weeks and checking local requirements, without legal advice.

## What changed on 2026-10-02

- Money and Me remove repeated notices and navigation, expose their primary holdings, wallet and connection controls, and keep only sources/fine print in disclosures. The city timeline records its resolved source; paid-answer progress uses plain words without inventing host activity. The public library has one introduction.
- Devices & income becomes the single place to add a device. "Add a device" offers the Home Node download with its SHA-256, the pairing code and two setup routes (the CLI or an AI assistant through the node's MCP configuration). Each device row shows GPU state, earnings and receipts per host, solar power and local-day kWh from pushed readings, validator ids and where its income goes (see below). Any signed-in account with a verified EVM wallet may pair up to two community hosts; operators can suspend them. Solar income is simulated and stays off until its funding key is configured. The building panel attributes income per source and lets tHOME holders claim and reinvest (claim, buy tHOME, approve, stake), each step an exact own-wallet review. Of this, only GPU income into the building and a staker's claim are proven live (a paid answer settled 0.0082 tUSDG into the distributor and the sole staker claimed 0.000019 tUSDG, [evidence](evidence/HOSTED_BUILDING_INCOME_CLAIM_ROBINHOOD_TESTNET_2026-10-02.json)); reinvest, rent shares and solar are not proven live.
- Local stakes: the housing example shows its building sketch again plus a pitched 3D OpenStreetMap view of the fictional house at an illustrative spot in Strausberg (an empty part of an unnamed residential parcel; the workshop on an empty part of an unnamed commercial parcel; never parks, construction sites or real projects). The live building panel now starts with "What can I claim?" (claimable, earned so far, Claim to my wallet, Reinvest), then "Where the income comes from" (devices paying the building, income sources, receipts), then stake/unstake.
- Local stakes gains a third, illustrative Agri-PV example (no token, no purchase): a calculator for a ticket holder's share of electricity sales and crop revenue. Defaults come from the Röbel/Müritz developer proposal (6 MWp, ~6 GWh/yr, ~€4 M, 8 ha, tickets from €250; the developer's figures, not verified) and the Bundesnetzagentur solar tender award of 1 July 2026 (4.79 ct/kWh, volume-weighted, first segment; a support benchmark, not a sales price); crop revenue and operating costs are editable assumptions. The Röbel precedent now lives in this card only, not in the housing section.
- Devices & income: each device shows where its GPU income goes ("the building (tHOME stakers) since <date>" or "your wallet"). The choice is saved on the server and stays until the owner changes it or removes the device; new devices can pay the building from pairing. `/api/building` lists the devices currently paying the building (name, kind, availability only).
- Home tenancy rent with a building share: a landlord may mark a new listing as a flat in the fictional Neighbourhood Homes building; both parties sign rent terms (agreement digest v3; v1/v2 unchanged). The tenant pays monthly test rent in tUSDG on Robinhood testnet, once per Berlin calendar month, as two exact own-wallet transfers: 80 % to the landlord's wallet recorded at publication and a fixed 20 % (floored) to the building distributor, which streams to tHOME stakers. Journals and recovery protect against double or half payments; receipts are verified. Publicly the building shows only an aggregated "Rent shares" total and count (no flat labels or rent receipt hashes); exact rent receipts are visible to tenant and landlord only. This simulates how a tokenized building could share net rental income; in a real building rent goes to the property owner under the lease. The deposit stays separate; its earnings belong to the tenant (§551 BGB). Built and locally tested, not run live.

## What changed on 2026-10-01

- Added the public `/replay` page: no account and no cookies, outside the wallet group. It replays the recorded 1 October share-deposit tenancy as the seven Home steps with all receipts, plus the loan, stake and paid-answer receipts; linked from the door and Home's deposit options.
- Home now connects a flat’s approximate map pin to sourced public neighbourhood context and, after deposit security, optional city/guide/public-compute links. It keeps the tenancy path non-blocking.
- Added a revision-bound handover confirmed separately by tenant and landlord, with meter baselines visible in service charges. Registration particulars stay in a browser-only print form.
- Removed Home’s remote Unsplash image requests and photo-upload controls; six attributed samples are self-hosted.


## Explaining an adapter

Every catalogue adapter carries an `explain` block instead of a free-text summary and privacy note. The Me directory shows it in this order: what it **brings**, then its reality level and effort, then **reads**, **keeps**, **who can see it**, **you need**, **to disconnect**, and one "Good to know" caveat.

| Field | Answers | Rule |
|---|---|---|
| `brings` | What does it add to my ledger? | One sentence a first-time person understands. A roadmap adapter starts "Nothing yet." |
| `reads` | What is read, from where, how often? | Name the provider and the polling rhythm. |
| `keeps` | What does this app store, and where? | Say whether a secret ever returns to the browser. |
| `visibility` | Who can see it? | Always include the operator and public chains where they apply. |
| `needs` | What must exist first? | Include what only the operator controls. |
| `disconnect` | How do I stop it? | Say what stopping does **not** undo, or that no control exists. |
| `effort` | How much work? | `automatic`, `one tap`, `few minutes`, `needs a device or service`, `not available yet`. |
| `reality` | How real is it? | One ontology level (`src/data/reality.ts`). |

Every statement was checked against the code that implements it (2026-09-29). Two consequences worth knowing:

- The Home Assistant explanation says the app only reads, but that the token itself is **not** limited to reading, that it is stored as plain data on the server, and that the operator can use it. That is true today. A production build refuses to connect at all unless the operator opts in (`ALLOW_HOME_ASSISTANT_PULL=1`, set by local setup), and says so on the adapter; a stored connection can still be removed there.
- The Local AI explanation says questions and answers are removed about ten minutes after an answer ends (configurable), while usage counts and receipts stay, and that "Finish & clear this desk" removes the visitor's saved text now. The model host still sees each question in clear while it runs; only the app's stored copy is bounded.

Add or change an adapter by reading the code first, then editing the statements. `ledger-catalogue.test.ts` fails if a roadmap adapter claims to be live, or a live adapter claims to be roadmap.

## Adding or moving a section

1. Give the element an `id` and add it to `SECTIONS` in `src/data/sections.ts` under the one area that renders it.
2. Put a tab-level section in `SectionTabs` (its `id` is the jump target); state its reality level.
3. Point the catalogue at it: `Idea.destination` for the capability, `LedgerAdapter.action` for the adapter.
4. Run `npm test`. The catalogue tests fail if a section is registered under another area than the one a link claims, or if an adapter is operated outside the area that owns its topic.
5. Update the tables on this page and in [`LEDGER_OF_LIFE.md`](LEDGER_OF_LIFE.md) section 3.

## What changed on 2026-09-29

- Money became one page with four tabs. The promotional hero, the two goal cards and the duplicated "Build local ownership" and "Secure a rental deposit" entry points are gone; the ownership path now sits under the holdings.
- Home solar moved from a collapsed Home card to Money → Devices & income beside the validator and the local AI node. Both readings share one card (`DeviceReadings`) and one endpoint scope (`/api/assets?area=devices`).
- Home no longer hosts personal-Money promotional cards, collateral calculators or connected-readings cards. Rental share custody is operated in Home; personal loan collateral remains in Money → Shares & loans.
- The catalogue is the single source for capability topic, status label and destination. `IDEAS[].area`, the Ideas routing table and the Ideas topic groups were replaced by `Idea.topic` and `Idea.destination`; "Energy & devices" is now owned by Money.
- Status chips distinguish Built from Partly built and Planned; the duplicate label maps and scattered chip rules were consolidated.
- A duplicate DOM id (`regional-topics`) was removed.
- Adapters explain themselves: `summary` and `privacy` were replaced by a verified `explain` block (brings, reads, keeps, who can see it, needs, disconnect, effort, reality). Several old catalogue statements were wrong or incomplete and were corrected, for example "Real account" for a development account on test networks, "Read-only readings" for a Home Assistant token that can do more, and "Following stays on this device" for a chosen city that is stored on the server.
- A getting-started guide sits on top of Today for a new account, and the setup wizard now says what the product is, that money features are test-only, and what each step is for. The "Choose your city" prompts on Today are real links.
- `RealityLevel` moved to `src/data/reality.ts` and gained "Your own statement" so the adapter directory and the Money tabs use one vocabulary.
- Holdings shows the priced subtotal as four parts that add up to it: free to use, locked in the rental deposit, pledged as collateral, and owed (`net-position.tsx`, arithmetic in `money-valuation.ts`). The owner decided the deposit stays inside the subtotal, shown as a locked part; [ADR 0001](adr/0001-separate-rental-security-and-personal-portfolio.md) records that display is not authority. Today shows the same parts as one line.
- The former second-browser recovery proof and backup-email setup were superseded on 1 October by passkey-only access ([ADR 0014](adr/0014-passkey-only-test-accounts.md)); no recovery email is collected.
- Home explains itself to a person who cannot run the journey alone: a "How a tenancy works" card (open when no test tools can play the other people) and an empty state that says a tenancy needs three separate accounts. Test tools are absent on hosted builds; the copy no longer implies one account is enough there.
- The previous operator-priced “Invest in TSLA” desk and “Prepare example shares” flow are removed. Official test TSLA comes from Robinhood's external faucet. Historical fake-stock purchase/loan proofs are not shared-market evidence. Missing deployment is explicitly undeployed; no mocked price or liquidity replaces it.
- The shell remembers where you are: the area and the Money tab live in the URL (`?area=money&tab=money-shares`, never the hash, which carries the invitation), so Back, reload and a shared link return to the same place; the tab title, focus and an announcement follow the area. An error inside one area no longer blanks the app (`area-error-boundary.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`). The top bar shows who is signed in with a Sign out button and "Test networks · no real money".
- Shares & loans exposes source round/time, copied time, stale/closed-market labels, pool cash/utilization/current rates and lender value/earned amount. Interest accrues continuously at 5% nominal annually (about 5.13% effective, read from the contract), without projections. Wallet reads never scan the borrower registry; unhealthy loans load separately on demand in bounded pages. Immutable collateral issuer/implementation pins and suspension reasons expose TSLA pause, pool block, implementation change and collateral shortfall. Burn-address seed shares (10,000 freely mintable tUSDG) and locked interest are disclosed; no staged liquidation. Localhost reads the same hosted market without an updater key.
- Contrast: the focus ring, the muted greys and the mobile labels now meet WCAG AA (focus ring 1.65:1 → 7.6:1 on paper; muted text 3.8:1 → 5.4:1); reality chips explain themselves in text, not only in a tooltip.
- Today keeps "since your last visit" until the person marks it seen, shows what you are waiting for, and counts a published listing or a pending application as progress on "Find or add a home".
- Money → Holdings starts with a "Get test funds" card (both wallet addresses, the Circle faucet, where test USD comes from), says once that nothing can be sold or withdrawn, and gives every disabled control a reason. Loans show the rate, the borrowing limit, the liquidation rule and how far the price can fall, with a review before pledging, borrowing and repaying. The holdings subtotal no longer waits on Home Assistant or the validator (`/api/assets?area=holdings`).
- Places leads with the published snapshot date and an eight-city picker (plus "another place", plainly not covered) instead of a prefilled text box; a city is a covered id or an explicit uncovered name, never any string. The front door is "What is changing in <city>" with a dated Open now / Closed recently / Nothing open block that answers "where can I have a say?". Strausberg-only stories appear only for Strausberg; the fictional project says "fictional test project · test tokens · no rights" everywhere. The sheet beside the map sticks only inside its own row (`civic-map-row`), so it can no longer slide over the Outcomes and Connections panels.
- Home reads Journey and Listings independently and offers Retry; the arbitrator invitation survives a reload and is previewed before joining; claims and decisions show reasons, limits and the split before anyone signs; a landlord can close a listing and an applicant withdraw before a tenant is chosen.
- Getting onboarded into a city has a first slice: `/welcome/strausberg`, a public, account-free guide (a sourced first-months plan, what is on, clubs and groups, who to ask). The wallet SDK now loads only inside the `(wallet)` route group, so this page contacts no third party ([ADR 0012](adr/0012-public-pages-outside-the-wallet-group.md)). The interest vocabulary is now one list shared by Places and the guide (sport, kids, shops, health, culture, nature, volunteering).

## What changed on 2026-09-30

- One thread through the whole app (section "The thread and the next step" above): `src/data/path.ts` holds the sentence and the four stages; the door, Today, every area eyebrow ("STAGE 3 OF 4 · KEEP YOUR ASSETS") and the Roadmap use them. Two design proposals (GPT-6.1 and Claude Opus) and a Claude Sonnet screen inventory and review informed it.
- One next step replaces Today's six-step getting-started guide (deleted with `setup-steps.ts`), the four "Choose my city" prompts and the Home hero's own button. Money's six-step "shares to stakes" funnel became three optional choices.
- Navigation follows the path; Ideas became the Roadmap, grouped by availability, reached from the sidebar foot. Signed-out visitors see only what works without an account.
- Home: one seven-step path (Find, Apply, Agree, Secure, Live, Move out, Paid out) replaces the four-step hero, the six-step walkthrough and the per-tenancy six-stage bar; listing cards show rent, deposit and "Apply for this home" without opening anything; the tenant sees "Agree and settle" and "Dispute deduction" as equal choices; "Ways to hold the deposit" answers the stocks and lending questions with availability labels.
- Money: holdings and the five categories first, test-money funding next to the action that needs it; Shares & loans offers two tasks (Loan against shares, Lend test dollars) with the protocol details behind one disclosure and no "Rental deposit" panel. The obsolete share-deposit illustration was deleted when the real in-kind rental path became available in Home.
- The "Test networks · no real money" chip opens the one explainer of what is real here.
- The market's preflight checks refuse a shortfall before any signature (`src/domain/market-preflight.ts`).
- Home: either the landlord or the tenant can cancel a tenancy before the deposit is locked, from the tenancy card. The tenancy and its listing close for everyone; the card keeps who cancelled and when, with no further step. Cancellation is refused while escrow initialization is confirming, while a funding operation is signed, broadcast or unknown, and once the deposit is funded. Accounts, wallets and balances stay. Cancelling sends nothing on chain; an initialized empty escrow stays on devnet. If someone funds it directly on chain despite cancellation, the normal settlement and payout steps return. Checked locally with scripted chain observations and a browser fixture, not on a funded devnet tenancy.
- Deposits can be realistic: the site mints its own devnet test USDC (tUSDC, 10,000 per faucet request, "Get test USDC" at the deposit step and in Money → Test money), and the listing form suggests three months' cold rent. A tUSDC deposit stays in cash escrow; the tenancy card and Money → Holdings deposit tile show live simulated yield (5 % simple annual interest by default) from confirmed funding until settlement. Earnings belong to the tenant and are paid by this site in tUSDC, not by lending the deposit. Tenant-only claims follow the accepted release policy (during the tenancy when allowed, otherwise after settlement); prior claims subtract from later payouts. Durable signed-byte journals recover the same claim without double minting. The UI distinguishes this from borrower-funded real earnings and explains §551 BGB's usual savings-interest requirement, without legal advice.
- Ledger of Life takes the Stadtstack family look: the bound-pages mark (Stadtstack's four stacked tiles bound by an ink spine), "part of stadtstack." beside the name, the four stages in the Stadtstack level colours as accents only (1 green, 2 teal, 3 amber, 4 coral), ink text and ink pill buttons, and the self-hosted Fraunces, Public Sans and IBM Plex Mono. Three proposals (GPT-6.1, Claude Opus, Claude Sonnet) informed it.

## Still open

- Places lists the fictional `tHOME`/`tWORK` issuers as map markers and a detail sheet. They are labelled illustrations with a link to Money, but they are the last personal-investment surface outside Money.
- Outside Money and the adapter directory, sections use free-text reality labels and the five-value capability status rather than the ontology chips.
- Setup lets the sidebar stay clickable although every area shows the wizard until the wallets exist (signed-out visitors now see only the no-account links).
- Dead code found while mapping: `src/components/neighborhood.tsx`, `openCityEvent` and the `capabilityIds` of `SYSTEM_NODES` in `civic-system.ts` have no consumer.
- The Me directory's state chips for the four city adapters still all read "City selected" whatever their coverage.
- The welcome guide exists only in English and only for Strausberg; it has no registration-desk handout or QR code yet, and Places still needs an account, so a visitor without one cannot preview it.
- The repository and package are `ledger-of-life`, renamed on 1 Oct 2026 from `rental-deposit-hackathon`. The local checkout folder, image name `ghcr.io/giraeffleaeffle/ledger-of-life` and environment keys are unchanged.

## What changed on 2026-10-02

- Shell and loading: URL-derived areas/tabs and server metadata, stable account identity across wallet connections and navigation, area-shaped skeletons, neutral signed-out navigation, and one global test-network/reality explainer. Changes to active home or application records invalidate the inferred city for mounted consumers; unchanged polls do not.

- Places and Today share the server-resolved city, source labels and home pin. City feed and signals load in parallel without an empty-city request. One change/preview control lives in the city card; Today is a four-row reference strip and one civic-update link. Places owns the since-last-visit list, and only "Mark changes seen" acknowledges it. Primary sections show relevant samples with "Show all" controls, not duplicate blocks or hidden disclosures. Legacy home records are skipped when they cannot supply a verified city; home-change cache invalidation works even while Home is the only mounted area. Source fine print remains a disclosure.
