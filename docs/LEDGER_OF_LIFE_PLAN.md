# Ledger of Life · one calm morning view

Product plan · 27 September 2026 · **proposal, not an implemented redesign**. Evidence: [signed-in app audit](research/LEDGER_APP_AUDIT_2026-09-27.md), [ontology and reality levels](ONTOLOGY.md), [pipeline contract](../stadtstack-data/README.md), [reusable-tool research](research/REUSABLE_PIPELINE_COMPONENTS.md), [city-feed research](research/CITY_FEEDS.md). Stadtstack's city infrastructure/understanding/deliberation/action feeds the personal entry point; the atlas remains the city view. Eight pilot cities, no city partnership or contact required. No mainnet or real-money product is proposed.

## Your questions, answered

- **Should faithfulness make a review queue?** Yes, as **one reason to put a claim in front of a human**, never as the reviewer. A score of 1.0 missed the invented claim that planned budget money had *already been spent*. The source, date, location, rights and plan-versus-actual check matter too.
- **Is a reusable pipeline already here?** Yes: `stadtstack-data` already collects, evaluates and publishes eight cities as versioned GeoJSON, a catalogue, changes and read-only MCP. Keep it separate from Ledger and the atlas; package/extract it only when another consumer needs an independent release.
- **Where should attention go?** Back to **Ledger of Life**. Stop adding equal-weight blocks to Places; make the app a daily personal entry point into Home, Money and the person's city.
- **Can there be a cockpit?** Yes: a short **Heute** briefing with one actionable thing, what changed since *this device's* last visit, one city-feed slot and a quiet test-money/adapter line. Each card links to one detail home; no duplicated mini-dashboards.
- **What next for the deposit adapter?** First prove the signed-in Solana test-earnings claim → tSPYx buy. Separately, on Robinhood, connect app parties and a **new**, landlord-accepted test tenancy to same-chain simulated earnings → TSLA buy → TSLA pledge and loss handling. No Solana-to-Robinhood bridge or guaranteed yield. Borrowing against stocks is different and riskier, not next.
- **What about planned features?** Triage below. Preserve the working map and tenant journey, integrate city information rather than repeat it; keep unverified investments, real credit, vouchers, home tokens and device tokenization out of the near-term interface.

## The cockpit: Heute

One vertical column on desktop **and** 390 px; no mandatory map, long feeds or roadmap tiles. Nothing is “new” on first visit. Successful quiet check: “Nothing needs you today,” with a route to Places. Failed check: “Could not check,” keeping last-good data visibly stale, never claiming nothing changed.

