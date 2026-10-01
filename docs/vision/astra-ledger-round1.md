# Astra · Ledger round 1

Read-only second opinion on the initial draft and signed-in audit; source notes and proposed changes, not implemented changes. Tool transcript omitted.

## Verdict: finish the personal product

Build the morning cockpit and complete **earn → portfolio**. Add a small Stadtstack review queue alongside that work. Faithfulness should inform its priorities; it cannot replace its human owner.

The draft identifies duplication correctly, but understates missing workflow and trust machinery. The [signed-in audit](../research/LEDGER_APP_AUDIT_2026-09-27.md) and source show three problems:

- **Places combines unrelated jobs:** personal relevance, atlas interpretation, measurements, another OSM directory, budget explanation, council links and roadmap. Atlas projects, OSM places and budget amounts recur through different paths.
- **Money repeats holdings without completing the journey:** `AssetsOverview` and `Portfolio` both display tSPYx; Home, Money and Overview repeat deposit facts while claim-to-invest remains disconnected.
- **Words change meaning between components:** city-boundary clubs become “near you”; papers become “decisions”; dated research becomes “latest”; pending editorial review becomes “not yet reviewed by the city”.

This is an ownership and semantics problem, not simply excessive cards. Preserve useful previews, but give each fact one authoritative detail and each action one workflow.

Also reconcile the stale ontology entries: timeline, identity and budget descriptions contradict implemented features. Both ontology files need correction before further concepts are added.

## A calm morning, with one home per concept

Use four vertically ordered sections, including at 390px:

1. **Needs your attention:** one required tenancy action, with an indication of other outstanding actions. Optional earnings claims rank below required responses. Otherwise show a waiting state or “Nothing needs your attention”. Failed data must say “Could not check”.
2. **Changed for you:** at most three meaningful changes, including newly published proposals and approaching participation deadlines. Explain relevance: neighbourhood, city or approximate commute. An imported historical plan is “newly available here”, not a new proposal.
3. **In your city:** at most two dated events/news entries, then “Open city feed”. Distinguish official notices, council records and editorial news.
4. **Your money and connections:** one quiet test-money summary; configured-adapter problems surface when actionable. Keep validator units separate. Healthy identity, weather and connector configuration belong in detail.

Carry reality, source/date, review and location precision into these previews using plain language. Numeric faithfulness scores belong in source detail.

**Home** owns agreements, security, earnings claims, settlement, service charges and energy. **Money** owns holdings, orders and any future debt; deposit detail links to Home. **Places** owns the public stream, map, sources and participation links. **Me** owns identity, contextual roles, compact history and connection permissions. **Ideas** owns remaining proposals and needs a reachable mobile link. Overview owns no duplicate records.

Remove the separate atlas list, repeated budget essay and repeated roadmap boxes. Retire the second Overpass directory after category/coverage parity and ODbL checks.

