# Information architecture: where a feature lives

Status: 2026-09-30. This page owns the placement rule and the order in which a person meets things. [`LEDGER_OF_LIFE.md`](LEDGER_OF_LIFE.md) describes what each area contains, [`ontology.yaml`](ontology.yaml) defines the concepts, [`src/data/sections.ts`](../src/data/sections.ts) lists every jump target and its one owning area, [`src/data/ledger-catalogue.ts`](../src/data/ledger-catalogue.ts) holds the topics, capability status and each capability's single destination, and [`src/data/path.ts`](../src/data/path.ts) holds the thread and its four stages.

## The rule

1. **Each area answers one question.** If something does not help answer it, it belongs elsewhere.
2. **A feature has one home**: one area, and inside it one section. The home is where the person *operates* it (buys, connects, signs, reads its live value).
3. **Every other place shows a reference**: at most one line of status and one link to the home. A reference never repeats a control, a calculator or a promotional card.
4. **Topics are subject matter; areas are places to operate.** The five topics (Identity & life, Home & living, Money & ownership, Energy & devices, Places & participation) organise browsing in Today, the Me directory and Ideas. A feature can belong to a topic without being operated in the topic's namesake area. Energy & devices is operated in Money. Home shares belong to Home & living but are bought as test units in Money → Local stakes. The catalogue test fails when an adapter is operated outside the area that owns its topic.
5. **Rental security and personal money never share a card** ([ADR 0001](adr/0001-separate-rental-security-and-personal-portfolio.md), [`CONTEXT.md`](../CONTEXT.md)).
6. **Every section states how real it is.** Money's sections carry the ontology's reality level as a chip; the levels are defined in [`ontology.yaml`](ontology.yaml) (`reality_levels`) and `src/components/reality-chip.tsx`.
7. **The thread decides the order.** Placement says where a feature lives; the thread says what comes next (section below). Every screen uses the same four stage names, and a person always has exactly one next step.

## The thread and the next step

One sentence, the owner's destination line with the deposit as its hinge: **Find a home, secure the deposit, keep your assets, help build your city.** It is `THREAD` in `src/data/path.ts`, and the door's heading. Its four stages (`STAGES`) are the only names for the path, used on the door, Today, the area eyebrows, Home and the Roadmap:

| # | Stage | Operated in | Counts as done |
|---|---|---|---|
| 1 | Find a home | Home | a listing, an application or a tenancy exists |
| 2 | Secure the deposit | Home (tenancy card) | a deposit is locked (living or later) |
| 3 | Keep your assets | Money | never done; a status (free, locked, pledged, lent, owed) |
| 4 | Help build your city | Places (local stakes and the AI desk are operated in Money) | a city is chosen |