| Order / card | Data and existing versus missing |
| --- | --- |
| 1. **Needs you** | **Built:** `/api/journey` and `/api/listings` know tenancy/applicant actions; signatures live in Home. **Missing:** one cross-area priority or honest “none”; simulated interest is *test-only*, never ordinary income. |
| 2. **Changed for you** | **Built:** `/api/city-signals` carries public ID/version, date, review and precision; `personal-map-relevance.ts` ranks near home (1 km), city and straight-line commute (~400 m) locally. **Missing:** last-visit comparison and readable qualifiers. At most 2–3 dated changes such as a new council **paper**, not “decision”; link to Places. |
| 3. **Around your city** | **Built:** atlas source links; **verified but not integrated:** official Strausberg [news RSS](https://www.stadt-strausberg.de/aktuelles/feed/) and [events RSS](https://www.stadt-strausberg.de/veranstaltungen/feed/) ([other pilots](research/CITY_FEEDS.md)). **Missing:** import/list. Show headline, **publication** date, publisher and link, not article text; no-coverage cities link to the official page. Events RSS has no structured occurrence date: do not call entries “upcoming” until that is sourced. |
| 4. **Your things** | **Built:** Home deposit/claim, Money holdings, solar and validator (`/api/journey`, `/api/portfolio`, `/api/assets`). **Missing:** one quiet test-deposit/share/earnings status and relevant adapter failure, not another portfolio. Do not sum ETH with test USD, mark a price tick unread or show a partially loaded total as complete. |

```text
HEUTE                                    Strausberg · city you chose
┌ Needs you: One real step / Nothing needs you today      → Home ┐
├ Since your last visit: 1–3 dated, qualified changes   → Places ┤
├ Around your city: source-labelled events/news or link → Places ┤
└ Your things: test deposit · test shares · adapter state → Money ┘
         Me | Home | Money | Places | Ideas
```

**Last visit means this device, not the publisher run.** Keep a successful baseline per account/city: prior displayed fields, `id → version`, **separate review state/revision**, own journey/adapter transitions. `changes.json` is a publication diff, not personal unread history. `common.ts` and the separate council path in `evaluate.ts` hash evidence but omit review state. Compare meaningful status, amount/year, deadline, occurrence, location, action or review—not hash churn, timestamps or quote ticks. An imported old paper is “newly available here,” not a new proposal; approaching deadlines are reminders. First/new-city visit establishes baseline; returning city restores it. Pins/interests **re-rank history**, not reset it. Acknowledge only displayed/dismissed items after successful fetch; preserve visibly stale last-good data on failure. Missing IDs may indicate lost coverage/ID migration, not withdrawal; intermediate changes between visits can be missed. Separate accounts and allow clear history. No uploaded pins/interests, read receipts or account-city join in public data; browser reset loses history and tile provider sees viewed area.

## Information architecture: one detailed home per fact

A preview in Heute may point to detail, but no second editable/authoritative representation. Collapse other content until requested.

| Information | Single detail home; what to remove, merge or move |
| --- | --- |
| Adult proof, chosen city, contextual roles, wallet and connection permissions | **Me**. Say “city you chose” unless residence verified. Move read-only adapter credential/settings forms here; Home and Money show readings and link to the *one* settings location. Heute shows proof only if an action requires it. |
| Current/past tenancy, agreement, deposit, claim, simulated earnings, service-charge example, home solar reading | **Home**. Money links to a deposit entitlement, not a second claim action. Me's timeline is compact history linking here. |
| Test stocks/cash, buys, validator, local-investment illustrations | **Money**. Merge duplicate Solana holding and Invest/buy card; do not show the partial $1.16 total while quotes load. Test assets have no redeemable value; keep reference prices and ETH units distinct. |
| Planning/works/consultations, council **papers/meetings**, OSM places, budget facts | **Places**: one feed/list, optional three-ring map and sourced detail. Show each atlas project signal once, link curated atlas context. Pipeline OSM should replace live Overpass clubs **only after** category/coverage/ODbL parity. Put planned budget/tax explanation behind one detail; ALLRIS links are papers, not decisions. Weather/PM are dated point readings, not whole-city conditions; district/state/EU links stay optional. |
| News/events | **Places city feed**, from `stadtstack-data` RSS/ICS with stable ID, publisher, rights and separate publication/occurrence dates; Heute previews once. Strausberg event headlines are *published items*, not “upcoming” without verified start dates. Köln iCal is third-party with past items; uncovered cities get honest source links/empty states. |
| Roadmap and prototypes | **Ideas**, clearly separated; remove repeated “More to build in this area” and built-map cards. Mobile Ideas already has an in-area link—preserve it when removing repeated cards; consider a visible navigation route. |
| Personal daily priorities and previews | **Heute (former Overview)** only. Replace separate atlas city summary **plus** “Near you” list with one qualified change card; no standalone identity tile or duplicated portfolio total. |

## Deposit adapter: real demo steps and legal boundary

**Today:** Solana's signed-in test-USDC tenancy funds a devnet deposit and supports tenant-signed claims (`home.tsx`, `journey.ts`); yield is **simulated**, not organic. `portfolio.ts` buys wallet-funded tSPYx but does not establish earnings provenance. Separate `robinhood-demo.ts` uses operator-held escrow signers, simulated yield to a user's EVM wallet and signed test-TSLA buy. Home Test tools trigger earn; Money buys TSLA. `CollateralEscrow.sol` is an unreviewed prototype, **not** a signed-in pledge tenancy; a script exercised 150% pledge, price drop/top-up, sale and return with test oracle/desk ([evidence](IDEAS_EXPLORATION.md)).

1. **Solana signed-in handoff first:** simulated yield → tenant-signed claim → own-wallet receipt → tSPYx purchase; show finalized transactions and balances. UI fixes purchase at five test USDC though server accepts an amount. Fungible funds cannot prove particular earnings funded shares: disclose extra test cash and trace amounts/order, not a coin.
2. **Separate Robinhood story:** deploy an agreement-backed earnings escrow with actual app party signatures; test earn → claim → wallet → selected-amount official test-TSLA buy. Landlord explicitly accepts **those TSLA** for a *second, new* tenancy; tenant pledges them once in `CollateralEscrow`. Show illustrative 150% quote and extra test funding. Today's escrow signers are immutable operator-held actors; the buy spends the entire test-dollar balance. Neither can be relabelled a signed-in tenant journey. Solana tSPYx does **not** bridge into TSLA.
3. **Protection loop:** staged 25% drop → shortfall/grace → top-up or **pre-move-out protective sale**; later an approved move-out claim may require a separate bounded sale and remaining-share return. Bind agreement digest/consent, isolate payouts, and define test oracle/desk, custody and recipient failure behavior. Test failed sale, closed market and gap beyond buffer; scripted contract mechanics are not a signed-in journey or guarantee.

**Germany, before any real offer:** [§551 BGB](https://www.gesetze-im-internet.de/bgb/__551.html) caps residential security at three net rents, separates entrusted cash and says interest belongs to the tenant **and increases security**. Early withdrawal and a 150% pledge need housing-law review; landlord consent/calculator is not clearance. Commercial lending may need [§1](https://www.gesetze-im-internet.de/kredwg/__1.html)/[§32 KWG](https://www.gesetze-im-internet.de/kredwg/__32.html) authorization; brokerage may need [§34c GewO](https://www.gesetze-im-internet.de/gewo/__34c.html). Frontend obligations are **unverified**; a licensed partner is not automatic cover. Borrowing adds rate-dependent carry, liquidation and suitability risk, not universal negative spread. Pledges add oracle, market, issuer, slippage and gap risk. No mainnet/real money without counsel, permissions and reviewed contracts.

## Review queue: faithfulness is a flag, not a verdict

`evaluate.ts` marks LLM claims ≥0.8 `auto_checked`; `publish.ts` emits candidates and auto-checked items **without human approval**. Eight-city output has ~15,318 records (10,654 OSM, 2,835 planning/works, 741 motorway, 1,062 council, 24 atlas, 2 budgets). About **47 flagged interpretive concerns** (5 LLM statements, 18 guessed streets, 24 atlas projects) overlap 46 records; the rest are not human-certified. Review consequential claims selectively, not every place.

Queue missing/failed evaluations, low scores, **consequential interpretations at any score**, guessed locations, atlas drafts, conflicts, risky budget/council/consultation claims, resident errors and rights/date uncertainty. Calibrate thresholds against humans: a false “already spent” claim scored **1.0**. Faithfulness cannot establish truth, plan-versus-actual, location or rights; it scores `statement`, **not** generated `nextStep` or location. Keep deterministic year/amount/source checks and human decisions separate from `auto_checked`.

An assigned **Stadtstack/atlas editor** checks source excerpt/page/hash, wording/next step, dates, plan-versus-actual, precision, rights and prior decision; logs approve/reject/correct, reviewer, time and reason **scoped to supporting evidence**. Reopen if support changes materially, not on unrelated batch-hash churn; double-check consequential claims. `schema.ts` forbids `llm + reviewed`: preserve extraction method, add independent human decision evidence, update schema/publication and compact projection first. Pipeline owns intake/decisions, atlas owns project interpretation, Ledger consumes qualified records and routes error reports; no annotation suite ([research](research/REUSABLE_PIPELINE_COMPONENTS.md)). Label low-risk candidates; hold/qualify consequential claims. **Owner must assign approver and response time.**

## Reuse rather than another platform

**Adopt:** existing `stadtstack-data` collection/cache, CCF/OParl imports, hashes, IDs/versions, rights/review/precision, GeoJSON, diffs and read-only MCP; Ledger already uses `/api/city-signals`. CCF supplies council **records**, atlas curates projects, Ledger privately ranks for daily use. [Extract a standalone Node package](research/REUSABLE_PIPELINE_COMPONENTS.md) only when another release needs it, after path/config checks.

**Keep/defer:** PDF.js, DeepEval and deterministic budget guard. Prefer RSS/API/iCal; Playwright only without feeds, Docling/OCRmyPDF only after failing-document benchmark. No hosted crawler, annotation suite, portal or workflow service for eight cities; schedule/DCAT after owner/rights gate. [Feed checks](research/CITY_FEEDS.md): Strausberg official news/events, Münster/Wuppertal/Dresden press and Köln third-party iCal work; **no full-text licence proven**. No verified machine feeds for Castrop-Rauxel/Düsseldorf/Freiburg. VBB's CC BY 4.0 snapshot has 6,485 trip updates but **zero alerts**; no disruption feed claim. No verified civic Nostr publisher.

## Planned-feature triage

“Now” means tighten working truth or build next briefing slice; “next” follows the first briefing; “later” needs an identified source/partner; “park” has no justified near-term implementation. These cover **all 13** entries in `ideas.tsx` plus the owner's additions.

| Item | When and why |
| --- | --- |
| Life timeline (partly built) | **Later** refine private dates/history once briefing is useful; keep current compact tenancy entries in Me. |
| Roles in every part of life (planned) | **Later** only when a second real shared context exists; no fake club memberships. |
| Real-time service charges (prototype) | **Later** pending authorized meters, real invoices and legal payment design; keep example collapsed in Home. |
| Stocks as your deposit (prototype) | **Next** test-only Robinhood pledge/landlord acceptance after earn→buy continuity; not a production security offer. |
| Invest in your own city (illustration) | **Park** current leads as labelled background; no offers until provider/rights/licensed partner. |
| Home shares towards owning (planned) | **Park**: legal issuer, notary and land register cannot be bypassed by a token. |
| Electric car and other devices (planned) | **Later** only a read-only adapter if a reliable user source is found; income tokenization parked. |
| Personal map (built) | **Now** reuse and simplify into Places' three rings; remove double atlas/OSM lists, do not rebuild map. |
| Where the money goes (partly built) | **Now** keep planned budget record/source; move statutory essay into detail. Actual spending breakdown **later** only with source/rights. |
| From your street to the world (partly built) | **Park** extra-scale live feeds; keep links only behind “Explore further.” |
| A measurable city (partly built) | **Later** optional local observations, not a core morning card or city-wide pollution claim. |
| Council decisions (partly built) | **Now** rename/present available council *papers/meetings* and official Strausberg links honestly; confirmed decisions **later** when evidenced. |
| Welcome to your new city (partly built) | **Now** one OSM place discovery with private interest ranking; registration/vouchers **park** without partners. |
| Cockpit + personal last-visit changes (new) | **Now**: owner's daily-use question; no city back-office dependency. |
| City events and news (new) | **Next** Strausberg RSS → headline, **publication** date and link; event start needs separate source. No full text without rights. Köln iCal expansion requires recurrence/exception/cancellation/timezone handling. |
| Borrow against stocks to fund deposit (new) | **Park**: consumer-credit permissions, rate-dependent carry and liquidation risk; distinct from a landlord's acceptance of pledged shares. |

## Build order: five independently demoable slices

1. **Heute, calm first.** Replace Overview's five equal-weight previews with one actionable tenancy/empty state and small linked Home/Money/Places summaries; remove repeated page-level pitches. Show desktop and 390 px with honest test/review labels.
2. **What changed for *this* device.** Compare meaningful fields and review state, not hash churn; demo same-ID correction, review-only change, return/city switch, changed pin, silent re-fetch, disappearing signal and outage recovery without leaked coordinates.
3. **Strausberg city-feed card.** Add news headlines from verified official RSS to `stadtstack-data`'s public output (new feed schema/input) and one Places list with a Heute preview. Show only headline, publisher, **publication** date and outbound link. Its events RSS is real but carries `pubDate`, **not occurrence dates**: first show items as event-page links; list as upcoming/filter expired only after obtaining a verifiable event start from source pages. No article text, outreach or fabricated city coverage.
4. **Signed-in Solana earn → invest.** Exercise the current tenancy's simulated yield, tenant-signed claim, wallet receipt and test tSPYx purchase with reconciled amount and balances. Extra wallet cash must be explicit; do not pretend share provenance from fungible tokens.
5. **Agreement-backed Robinhood earn → TSLA.** New test escrow with real app party signatures → simulated yield → tenant claim → selected-amount official TSLA buy and reconciled holding. This is a second chain and a second signed-in proof, not a bridge or a completed stock deposit.

**Next finance milestone, not hidden in slice 5:** landlord accepts a **second, new** test agreement backed by the same TSLA; signed pledge, price-drop/top-up, pre-move-out protection, approved claim/settlement and in-kind return with mock oracle/desk. Fix agreement binding and payout/failed-sale behavior first. No live yield/protection or borrowing shortcut.

A **small Stadtstack review/decision queue** can run in parallel once an editor is designated; demo a high-risk claim correction under the same public ID with changed content version **or separate review revision** reaching atlas and Ledger's compact projection. Current version paths omit `reviewState`, so review-only decisions need their own marker. It need not block Heute but must precede calling interpretations human-reviewed.

## Second opinion and decisions for the owner

Astra's [first pass](vision/astra-ledger-round1.md), my critique and its [second pass](vision/astra-ledger-round2.md) shaped this plan. It caught version/review schema gaps, Solana versus Robinhood test-actor separation and §551 interest rules. I rejected first-pass **cleanup-before-cockpit**: bound de-duplication inside the first visible Heute slice. Updated evidence overturns its HTML-only Strausberg claim: RSS works, but event publication is not occurrence. I accepted round two's split of the oversized Robinhood pledge journey. A mock oracle/desk can demonstrate test mechanics, never qualify real security. Reconcile stale ontology timeline/identity/budget/legal claims alongside implementation, not as a cockpit gate.

1. On a quiet morning, should Heute lead with “Nothing needs you,” or one current city headline without an unread badge?
2. After the Strausberg headline pilot, should the three verified municipal press feeds precede Köln's third-party recurring-events calendar? Should publication-dated Strausberg event links appear before occurrence dates are verified?
3. Should high-consequence, still-unreviewed interpretations be omitted from Heute, with qualified source access in Places, or shown there as explicit candidates?
4. Who owns Stadtstack editorial approval and correction responses, and what response time is realistic?
5. Which actual tenant/landlord app participants will sign the Robinhood test agreements, explicitly accept stock collateral, and agree to the disclosed extra test funding? (Not legal approval.)