Pilot events/news in Strausberg using its [public calendar](https://www.stadt-strausberg.de/veranstaltungen/) and [news archive](https://www.stadt-strausberg.de/aktuelles/). Neither is an integrated feed today. Add event/news types upstream, with canonical URLs, publication time, event time/timezone, cancellation status, attribution, reuse basis and freshness limits. Until qualified, offer source links. Do not contact cities for coverage.

## “Since last visit” needs an actual definition

The draft’s local ID/version baseline is a start, but **changed hash does not mean meaningful change**. Current [version generation](../../stadtstack-data/src/common.ts) includes evidence hashes and omits review state: changed batch responses can churn records, while human review alone can remain invisible.

Keep a per-account, per-city baseline on this device: publication identifier, ID/version, relevant display fields, review revision and last successful visit. Compare successful snapshots; separately acknowledge displayed item versions. Downloading the whole city must not mark everything personally read.

First visit establishes a baseline. City switches preserve separate baselines. Changed pins/interests create new relevance, not new public facts. Suppress technical churn and distinguish source dates from retrieval dates. Disappearance means unavailable unless explicit evidence supports cancellation or withdrawal.

Publisher `changes.json` covers the preceding publication only. Neither it nor local comparison reconstructs intermediate events missed between visits. Cleared storage, another device, partial feeds and outages limit continuity.

The three rings already exist: 1km neighbourhood, citywide matters, and a 400m corridor around a straight home–work line. This is not route-aware commuting. LocalStorage is not a secure vault; tiles disclose viewed areas. The server also sees selected cities and requested public-item IDs, although pins/interests remain local.

## Complete the money story without inventing a bridge

**Built:** Solana tenancy/escrow operations, simulated earnings release and wallet-funded tSPYx purchases; Robinhood test earnings and signed TSLA purchases. **Missing:** their continuous signed-in journey, collateral tenancy UI and borrowing.

The draft needs greater precision. Solana’s button spends five test USDC, although [the server](../../src/server/portfolio.ts) accepts variable amounts. The [Robinhood helper](../../src/server/robinhood-demo.ts) uses operator-controlled tenancy parties and releases into the user’s wallet; its purchase spends the entire test-dollar balance. Neither proves that purchases use only earnings. The audit’s $0.25 was already claimed.

First deliver Solana: **simulated yield credit → finalized claim → wallet receipt → selected investment amount → signed buy → finalized holding**. Link receipts, quote time, quantities and fees. Describe earmarked amounts honestly; fungible cash has no intrinsic earnings identity. Pending/unavailable balances must not produce apparent wealth changes.

Then demonstrate Robinhood collateral for a separate new test tenancy. Both chains remain allowed per feature; delete the draft’s reopened chain-choice question. There is no implicit conversion or migration of the existing Solana deposit.

Distinguish two products:

- **Direct pledge:** existing test TSLA enters collateral escrow; the landlord accepts alternative security. No loan exists. Mark pledged holdings unavailable and count them once.
- **Borrowing:** a lender takes stock collateral, lends cash, and that cash funds a separate rental escrow. Track debt, interest, maturity, repayment and liquidation independently. Deposit return does not automatically repay the loan.

[CollateralEscrow](../../contracts/evm/src/CollateralEscrow.sol) is more consequential than the draft admits. Shortfall liquidation can precede any move-out claim; exhausted collateral leaves the landlord short. Its example 150%/125% ratios are configurable. Illustratively, $1,500 collateral against $1,000 security reaches maintenance after a 16.7% fall. It also lacks agreement acceptance/hash binding and uses combined push settlement rather than isolated pull payouts. Stale-oracle, failed-sale and blocked-recipient behavior require resolution before integration.

German launch risks affect the core story too. **§551 BGB says earnings increase security**, alongside the three-month rent cap and separation requirement. Immediate earnings release is therefore not an established statutory entitlement. A 150% pledge/top-up requirement may conflict with the cap; landlord agreement alone does not resolve that. Preserving a nominal release threshold also cannot guarantee against investment losses. [§551 BGB](https://www.gesetze-im-internet.de/bgb/__551.html)

Commercial lending generally raises [KWG lending](https://www.gesetze-im-internet.de/kredwg/__1.html) and [permission](https://www.gesetze-im-internet.de/kredwg/__32.html) requirements; intermediation may require [§34c GewO](https://www.gesetze-im-internet.de/gewo/__34c.html) permission. Consumer lending can require [creditworthiness checks](https://www.gesetze-im-internet.de/bgb/__505a.html). Token/custody/securities activities need separate classification; a licensed counterparty does not automatically cover Ledger’s role.

Replace “rate spread negative” with scenarios comparing APR, fees and uncertain net returns. Borrowing remains research. All execution stays test-only, without real money/mainnet; [test tokens have no real-world value](https://robinhood.com/us/en/support/articles/robinhood-chain-testnet/).

## Review queue: risk rules first, faithfulness second

The publication contains **15,318 records**: 10,654 OSM, 2,835 official-city, 741 Autobahn, 1,062 council, 24 atlas and two budget. None is marked human-reviewed.

Your “47 items” needs correction: five LLM statements, 18 inferred council locations and 24 atlas projects represent **47 concerns across 46 distinct records**; one council record overlaps. Start there, then add consequential changes, contradictions, rights/date failures and resident corrections. Sample lower-risk structured records rather than assigning 15,318 manual tasks.

[DeepEval faithfulness](https://deepeval.com/docs/metrics-faithfulness) evaluates agreement with supplied context—not independent truth, completeness, geography, rights or municipal approval. The fabricated “already spent” claim scoring 1.0 defeats a score-only gate. Raising 0.8 would not fix it. All five published LLM statements currently score 1.0.

Use below-0.8 or missing evaluations as review reasons; require human checks for consequential interpretations regardless of score. Retain the plan/actual guard, strengthen deterministic year/amount checks, and retain regression cases for the false pass. Currently only `statement` is scored: generated `nextStep` and locations need separate checks. Page-one extraction cannot establish whole-document coverage.

**Proposed ownership:** you are interim accountable publisher; a Stadtstack editor resolves evidence tasks, atlas editors resolve project interpretation, and the pipeline maintainer fixes collectors. Cities are never assumed to be reviewers.

Each task binds claim, signal version and source hashes; shows excerpt/page locator, semantic diff, dates, precision and rights; and records reviewer, timestamp, decision and reason. Accept, reject or request better evidence. Source changes supersede approval. Approve text and location separately. Reports contain public IDs, never private pins.

There is no durable human-review workflow yet. Worse, [the schema](../../stadtstack-data/src/schema.ts) rejects every `llm + reviewed` combination. Preserve extraction method and add independent human-review evidence. Publication validation also needs an editorial gate. Publish qualified structured records with honest labels; withhold unsupported interpretations. Do not delay the cockpit until everything is reviewed.

## Reuse the pipeline, not another platform

Stadtstack’s four levels remain **infrastructure; perceive/understand; deliberate/decide; act/implement**. Ledger is the personal entry point. Atlas supplies city-project interpretation; `stadtstack-data` collects/evaluates/publishes; CCF supplies upstream council records. Records do not themselves prove decisions or implementation.

Keep the standalone Node package, registry, snapshots, canonical council deduplication, geometry handling, Zod validation, compact/full GeoJSON, publication differences and read-only MCP. Extract that package when deployment needs it, making paths/provider configuration explicit. Do not create a fourth generic pipeline or send private coordinates to hosted MCP.

Keep PDF.js and DeepEval. Benchmark [Docling](https://docling-project.github.io/docling/) and [OCRmyPDF](https://ocrmypdf.readthedocs.io/en/latest/) against demonstrated extraction failures. Prefer feeds/direct HTTP, adding deterministic browser collection when necessary. A small review UI plus append-only decisions fits this workload; [Argilla](https://docs.argilla.io/latest/how_to_guides/dataset/) is a later option for a larger annotation team. Dagster, Prefect and whole urban portals add little now.

Keep private observation adapters and signed finance operations separate from public-data collection. Share provenance, freshness, health and consent presentation—not execution authority.

Delete “await dedicated research”: [tool research](../research/REUSABLE_PIPELINE_COMPONENTS.md) and [feed research](../research/CITY_FEEDS.md) already exist. They identify candidates, not completed integrations. Remove city-contact fallbacks from generated next steps too.

## Triage every planned item

This covers all 13 [Ideas entries](../../src/components/ideas.tsx), plus the three requested additions.

| Item | Existing reality → decision |
|---|---|
| Life timeline | Tenancies/self-declared history exist. Keep compact; attestations and disclosure predicates later. |
| Roles everywhere | Tenancy roles exist. Generic memberships later; chosen city is not verified residence. |
| Service charges | Example statement/test prepayment; optional live consumption. Keep collapsed; invoices, allocation and payments later. |
| Stocks as deposit | At this historical review: illustrative calculator and legacy sale-based contract. Current implementation: in-kind test-TSLA deposit available in Home; hosted three-party run proven on 1 October 2026 with three fresh accounts ([evidence](../evidence/HOSTED_SHARE_DEPOSIT_ROBINHOOD_TESTNET_2026-10-01.json)). |
| Local investments | Illustrated forms/unverified leads. Later with verified terms and licensed scope. |
| Home shares | Planned. Park until enforceable ownership/acquisition structure exists. |
| EV/devices | Solar/validator observation exists; EV planned. Read-only EV later; income tokenization parked. |
| Personal map | Built. Integrate/deduplicate now; remove from unfinished Ideas. |
| Budget | Headline plans/explainer exist. Detail now; actual spending needs separate evidence. No city outreach. |
| Street→world | Three local rings built; wider levels are links. Park broader feeds. |
| Measurable city | Weather/citizen PM live. Keep optional; no causal or citywide claims. |
| Council decisions | Papers/meetings in covered cities; Strausberg links only. Rename now; verified decisions later. |
| Welcome | OSM discovery/local interests exist. Consolidate now; registration/vouchers/partners parked. |
| Cockpit | Summaries exist; meaningful briefing missing. Highest priority. |
| City events/news | Public sources exist; integrated feed missing. One-city pilot after freshness/rights checks. |
| Borrowing | Loan product missing. Research only; do not repurpose collateral escrow. |

## Proposed delivery order

First reconcile labels/accounting and remove duplicate views. Then implement the local baseline and briefing. Third complete claim→invest before another finance prototype. Build the review workflow and qualify the Strausberg feed as separate work. Finally integrate collateral after defining failure behavior.

Acceptance should demonstrate first/repeat visits, changed same-ID records, city switches, outages, cancellations, 390px layout, finalized claim→buy accounting, and collateral shortfall/dispute/failed-sale outcomes.

I made no file changes.