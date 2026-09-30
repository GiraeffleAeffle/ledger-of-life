# Information architecture: where a feature lives

Status: 2026-09-29. This page owns the placement rule. [`LEDGER_OF_LIFE.md`](LEDGER_OF_LIFE.md) describes what each area contains, [`ontology.yaml`](ontology.yaml) defines the concepts, [`src/data/sections.ts`](../src/data/sections.ts) lists every jump target and its one owning area, and [`src/data/ledger-catalogue.ts`](../src/data/ledger-catalogue.ts) holds the topics, capability status and each capability's single destination.

## The rule

1. **Each area answers one question.** If something does not help answer it, it belongs elsewhere.
2. **A feature has one home**: one area, and inside it one section. The home is where the person *operates* it (buys, connects, signs, reads its live value).
3. **Every other place shows a reference**: at most one line of status and one link to the home. A reference never repeats a control, a calculator or a promotional card.
4. **Topics are subject matter; areas are places to operate.** The five topics (Identity & life, Home & living, Money & ownership, Energy & devices, Places & participation) organise browsing in Today, the Me directory and Ideas. A feature can belong to a topic without being operated in the topic's namesake area. Energy & devices is operated in Money. Home shares belong to Home & living but are bought as test units in Money → Local stakes. The catalogue test fails when an adapter is operated outside the area that owns its topic.
5. **Rental security and personal money never share a card** ([ADR 0001](adr/0001-separate-rental-security-and-personal-portfolio.md), [`CONTEXT.md`](../CONTEXT.md)).
6. **Every section states how real it is.** Money's sections carry the ontology's reality level as a chip; the levels are defined in [`ontology.yaml`](ontology.yaml) (`reality_levels`) and `src/components/reality-chip.tsx`.

## The six areas

| Area | The one question | Operated here | Not operated here (link instead) |
|---|---|---|---|
| **Today** | Your identity, home, assets and place, connected | Nothing. A glance at every area and what needs you now | Every control. Cards link to the area that owns them |
| **Me** | Who am I here, and what may others learn? | Passkeys, wallets, recovery, EU proof, roles, timeline, and the settings of every connection (Home Assistant, validator) | Readings and income from those connections (Money), the tenancy (Home) |
| **Home** | Where do I live, and what is locked or owed there? | Listings, application, agreement, deposit, service charges, move-out, payouts | Shares, loans, stakes, device readings (Money) |
| **Money** | What do I own, owe and earn? | Holdings, share-backed deposit and loan, local stakes, devices that earn | The rental itself (Home), connection settings (Me), public projects (Places) |
| **Places** | What is changing where I live, and where can I have a say? | Public map, projects, city feed, evidence, following, city choice | Anything with a personal balance. Fictional project markers are illustrations; buying is in Money |
| **Ideas** | What works, what comes next, and which adapter connects it? | Nothing. Status of every capability, with one link to where it works | — |

## Money has four sections

Money is one page with four tabs (`SectionTabs`). Each has one job and states its reality level. Every panel stays mounted, so a half-finished workflow keeps its state, and a jump from another area selects the right tab first.

| Section | Jump target | What it is for | Reality |
|---|---|---|---|
| **Holdings** | `money-holdings` | What exists: deposit entitlement, shares, test cash, the priced subtotal, the ownership path, deposit activity | Test network · live read-only prices |
| **Shares & loans** | `money-shares` | Using test shares: share-backed deposit, loan against shares, the collateral calculator | Test network · simulated input |
| **Local stakes** | `money-stakes` | Fictional local-project units (`tHOME` housing, `tWORK` workshop) and the project sketch | Test network · simulated input |
| **Devices & income** | `money-devices` | Things you run that produce value: home solar, a validator, the local AI node on a GPU | Live read-only · test network |

## Where the ambiguous features live

