# Ledger of Life · household and adapter implementation plan

Build plan · updated 28 September 2026. The current direction is **find a home, keep your assets, help build your city**. A household ledger is the foundation; native test investment and a visual city make the connection tangible. Public observations, fictional issuers and modeled physical effects remain distinct. Private pins, interests and follows stay device-local.

## Hackathon priority: one connected, demonstrable story

The current [Crypto World's Fair rules](https://colosseum.com/legal/Crypto%20World%27s%20Fair%20Hackathon%20Rules.pdf)
judge functionality, impact, novelty, UX, open-source composability and business viability.
Both Solana and Robinhood Chain are supported tracks. A working, understandable capital-to-place
demonstration is stronger than many disconnected dashboards or speculative revenue widgets.

1. **Find a home.** Photo-led listings → application → agreement → the actual tenancy deposit.
   The existing Solana tenancy uses test USDC; a share pledge does not silently replace it.
2. **Keep shares working.** Choose a separate Robinhood share-backed test deposit, or borrow
   test USD against shares. These are different contracts and risks. No upfront sale is required;
   collateral is locked, and claims/shortfall/liquidation can still cause a sale.
3. **Build a local stake.** Use the same Robinhood test USD for distinct `tHOME` and `tWORK`
   units in fictional housing/workshop issuers. Each spend has an amount review, exact wallet
   approval and checked on-chain receipt. No bridge, mortgage, real company equity or land title is implied.
4. **See the place.** Explore the OSM 3D city, published planning areas and local places;
   follow a real public project, or deliberately switch to the separately labelled test-issuer layer.
5. **Use local infrastructure.** A real local Qwen node answers through paid x402 access or a
   wallet-free public library desk. Me, the building's GPU option and the library profile all
   open this working service. Record usage and settled receipts; keep euro cost scenarios separate.

The connected rehearsal now uses a fresh real Privy passkey wallet: two tTSLA shares →
collateral → 12 tUSDG borrowed → 5 tHOME + 5 tWORK → a 0.01-tUSDG local AI answer (the former flat price; now 0.0001 tUSDG per output token, at most 0.0192).
The final cash is 1.99 tUSDG and the loan remains owed. The dedicated preparation signer
never puts test cash directly in this buyer's wallet. See [executed evidence](evidence/BORROW_TO_LOCAL_AI_ROBINHOOD_TESTNET.json)
and `VALIDATION.md`; existing funded tenancies and earlier investment positions are not reused.

One compact **Demo mode** control supplies workspace context. Keep network, amount,
ownership rights and source limitations in the relevant review/details, not repetitive banners.

### Physical and economic realism

- **Solar and heat pumps:** credible core building systems, not free-energy promises. Roof,
  seasonal demand, grid connection, financing, maintenance and tariffs affect the outcome.
  [Fraunhofer ISE's field study](https://www.ise.fraunhofer.de/en/press-media/press-releases/2025/fraunhofer-ise-research-project-completed-heat-pumps-provide-climate-friendly-heating-in-existing-buildings.html)
  demonstrates varying efficiency and partial solar autonomy, not a forecast for our fictional building.
- **Validators:** optional infrastructure requiring staking capital, reliable operations and security.
  A watched validator ID is not ownership, and validator revenue is not assumed in the housing economics.
- **GPU service:** real Ollama inference and settled test-token payments are implemented.
  Per-request measurements are observations; the euro planner's price, customer demand,
  whole-host power, hardware allocation and other costs are editable assumptions.
  A short ~53-output-token/s observation is not a sustained revenue forecast.
- **Heat reuse and physical co-location:** remain project-specific ideas. [IEA's heat-recovery analysis](https://www.iea.org/commentaries/opportunities-for-district-heating-in-the-changing-energy-landscape)
  emphasizes location, temperature, timing and a viable business model.
- **City flywheel:** local capital could support homes/firms, work and services, attractiveness,
  residents and a tax base for public infrastructure. More residents also create public costs;
  debt, vacancies, affordability, planning and fiscal rules can break the loop. No jobs or taxes
  are inferred from test-token purchases.

### What the city data can support now

OpenFreeMap's existing Liberty style supplies OSM building extrusions; rendered heights can be
estimated. Published project areas stay flat source geometry, not invented future buildings.
Four independent Strausberg organizations have sourced services and participation links:
SWG, Stadtwerke, STEMME and Heinrich-Mann-Bibliothek. STEMME's product page, published
career listings and invitation to join its sales/service network are linked directly.
Only the documented SWG/Stadtwerke shared-group relation is shown; no supply contract,
issuer affiliation or hiring guarantee is inferred.

The event feed now retains publisher record IDs, sourced event times, venue text, optional
coordinates, precision and location provenance. Kürbisfest record `30366` is dated
30 October 2026, 15:00 Berlin time; its approximate point uses the Marienkirche OSM footprint.
Other records without sourced coordinates stay unlocated. Publication dates never substitute
for event time, and the separate `30334` event is not merged into it.

**Next useful data work:** extend verified venue coverage, keep published opportunities
current, and work with a willing real housing/energy partner. Do not infer a city-wide supply
chain or advertise real investments without issuer authority and defined rights.


## Owner decisions, answered

- **What leads Today?** A five-domain household overview: Identity, Home, Money, Energy/devices and Places. An actionable Home prompt may precede it. Official city press, followed developments and compact chosen-city changes remain below; civic work is one part of the ledger.
- **What belongs beyond the chosen city?** Places keeps original source stages for neighbouring municipalities in an expandable comparison. Its project selector, Map, Outcomes and Connections share one city/project identity. Geometry is published context only; unlocated topics do not receive polygons or pins. Home/work pins never leave the browser.
- **Should unreviewed interpretations appear?** Yes, visibly **“Not yet checked”** with source and date; official press and sensor publisher facts are automatically attributed, not confused with human approval. Editorial review belongs to our interpretations. Evaluation experiments do not replace provenance or human correction.
- **What should finance show?** A priced-test-assets subtotal and separate project-unit holdings. Issue price is not a resale/market quote; shared test cash is counted once. Home/holdings/pledge/loan/investment links reach exact destinations. Collateral and debt remain distinct; approval alone is not a purchase, and deployment hashes are not personal transactions. No Solana–Robinhood bridge is implied.
- **What should Ledger reuse?** Keep `stadtstack-data`'s city feed/signals and the atlas interpretation separate from Ledger's private, device-side relevance. Do not add a new hosted city platform to build the cockpit.
- **What should the public data become?** An increasingly useful versioned, source-attributed civic knowledge base reused by Ledger, atlas and MCP, demonstrating why interoperable municipal open data is valuable. Preserve URLs/locators, source dates where known, municipality, separate stages, review state, precision and rights. Do not pursue volume for its own sake, fake comparisons/statistics, a new ingestion/database project or an implied municipal endorsement.

## The daily entry point: Today

One household overview connects the working areas. It shows account/wallet context, Home state, the priced-test-assets subtotal, saved device connections and public-life entry points. Share-backed deposit and loan shortcuts select the Money panels without signing. **Explore & follow projects** opens Places. Source failures, unpriced holdings, test assets and planned capabilities remain explicit.

| Order / section | Published or personal evidence |
| --- | --- |
| 1. **Attention, only when needed** | `/api/journey` and `/api/listings`: an actionable step links to the exact tenancy where known; a failed Home read stays visible, not a false quiet state. |
| 2. **Five-domain ledger** | Shared topic catalogue; actual account, saved proof, tenancy and redacted configuration states. Money reuses the complete-snapshot valuation. Configured is not healthy, linked is not funded, and roadmap items do not appear connected. |
| 3. **Official city press** | One lead and up to two secondary source links, with publisher/date and honest no-coverage or refresh failure. |
| 4. **Followed projects, if any** | Device-local account-scoped first-follow baseline, at most two unread developments and exact Places review links. Missing sources remain unavailable; unread changes require explicit acknowledgment. |
| 5. **Personal changes** | Browser-local account/city comparison of published signals/feed; this visit baseline remains separate from durable followed unread state. |
| 6. **Conditional civic preview** | Source-linked chosen-city outputs and explicit unknown outcomes. The historical Münster 2021 bus comparison appears here only for chosen Münster; it remains discoverable in Places for everyone. |

**Last visit means this device, not the publisher run.** The existing chosen-city visit-diff stores displayed public signal/feed fields per account/city and advances its whole successful city/feed baseline eagerly. It is a compact visit comparison, **not** an unread queue: changes to off-screen items or multiple intermediate publications can be missed. `changes.json` is a publisher diff, not personal history; hashes, generatedAt and retrievedAt are not project developments. Saved pins/interests re-rank rather than reset history. **Following uses a separate per-target account/city store** with a first-successful-source baseline and individually acknowledged pending transitions; an outage, 404 or another target's successful refresh never clears unread followed updates. Only public city/signal IDs leave the browser, not local follow state, pins, interests or read receipts. Browser reset loses these local histories; tiles reveal viewed area to the tile provider.

## Information architecture: one detailed home per fact

A preview in Today may point to detail, but no second editable/authoritative representation. Collapse other content until requested.

| Information | Single detail home; what to remove, merge or move |
| --- | --- |
| Adult proof, contextual roles, wallet and adapter permissions | **Me** owns the shared catalogue and Home Assistant/validator save/remove forms. Money → Devices & income shows their readings and links to that one configuration location. Today shows compact account/proof context, not account management or a proof dashboard. |
| Current/past tenancy, agreement, deposit, claim, simulated earnings, service-charge example | **Home**. Money links to a deposit entitlement, not a second claim action. Me's timeline is compact history linking here. Service charges read the same Home Assistant consumption that Money → Devices & income shows. |
| Test stocks/cash, buys, share-backed deposit and loan, local-investment units, home solar and validator readings | **Money**: Holdings, Shares & loans, Local stakes, Devices & income. One Solana holding includes its buy control. Robinhood wallet shares/cash plus contract-held deposit and loan collateral minus debt count once at the test market price; official test TSLA, fake tTSLA and Solana tSPYx never imply a bridge. On a failed read preserve the last complete total with a dated unavailable state, and show healthy quantities/cash independently rather than reclassifying a missing value as zero. ETH remains a separate unit. Solar and validator readings are outside the priced subtotal. |
| Local AI access, usage and host economics | **Money → Devices & income → Local AI & GPU hosting** owns personal payment reviews, answers, receipts and measured host totals. `/library` is the wallet-free shared desk; Me and Places link here. A euro scenario never becomes a wallet balance or settled income. |
| Planning/works/consultations, council papers, OSM places, budget facts and outcomes | **Places**: one selected city/project/topic across existing MapLibre geometry, output/indicator mini-charts and documented actor relations. Münster 2021 pilot's 500 m reported lane, €60k forecast versus provisional ~€42k spent by end-2021, and 251→235 s full-route observed bus running-time means are sourced to official PDF pages; no final cost/funding source, invented route or causal benefit. Unknown geometry stays off map; planned boundaries are not affected areas. Published signal stages and source URLs/locators stay in evidence drawers; weather/PM is independent context. |
| News/events and regional topics | **Places** owns sourced feed and expanded per-municipality stage/evidence. Today keeps official news, the chosen-city project preview when linked and Münster historical evidence only for chosen Münster or explicit followed relevance. Event dates appear only when `eventStart` exists. |
| Capabilities and roadmap | **Ideas** shows all 18 capability IDs/statuses. Definitions live in `src/data/ledger-catalogue.ts`, grouped into the same five topics as Me and Today by `Idea.topic`, with one working destination (`Idea.destination`) and adapter links. Placement rule: [INFORMATION_ARCHITECTURE.md](INFORMATION_ARCHITECTURE.md). |
| Personal daily priorities and previews | **Today** owns the household-first overview and relevant developments, not a second editable workflow or project dashboard. |

## Shares and deposit: honest illustrated workflow

**Working pieces:** Solana's signed-in test-USDC tenancy supports simulated earnings claims; its separate tSPYx buy spends wallet funds. Robinhood test actors can simulate yield and a signed test-TSLA purchase. Money's independent share workflow has working test contracts for a pledged illustrated deposit and test-USD loan against fake tTSLA; existing legacy positions may use official test TSLA. Its oracle price is simulated per wallet. Today links to the correct deposit/loan panel and counts contract-held positions and debt once.

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

“Now” is the current app build; “next” is a clearly labelled test/illustrated workflow; “later” needs a usable data source or design. All 16 original capability IDs remain in the shared catalogue; the previously documented bank adapter is now also visible as a planned Ideas entry. Rollout prerequisites do not block honest hackathon illustrations.

| Item | When and why |
| --- | --- |
| Life timeline (partly built) | **Later** refine private dates/history once briefing is useful; keep current compact tenancy entries in Me. |
| Roles in every part of life (planned) | **Later** only when a second real shared context exists; no fake club memberships. |
| Real-time service charges (prototype) | **Later** pending usable meter/invoice data; keep the example collapsed in Home. |
| Stocks as your deposit (prototype) | **Now** a working Robinhood Chain testnet pledge, simulated price-drop top-up/protective sale and move-out claim with remaining shares returned. |
| Invest in your own city (testnet prototype) | **Now** wallet-signed Robinhood test-USD purchases of separate fictional `tHOME`/`tWORK` units, actual holdings and checked receipts. Real cooperative leads remain unverified offers; physical impacts stay illustrative. |
| Home shares towards owning (planned rights; test-unit demonstration) | **Now** demonstrate a fractional test-issuer stake. **Later** a real issuer/legal wrapper, defined housing rights or down-payment credit and the necessary property transaction. Test units grant none of those rights. |
| Electric car and other devices (planned) | **Later** only a read-only adapter if a reliable user source is found; income tokenization parked. |
| Personal map (built) | **Now** map-first Places using existing 2D/3D OSM context, source-backed project/place selection, prominent Follow and an explicitly separate fictional-issuer overlay. No guessed building ownership or impact geometry. |
| Where the money goes (partly built) | **Now** keep planned budget record/source; move statutory essay into detail. Actual spending breakdown **later** only with verified source line items. |
| From your street to the world (partly built) | **Later** extra-scale live feeds where reliable coverage exists; keep links as an optional navigation map. |
| A measurable city (partly built) | **Later** optional local observations, not a core morning card or city-wide pollution claim. |
| Council papers & meetings (partly built) | **Now** present sourced papers/meetings and official Strausberg links honestly; confirmed decisions **later** when evidenced. |
| Welcome to your new city (built for Strausberg) | **Now** a public, account-free guide at `/welcome/<city>`: a sourced first-months plan, what is on, clubs and who to ask, personalised on the device; plus OSM discovery in Places. **Next** a German version, a registration-desk handout, more cities, and illustrated welcome vouchers/test-token offers without partner claims. |
| Ledger overview + personal last-visit changes (built) | **Now** five-domain household overview, exact working actions, honest connection states, official press and private meaningful changes. No duplicate financial calculation or global proof panel. |
| City events and news (partly built) | **Now** attributed source shelf and feed, with event time only when sourced. **Next** verified venue coordinates and temporal enrichment before event pins or calendar assertions. |
| Shared regional topics (new) | **Now** local and named neighbouring municipality source items with separate stages and dates where supplied; all original source items and “Not yet checked” interpretations in Places. |
| Borrow against stocks to fund deposit (prototype) | **Now** working Robinhood Chain testnet loan, per-second interest, 50 % LTV and 80 % liquidation; separate from the direct stock pledge. |
| Bank accounts (planned) | **Later** after a permissioned provider and consent model are chosen; currently only a roadmap entry, with no bank connection, import or payment. |

## Approved UX composition · current slice

1. **Today:** household-first overview; actionable Home prompts when relevant; official news and at most two pending followed developments below; selected-city changes and a conditional historical example. No civic diagram takes over the landing page.
2. **Home → Money:** Home is the visual housing journey, photo-led browsing, one role-specific next step and exact tenancy links, with nothing from Money. Money answers "what do I own, owe and earn" in four tabs: Holdings first, then Shares & loans, Local stakes and Devices & income, each stating its reality level. The actual Solana cash-deposit and separate Robinhood share workflows remain distinguished; Home keeps one link to the share-backed deposit.
3. **Places/Ideas:** a persistent map with 2D/3D controls, concise story choices and one selected detail sheet. Real public-project Follow is a header/map-detail action. OSM heights may be estimated, plans are not built structures, and fictional test issuers never enter public follow baselines. Existing evidence/outcomes and capability IDs remain accessible.
4. **Me adapters:** one five-topic directory of 19 sources and 18 capabilities, with source/environment/authority and runtime connection states. `GET /api/adapters` reads redacted configuration without provider probes; authenticated same-origin POST saves/removes the chosen connection. Token fields never hydrate secrets. Home and Money link here instead of hosting duplicate forms.

Grow the existing published civic knowledge base for usefulness and provenance rather than volume; Ledger, atlas and MCP may consume its attributed versions. A compelling sourced comparison can invite municipalities to publish interoperable open data, without claiming their endorsement or launching another ingestion/database project.

## Why this sequence changed

The earlier [Astra passes](vision/astra-ledger-round1.md) and [critique](vision/astra-ledger-round2.md) informed the news, source-review and test-actor work. The latest correction supersedes the news-first composition: Ledger must show the full household/adapters product and keep advancing its working features. Public facts still flow automatically with provenance, interpretations remain “Not yet checked” where appropriate, and speculative benefits stay explicitly test/simulated or planned.