- **One next step** (`src/components/next-step.ts`, `next-step-card.tsx`). Precedence: an opened invitation, a home step waiting for this person, applicants to review, a step waiting on someone else or the network, an application in progress, a failed read, a secured or paid-out home, then a fresh account's "Start with a home" with two equal alternatives. It is a full card on Today. On Money, Places and Me it appears only when something waits for this person (an invitation, their own home step, applicants to review); Home never repeats it, because its own path already shows the step. A read that failed or is still running is never offered as done or empty.
- **Today shows where you are** (`path-strip.tsx`, pure `path-progress.ts`): the four stages as done, in progress, to do, or not known yet, then three status tiles titled by stage.
- **Navigation follows the path:** Today, Home, Money, Places, then Me (the toolbox for every stage). The Roadmap (area id `ideas`) is secondary: the sidebar foot, Today's stage links and the explainer lead there. Signed-out visitors see only what works without an account (the welcome guide and the public AI desk).
- **What is real here** lives in one place: the "Test networks · no real money" chip opens the explainer with four availability labels (Available on this site, Needs a local setup, Contract prototype, Planned). Reality chips still say how real the data is; availability says whether you can do it on this site.
- **Ways to hold the deposit** (Home, `deposit-options`) is the one answer to "a deposit with shares, or lent out?": the test-USDC deposit (available on this site; since 1 October new tenancies use test USDC minted by this site, tUSDC, held as cash in the escrow, so realistic amounts such as three months' cold rent work), the deposit lent out to earn (needs a local setup: earnings in test dollars exist only in a local rehearsal, where the deposit is lent to the shared loan pool, and they belong to the tenant; older Circle-USDC tenancies are lent on devnet, which pays nothing), and a share-backed deposit (contract prototype). Nothing in it signs.

## The six areas

In navigation order; the Roadmap is reached from the sidebar foot rather than the main navigation.

| Area | The one question | Operated here | Not operated here (link instead) |
|---|---|---|---|
| **Today** | Your next step, and where you are on the path | Nothing. The next step, the stage strip and three status tiles | Every control. Tiles link to the area that owns them |
| **Home** | Find a home, agree the deposit, and see what is owed | Listings, application, agreement, deposit, service charges, move-out, payouts | Shares, loans, stakes, device readings (Money) |
| **Money** | Your test holdings, collateral, loans and recorded activity | Holdings, shared official-stock loans and lender positions, local stakes, devices that earn | The rental itself (Home), connection settings (Me), public projects (Places) |
| **Places** | Get settled, see what's changing, and find the published ways to take part | Public map, projects, city feed, evidence, following, city choice | Anything with a personal balance. Fictional project markers are illustrations; buying is in Money |
| **Me** | Your access, private history and connections | Passkeys, wallets, recovery, EU proof, roles, timeline, and the settings of every connection (Home Assistant, validator) | Readings and income from those connections (Money), the tenancy (Home) |
| **Roadmap** (id `ideas`) | What is built, what is a prototype, and what is planned? | Nothing. Every capability grouped by availability, with one link to where it works | — |

## Money has four sections

Money is one page with four tabs (`SectionTabs`). Each has one job and states its reality level. Every panel stays mounted, so a half-finished workflow keeps its state, and a jump from another area selects the right tab first.

| Section | Jump target | What it is for | Reality |
|---|---|---|---|
| **Holdings** | `money-holdings` | Deposit entitlement, wallet shares/cash, lent value, debt and priced subtotal | Test network · mirrored live token price with provenance |
| **Shares & loans** | `money-shares` | Official-stock collateral, loans, lending, on-demand paginated unhealthy loans; wallet reads do not scan the registry; deposit needs actual parties and is unavailable on the hosted demo | Test network · deployment required · borrower-funded interest |
| **Local stakes** | `money-stakes` | Fictional local-project units (`tHOME` housing, `tWORK` workshop) and the project sketch | Test network · simulated input |
| **Devices & income** | `money-devices` | Things you run that produce value: home solar, a validator, the local AI node on a GPU | Live read-only · test network |

## Where the ambiguous features live

| Feature | Home (area → section) | Configured in | Referenced from, and what the reference shows |
|---|---|---|---|
| Rented home: listing, agreement, deposit, move-out | Home | Me (wallet) | Today (next step), Money → Holdings (deposit entitlement tile), Me (timeline, roles) |
| Service charges | Home (inside a living tenancy) | Me (Home Assistant, for consumption) | Ideas, Me directory |
| Shared official-stock loan and lending; deposit prototype | Money → Shares & loans | Me (wallet); verified shared deployment and hosted mirror job | Today, Ideas, Me directory; no fake landlord/desk setup |
| Stocks: tSPYx and official faucet test TSLA | Money → Holdings (wallet/lent positions) and Shares & loans (collateral) | Me (wallet) | Today (subtotal); wallet/collateral TSLA use one mirror, Jupiter only cross-checks |
| **Tokenized local companies and housing** (`tHOME`, `tWORK` test units) | Money → Local stakes | Me (wallet) | Places (issuer markers, an illustration with a link to buy), Ideas, Today, Me directory |
| Home ownership path (home shares) | Ideas (roadmap). Its nearest working surface is Money → Local stakes | — | Today (link), Me directory |
| **Solar**: your own Home Assistant reading | Money → Devices & income | Me → Home Assistant | Home (service charges read the same sensor), Today, Me directory |
| Solar and heat plans of a city (public evidence, for example Solarpark) | Places → project evidence | Me (chosen city) | Today (compact preview) |
| Validator stake and rewards | Money → Devices & income | Me → validator | Today, Me directory |
| **GPU**: local AI node, per-answer payment, host income scenario | Money → Devices & income | — (node is configured on the host) | Places (library profile), Ideas, the ownership path, Me directory |
| Free public AI desk for visitors | `/library` (no account, separate route) | — | Money → Devices & income offers it as the library access mode |
| Newcomer welcome guide | `/welcome/<city>` (no account; a separate route, outside the wallet route group) | — | Places (a "New here? Welcome guide" link in the city card); its interests are Places' interests |
| Electric car and other devices | Ideas (roadmap) | — | Today (says feeds remain planned) |

## Deciding where something new goes

Ask in order; the first yes decides.

1. Is it who the person is, or a connection they configure? → **Me**. Only configuration lives there; the readings and income live where the person uses them.
2. Does its life cycle belong to a dwelling or tenancy (listing, agreement, deposit, service charges, move-out)? → **Home**.
3. Does it hold a balance, position or debt, or produce or spend money for the person? → **Money**, then pick the section: Holdings for balances and positions, Shares & loans for collateral workflows, Local stakes for issuer units, Devices & income for things the person runs.
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
| Shares & loans, Devices & income, Holdings (Money sections) | Goals, Ownership path (as a section) |
| Home ownership path | A path towards ownership |
| Reality level chips | Prototype, illustration, test used as unlabeled prose |
| Find a home · Secure the deposit · Keep your assets · Help build your city (the four stages, from `src/data/path.ts`) | Set up your ledger, Getting started, Your home journey, Settle into my city (as a stage) |
| Your next step | What to do next lists, setup checklists, Next on your path |
| Ways to hold the deposit | Deposit options panel, Rental deposit tab |
| Roadmap (the area; its id stays `ideas`) | Ideas (as the area name) |
| Available on this site, Needs a local setup, Contract prototype, Planned (availability) | Hosted-only, demo-only, coming soon, Localhost only |

## First run

A new person meets these in order, and each says what it is:

1. **The door** (`onboarding.tsx`, progress from `account-setup-state.ts`). Its heading is the thread; the four stages follow, then what you can do, "Test networks only. Nothing here has monetary value.", the two things that need no account (the Strausberg welcome guide and the public AI desk), and only then "Start with two quick steps": a passkey, then the two wallets (named: Solana and Robinhood Chain). The backup email is a third step where recovery is required. Until the wallet SDK and the server have answered, a neutral "Checking your sign-in…" shows instead, so a returning person never sees the welcome steps. The second-browser recovery proof is not part of it ([ADR 0011](adr/0011-ask-for-recovery-at-the-first-wallet-action.md)): it appears in the tenancy card the first time a wallet acts, and Me shows it under the account panel.
2. **Your next step** (under every area's heading). For a new account on Today: "Your account is ready. Start with a home." with Find a home, and Choose your city and Get test money as equal alternatives.
3. **The stage strip and three status tiles** on Today (1–2 · Your home, 3 · Your assets, 4 · Your city). Optional connections (EU proof, home solar, validator) are not a completion score; they live in Me.

A stage is done by the rules in the table above. While a reading is still running, or after it failed, the stage says "Not known yet", never "To do", because the person may already have done it. Places without a chosen city shows the city chooser first, with "Preview … — don't save" separate from "Make this my city"; nothing picks a city for the person.

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
- Home no longer hosts Money content: the share-backed promo card, both collateral calculators and the connected-readings card are removed. The calculator now lives in Money → Shares & loans, and the tenancy card keeps one link to it.
- The catalogue is the single source for capability topic, status label and destination. `IDEAS[].area`, the Ideas routing table and the Ideas topic groups were replaced by `Idea.topic` and `Idea.destination`; "Energy & devices" is now owned by Money.
- Status chips distinguish Built from Partly built and Planned; the duplicate label maps and scattered chip rules were consolidated.
- A duplicate DOM id (`regional-topics`) was removed.
- Adapters explain themselves: `summary` and `privacy` were replaced by a verified `explain` block (brings, reads, keeps, who can see it, needs, disconnect, effort, reality). Several old catalogue statements were wrong or incomplete and were corrected, for example "Real account" for a development account on test networks, "Read-only readings" for a Home Assistant token that can do more, and "Following stays on this device" for a chosen city that is stored on the server.
- A getting-started guide sits on top of Today for a new account, and the setup wizard now says what the product is, that money features are test-only, and what each step is for. The "Choose your city" prompts on Today are real links.
- `RealityLevel` moved to `src/data/reality.ts` and gained "Your own statement" so the adapter directory and the Money tabs use one vocabulary.
- Holdings shows the priced subtotal as four parts that add up to it: free to use, locked in the rental deposit, pledged as collateral, and owed (`net-position.tsx`, arithmetic in `money-valuation.ts`). The owner decided the deposit stays inside the subtotal, shown as a locked part; [ADR 0001](adr/0001-separate-rental-security-and-personal-portfolio.md) records that display is not authority. Today shows the same parts as one line.
- The front door ends after the two wallets. The second-browser recovery proof moved to the first wallet action on a tenancy ([ADR 0011](adr/0011-ask-for-recovery-at-the-first-wallet-action.md)), so a person can browse and choose a city first. The tenancy card shows the proof as its step ("Prove you can recover your wallets") instead of pointing at a Connections page that no longer exists.
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
- Money: holdings and the five categories first, test-money funding next to the action that needs it; Shares & loans offers two tasks (Loan against shares, Lend test dollars) with the protocol details behind one disclosure and no "Rental deposit" panel; the share-backed deposit calculator moved to the Roadmap as the prototype's illustration.
- The "Test networks · no real money" chip opens the one explainer of what is real here.
- The market's preflight checks refuse a shortfall before any signature (`src/domain/market-preflight.ts`).

## Still open

- Places lists the fictional `tHOME`/`tWORK` issuers as map markers and a detail sheet. They are labelled illustrations with a link to Money, but they are the last personal-investment surface outside Money.
- Today still shows civic blocks (city press, followed updates, visit changes) and a "mark update read" control that Places also offers. `LEDGER_OF_LIFE.md` describes Today as links only.
- Outside Money and the adapter directory, sections use free-text reality labels and the five-value capability status rather than the ontology chips.
- Setup lets the sidebar stay clickable although every area shows the wizard until the wallets exist (signed-out visitors now see only the no-account links).
- Dead code found while mapping: `src/components/neighborhood.tsx`, `openCityEvent` and the `capabilityIds` of `SYSTEM_NODES` in `civic-system.ts` have no consumer.
- The Me directory's state chips for the four city adapters still all read "City selected" whatever their coverage.
- The welcome guide exists only in English and only for Strausberg; it has no registration-desk handout or QR code yet, and Places and Today still need an account, so a visitor without one cannot preview them.
- The repository and `package.json` are still named `rental-deposit-hackathon`; the product name is Ledger of Life.