| Feature | Home (area → section) | Configured in | Referenced from, and what the reference shows |
|---|---|---|---|
| Rented home: listing, agreement, deposit, move-out | Home | Me (wallet) | Today (next step), Money → Holdings (deposit entitlement tile), Me (timeline, roles) |
| Service charges | Home (inside a living tenancy) | Me (Home Assistant, for consumption) | Ideas, Me directory |
| Share-backed deposit, loan against shares | Money → Shares & loans | Me (wallet) | Home (one link at the tenancy's deposit step), Today, Ideas, Me directory |
| Stocks: tSPYx, official TSLA, fake tTSLA | Money → Holdings (positions) and Shares & loans (collateral) | Me (wallet) | Today (subtotal) |
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
5. Is it not built yet? → **Ideas**: one catalogue entry with a status and, once it works, one destination.

Worked examples: your own solar panel reads a sensor and produces savings → question 3 → Money → Devices & income. A city's 48 MWp solar plan is public evidence → question 4 → Places. A share in a local workshop with a wallet balance → question 3 → Money → Local stakes; its map marker is a reference in Places. A GPU node that earns per answer → question 3 → Money → Devices & income. A flat you rent → question 2 → Home. A path to owning that flat → question 5 until it exists.

## Reference conventions

- A reference is one line plus one link. It uses the canonical name below and jumps with `goToSection`, which selects the tab, opens closed disclosures and focuses the target.
- Capability destinations (`Idea.destination`) and adapter actions (`LedgerAdapter.action`) come from the catalogue; the Ideas map and the Me directory read them from there, and Today reads the topic names. They are typed with `SectionId`.
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

## First run

A new person meets three things in order, and each says what it is:

1. **Setup wizard** (`onboarding.tsx`, progress from `account-setup-state.ts`). It opens by saying what Ledger of Life is and that the money features run on test networks. Steps: passkey, backup email, two wallets (named: Solana and Robinhood Chain). It ends there. Until the wallet SDK and the server have answered, a neutral "Checking your sign-in…" shows instead, so a returning person never sees the welcome steps. It has an exit ("Use a different account") and says plainly when sign-in is not configured on the server. The second-browser recovery proof is not part of it ([ADR 0011](adr/0011-ask-for-recovery-at-the-first-wallet-action.md)): a reminder card sits under the guide on Today, the same steps appear in the tenancy card the first time a wallet acts, and Me shows them under the account panel.
2. **Getting-started guide** (top of Today, directly under the page title, `getting-started.tsx`). One card, hidden per account on this device. It lists the adapters the catalogue marks `setup` (`Adapter.setup.order`): sign in, choose your city, find or add a home, then three optional steps (EU proof, home solar, validator) under an "Optional" label. Only the next step (`nextSetupStep`) shows the adapter's own `explain.brings`, effort and reality level; the other open steps show their title and one button that goes to where it is done. The card adds no list of its own: state and next action come from `adapterState` and `adapterAction`, the same functions Me uses. For a new account on a phone, the first action is on the first screen.
3. **The five Today cards**, which stay as references, under a small "One person. Connected parts of life." heading. The Home status bar above the guide shows only when there is a home, listing, invitation or error to report.

A step is done when the adapter's state says it is configured; the guide stays hidden while any of those observations is still loading, so nothing flashes as "to do". A step whose observation failed says "We could not check this just now" with **Try again**; it is never offered as the next step, because the person may already have done it. An unfinished step sends the person to the section that owns it (`city-choice`, `home-options`, `adapter-home-assistant`, `adapter-validator`, `identity-eudi`). Places without a chosen city shows only the city picker and one "look at a covered city" row; its other sections appear once a city is chosen or explored.

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
- The Holdings "Invest in TSLA" button no longer spends the whole test-USD balance. A person picks an amount, reviews it, then signs; the approval covers only that amount; the review warns when buying would stop this wallet from preparing example shares (pledge and borrow) and when a loan is open.
- The shell remembers where you are: the area and the Money tab live in the URL (`?area=money&tab=money-shares`, never the hash, which carries the invitation), so Back, reload and a shared link return to the same place; the tab title, focus and an announcement follow the area. An error inside one area no longer blanks the app (`area-error-boundary.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`). The top bar shows who is signed in with a Sign out button and "Test networks · no real money".
- Contrast: the focus ring, the muted greys and the mobile labels now meet WCAG AA (focus ring 1.65:1 → 7.6:1 on paper; muted text 3.8:1 → 5.4:1); reality chips explain themselves in text, not only in a tooltip.
- Today keeps "since your last visit" until the person marks it seen, shows what you are waiting for, and counts a published listing or a pending application as progress on "Find or add a home".
- Money → Holdings starts with a "Get test funds" card (both wallet addresses, the Circle faucet, where test USD comes from), says once that nothing can be sold or withdrawn, and gives every disabled control a reason. Loans show the rate, the borrowing limit, the liquidation rule and how far the price can fall, with a review before pledging, borrowing and repaying. The holdings subtotal no longer waits on Home Assistant or the validator (`/api/assets?area=holdings`).
- Places leads with the published snapshot date and an eight-city picker (plus "another place", plainly not covered) instead of a prefilled text box; a city is a covered id or an explicit uncovered name, never any string. The front door is "What is changing in <city>" with a dated Open now / Closed recently / Nothing open block that answers "where can I have a say?". Strausberg-only stories appear only for Strausberg; the fictional project says "fictional test project · test tokens · no rights" everywhere. The sheet beside the map sticks only inside its own row (`civic-map-row`), so it can no longer slide over the Outcomes and Connections panels.
- Home reads Journey and Listings independently and offers Retry; the arbitrator invitation survives a reload and is previewed before joining; claims and decisions show reasons, limits and the split before anyone signs; a landlord can close a listing and an applicant withdraw before a tenant is chosen.
- Getting onboarded into a city has a first slice: `/welcome/strausberg`, a public, account-free guide (a sourced first-months plan, what is on, clubs and groups, who to ask). The wallet SDK now loads only inside the `(wallet)` route group, so this page contacts no third party ([ADR 0012](adr/0012-public-pages-outside-the-wallet-group.md)). The interest vocabulary is now one list shared by Places and the guide (sport, kids, shops, health, culture, nature, volunteering).

## Still open

- Places lists the fictional `tHOME`/`tWORK` issuers as map markers and a detail sheet. They are labelled illustrations with a link to Money, but they are the last personal-investment surface outside Money.
- Today still shows civic blocks (city press, followed updates, visit changes) and a "mark update read" control that Places also offers. `LEDGER_OF_LIFE.md` describes Today as links only.
- Outside Money and the adapter directory, sections use free-text reality labels and the five-value capability status rather than the ontology chips.
- Setup lets the sidebar stay clickable although every area shows the wizard until the wallets exist.
- Dead code found while mapping: `src/components/neighborhood.tsx`, `openCityEvent` and the `capabilityIds` of `SYSTEM_NODES` in `civic-system.ts` have no consumer.
- The Me directory's state chips for the four city adapters still all read "City selected" whatever their coverage.
- The welcome guide exists only in English and only for Strausberg; it has no registration-desk handout or QR code yet, and Places and Today still need an account, so a visitor without one cannot preview them.
- The repository and `package.json` are still named `rental-deposit-hackathon`; the product name is Ledger of Life.
