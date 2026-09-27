# Ledger of Life · one calm morning view

Build plan · 27 September 2026 · owner decisions applied after the [signed-in audit](research/LEDGER_APP_AUDIT_2026-09-27.md) and [Astra review](vision/astra-ledger-round2.md). Stadtstack's eight-city infrastructure and shared knowledge feed a personal Ledger entry point; the atlas remains the city view. This hackathon shows **test/illustrated workflows**, not real assets or returns. Private pins and interests stay on the device.

## Owner decisions, answered

- **What leads Today?** **Official city press news**: the three latest attributed headlines, dates and source links. “Nothing needs you today” is a separate second card, not the lead.
- **What belongs beyond the chosen city?** Show shared topics in an **In your region** card only when the selected city's slug appears in the published region's `cityRegions` mapping. Rank topics with local source items first, then show how many municipalities participate and link the furthest-stage source. The Brandenburg-MOL publication now supplies this context; home/work pins never leave the browser.
- **Should unreviewed interpretations appear?** Yes, in Today with **“Not yet checked”**. Official press news and sensor readings are taken over automatically with publisher, date and freshness; human editorial review is for **our own interpretations**, not automatic source facts. DeepEval Jev/hybrid and ambiguity-penalty experiments may improve triage but do not replace provenance or human correction.
- **What should finance show?** A coherent **“what your shares can do”** workflow, even with fake test stock and test tokens; borrowing, city investment, home shares and welcome vouchers can be illustrated rather than parked for legal reasons. State exactly which balances and outcomes are simulated.
- **What should Ledger reuse?** Keep `stadtstack-data`'s city feed/signals and the atlas interpretation separate from Ledger's private, device-side relevance. Do not add a new hosted city platform to build the cockpit.

## The cockpit: Today

One column on desktop and 390 px: official news **first**, then one required action, 1–3 meaningful personal changes, conditional regional topics and a quiet test-money/adapter line. No duplicate mini-dashboards, mandatory map or roadmap tile. A first visit establishes history rather than inventing unread changes; a failed check remains visibly unavailable rather than “nothing happened.”

| Order / card | Data and existing versus missing |
| --- | --- |
| 1. **Your city today** | **New:** read `feed.json` through a city-only API and show the top three official **press** headlines, publisher, publication date and outbound link. Never reproduce article text; if uncovered, show a source link or honest no-coverage state. |
| 2. **Needs you** | **Built:** `/api/journey` and `/api/listings` know tenancy/applicant steps. Show one actual action linked to Home, otherwise “Nothing needs you today”; test earnings are labelled simulated. |
| 3. **Since your last visit** | Public city signals and feed items are compared per account/city in browser storage. Review, public details, dates and precision count; version hashes and retrieval-only changes do not. News already in the three headline leads is not duplicated. At most 1–3 changes; unreviewed interpretations say **“Not yet checked”**. |
| 4. **In your region** | **Conditional:** read `out/regions/<regionId>/topics.json` only where its `cityRegions` mapping names the selected city. Show three locally ranked shared topics, municipality counts, the furthest-stage source and an own-city source when available; Places shows all topics and municipality source details. Every interpretive summary says “Not yet checked”. No pins leave the device. |
| 5. **Your things** | A quiet Home summary and complete Money total combine wallet and contract-held test positions minus open debt; if a workflow route fails, wallet-only values are visibly qualified. Never sum ETH and test USD or show a partially loaded total as complete. |

```text
TODAY                               Strausberg · city you chose
┌ Your city today: 3 official press headlines        → Places ┐
├ Needs you: one step / Nothing needs you today        → Home ┤
├ Since your last visit: 1–3 qualified changes      → Places ┤
├ In your region: 3 shared topics, own-city first*   → Places ┤
└ Your things: home status + complete test total  → Home/Money/Me ┘
* Hidden when this city has no published region
              Me | Home | Money | Places | Ideas
```

**Last visit means this device, not the publisher run.** Keep a successful baseline per account/city: prior displayed fields, `id → version`, **separate review state/revision**, own journey/adapter transitions. `changes.json` is a publication diff, not personal unread history. `common.ts` and the separate council path in `evaluate.ts` hash evidence but omit review state. Compare meaningful status, amount/year, deadline, occurrence, location, action or review—not hash churn, timestamps or quote ticks. An imported old paper is “newly available here,” not a new proposal; approaching deadlines are reminders. First/new-city visit establishes baseline; returning city restores it. Pins/interests **re-rank history**, not reset it. Acknowledge only displayed/dismissed items after successful fetch; preserve visibly stale last-good data on failure. Missing IDs may indicate lost coverage/ID migration, not withdrawal; intermediate changes between visits can be missed. Separate accounts and allow clear history. No uploaded pins/interests, read receipts or account-city join in public data; browser reset loses history and tile provider sees viewed area.

## Information architecture: one detailed home per fact

A preview in Today may point to detail, but no second editable/authoritative representation. Collapse other content until requested.

| Information | Single detail home; what to remove, merge or move |
| --- | --- |
| Adult proof, chosen city, contextual roles, wallet and connection permissions | **Me**. Say “city you chose” unless residence verified. Move read-only adapter credential/settings forms here; Home and Money show readings and link to the *one* settings location. Today shows proof only if an action requires it. |
| Current/past tenancy, agreement, deposit, claim, simulated earnings, service-charge example, home solar reading | **Home**. Money links to a deposit entitlement, not a second claim action. Me's timeline is compact history linking here. |
| Test stocks/cash, buys, validator, local-investment illustrations, share-backed deposit and loan | **Money**. Merge duplicate Solana holding and Invest/buy card; count Robinhood wallet shares/cash plus contract-held deposit and loan collateral minus debt exactly once at the test market price. Do not show a partial total while quotes or workflow positions load; if workflow reading fails, show wallet-only values and an explicit unavailable state. Test assets have no redeemable value; keep reference prices and ETH units distinct. |
| Planning/works/consultations, council **papers/meetings**, OSM places, budget facts | **Places**: one feed/list, optional three-ring map and sourced detail. Show each atlas project signal once, link curated atlas context. Pipeline OSM should replace live Overpass clubs **only after** category/coverage/ODbL parity. Put planned budget/tax explanation behind one detail; ALLRIS links are papers, not decisions. Weather/PM are dated point readings, not whole-city conditions; district/state/EU links stay optional. |
| News/events and shared regional topics | **Places** owns a single city feed with sourced headlines, publisher, publication date and link; event date appears only when `eventStart` exists, otherwise label “published <date>”. Today previews three **official press** headlines; a separate conditional regional preview links to Places detail. No full article text or invented event occurrence. |
| Roadmap and prototypes | **Ideas**, clearly separated; remove repeated “More to build in this area” and built-map cards. Keep Ideas in the mobile tab bar. |
| Personal daily priorities and previews | **Today (former Overview)** only: city press leads; one Home action; locally compared change(s); conditional regional topics; quiet things including an accurate Money total. Remove duplicate atlas city summary, “Near you” list and standalone identity tile. |

## Shares and deposit: honest illustrated workflow

**Working pieces:** Solana's signed-in test-USDC tenancy supports simulated earnings claims; its separate tSPYx buy spends wallet funds. Robinhood test actors can simulate yield and a signed test-TSLA purchase. Money's independent share workflow demonstrates a pledged illustrated deposit and a test-USD loan against shares; its test oracle price is simulated per wallet. Today only links to Money and includes those contract-held positions in its quiet total.

1. **Earn and hold:** show simulated test earnings → claim → wallet receipt → purchase of test shares, with balances and transaction order. Fungible funds cannot prove a specific earnings coin funded shares; disclose extra test funds.
2. **Show what shares can do:** for a *new* illustrated tenancy, show a landlord accepting fake test stock as deposit security, a 150% example buffer, pledged versus spendable shares and a price-change/top-up outcome. This is a workflow sketch, not a claim that today's Solana tSPYx bridges to Robinhood TSLA or that operator-held test signers are the logged-in parties.
3. **Explore borrowing separately:** an illustrated share-backed loan funds a separate test cash deposit; display debt, rate, repayment and a price-drop/liquidation example. Do not confuse a direct stock pledge with a loan. All values and outcomes stay clearly **test/simulated**.

## Source checks: automatic facts, human interpretation

Official city press headlines and sensor readings come through automatically with publisher, publication/observation date and freshness. The pipeline currently calls LLM statements scoring ≥0.8 `auto_checked`; candidate and auto-checked interpretations publish without a human gate. Around **47 interpretive concerns** among ~15,318 public records merit selective checks; do not ask humans to approve every official source fact or OSM place.

Queue **our own** low-scoring, ambiguous, conflicting or consequential interpretations, guessed locations, atlas drafts and resident corrections regardless of score. A false “already spent” budget claim scored **1.0**: truth and plan-versus-actual require deterministic source/year/amount checks. DeepEval Jev (“system one”), hybrid evaluation and `penalize_ambiguous_claims` are being tested, not assumed to have fixed the false pass. Automated results are **“Automatically checked”**; our unreviewed interpretations are **“Not yet checked”** even when shown in Today. A human editor only corrects/approves our interpretations, recording source excerpt, decision, reviewer and reason. `schema.ts` currently forbids `llm + reviewed`; separate extraction from human decision evidence before using that status. A correction updates the compact city signal too.

## Reuse rather than another platform

**Adopt:** existing `stadtstack-data` collection/cache, CCF/OParl imports, hashes, IDs/versions, rights/review/precision, GeoJSON, diffs and read-only MCP; Ledger already uses `/api/city-signals`. CCF supplies council **records**, atlas curates projects, Ledger privately ranks for daily use. [Extract a standalone Node package](research/REUSABLE_PIPELINE_COMPONENTS.md) only when another release needs it, after path/config checks.

**Keep/defer:** PDF.js, DeepEval and the deterministic budget guard. Prefer RSS/API/iCal; use Playwright only where no feed and benchmark OCR on demonstrated failures. No hosted crawler, annotation suite or portal for eight cities. [Feed checks](research/CITY_FEEDS.md) verified Strausberg official news/events, Münster/Wuppertal/Dresden official press and Köln third-party iCal; start Today with **official city press**, not arbitrary event/news aggregators. Event publication is not occurrence. VBB's checked GTFS-RT had no alert entities; do not claim disruption coverage.

## Planned-feature triage

“Now” is the current app build; “next” is a clearly labelled test/illustrated workflow; “later” needs a usable data source or design. These cover all **16** current `ideas.tsx` entries. Rollout prerequisites do not block hackathon illustrations.

| Item | When and why |
| --- | --- |
| Life timeline (partly built) | **Later** refine private dates/history once briefing is useful; keep current compact tenancy entries in Me. |
| Roles in every part of life (planned) | **Later** only when a second real shared context exists; no fake club memberships. |
| Real-time service charges (prototype) | **Later** pending usable meter/invoice data; keep the example collapsed in Home. |
| Stocks as your deposit (prototype) | **Now** a working Robinhood Chain testnet pledge, simulated price-drop top-up/protective sale and move-out claim with remaining shares returned. |
| Invest in your own city (illustration) | **Next** illustrated/test-token local investment path, clearly not a live offer. |
| Home shares towards owning (planned) | **Next** illustrated home-share accumulation and ownership milestone, not a claim of registered property. |
| Electric car and other devices (planned) | **Later** only a read-only adapter if a reliable user source is found; income tokenization parked. |
| Personal map (built) | **Now** reuse and simplify into Places' three rings; remove double atlas/OSM lists, do not rebuild map. |
| Where the money goes (partly built) | **Now** keep planned budget record/source; move statutory essay into detail. Actual spending breakdown **later** only with verified source line items. |
| From your street to the world (partly built) | **Later** extra-scale live feeds where reliable coverage exists; keep links as an optional navigation map. |
| A measurable city (partly built) | **Later** optional local observations, not a core morning card or city-wide pollution claim. |
| Council papers & meetings (partly built) | **Now** present sourced papers/meetings and official Strausberg links honestly; confirmed decisions **later** when evidenced. |
| Welcome to your new city (partly built) | **Now** OSM discovery with private interests; **next** illustrated welcome vouchers/test-token offers without partner claims. |
| Cockpit + personal last-visit changes (new) | **Now** official city press leads, personal comparison, conditional region row and quiet things. |
| City events and news (new) | **Now** official press feed in Today and dated city news/events list in Places; event start only when sourced. |
| Shared regional topics (new) | **Now** MOL topics ranked with the chosen city's source items first; counts and furthest-stage links in Today, all original source items and “Not yet checked” summaries in Places. |
| Borrow against stocks to fund deposit (prototype) | **Now** working Robinhood Chain testnet loan, per-second interest, 50 % LTV and 80 % liquidation; separate from the direct stock pledge. |

## Build order: five reviewable slices

1. **Today led by official news.** City-only feed API, three official press headlines, one existing Home action, quiet things and honest no-coverage/error states in one column at desktop and 390 px. “Not yet checked” remains visible for unreviewed interpretations. Today reads Money's public test-position values without duplicating its action flow.
2. **Meaningful return visit.** Device-side account/city baseline and acknowledgement, user-facing field/review changes (not hash churn), first/return visit, pin re-ranking and outage recovery. Add the **In your region** card when published topics exist; otherwise render no row and never upload pins.
3. **Places feed and information-architecture cleanup.** One news/events list from published city feed; attributed headline, publication date and source link; event date only with `eventStart`. Show each atlas project once, reconcile pipeline versus Overpass place categories, tuck budget explanation behind detail, rename council papers/meetings, remove duplicated roadmap boxes and use plain-language status/precision labels. Preserve mobile Ideas access.
4. **Money workflow (separate owner).** Demonstrate test earnings → shares → illustrated new-deposit pledge, then an independent share-backed loan example, with accurate test values and transitions. The new `money-area.tsx` belongs to that worker.
5. **Illustrated city/home benefits.** Test-token local investment, home-share progress and welcome vouchers in their single detail homes; expand official press and reviewed regional coverage city by city.

Stadtstack's automated source intake and experimental evaluation advance independently. Human correction remains for our own interpretation; the Ledger shows the published review state instead of waiting for an editorial gate.

## Why this sequence changed

The [first Astra pass](vision/astra-ledger-round1.md), [second pass and critique](vision/astra-ledger-round2.md) identified genuine version/review and test-actor gaps. The owner resolved the product choices: official **news leads**, regional context follows when available, **“Not yet checked”** interpretations stay visible, official facts flow automatically, and speculative financial/home benefits can be shown as honestly labelled hackathon demonstrations. Existing historical reviews retain their earlier legal and production concerns; they no longer set the hackathon build order.
