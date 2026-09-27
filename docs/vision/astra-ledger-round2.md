# Astra · Ledger round 2

Read-only reconsideration of round 1 after my critique and the updated pipeline/feed research. No code changed; tool transcript omitted.

## Critique supplied to Astra

**What Astra improves:** It correctly treats duplication as competing ownership and misleading language, not just layout; insists source/review/date/precision survive into plain-language previews; distinguishes a council paper from a decision and a newly imported old plan from a newly proposed plan; separates per-person last-seen state from publisher diffs and mere evidence-hash churn; catches that `stadtstack-data/src/common.ts` omits `reviewState` from `version`, and `schema.ts` forbids `llm + reviewed`; identifies the real Solana signed-in tenancy versus Robinhood operator-run helper, fixed-five test-USDC Solana UI versus variable server buy, whole-balance Robinhood buy and no intrinsic trace of fungible earnings; catches §551(3)'s interest-increases-security rule and the stock-pledge cap problem; distinguishes direct pledge from a credit product. These corrections must go into the final plan.

**Where round 1 misses the owner's priority:** It orders “reconcile labels/accounting and remove duplicate views” before the morning cockpit. That can become a long refactor and postpone the one thing the owner wants to open tomorrow. Lead with a small, calm Heute using the *existing* one-action journey plus honest no-change/one-change and linked details; make the de-duplication a bounded acceptance part of that visible slice, not a precondition to show anything. Don't add all adapters, weather, review tasks or warnings as equal-weight cards. Keep a strict four-row/one-column briefing and at most three changes.

**Updated feed evidence invalidates its Strausberg-HTML-only example:** The now-committed `docs/research/CITY_FEEDS.md` verified official Strausberg `/aktuelles/feed/` news RSS (10 items, newest 24 Sep) and `/veranstaltungen/feed/` events RSS (10 items, newest 23 Sep). It also verified Köln koeln.de events ICS (not city government, past/recurring rows), city-linked Münster press RSS, Wuppertal press RSS and Dresden press RSS. None establishes an open article-text licence. This is a real low-complexity pilot source: city-wide headline/date/link only, event date separate from RSS publication date; no city contact. VBB GTFS-RT is CC BY 4.0 but 6,485 trip updates and **zero alerts** in inspected response: don't call it disruption feed. Treat no verified feeds for Castrop-Rauxel/Düsseldorf/Freiburg as source gaps, not app failure. Astra must integrate this, not merely link HTML calendars.

**Finance sequencing:** I accept Solana claim→tSPYx as smallest signed-in real-user slice; however it does **not** carry that tSPYx into the Robinhood TSLA collateral contract. To satisfy the owner's *single* earn→portfolio→new-stock-deposit story, describe two noninterchangeable demonstrations: (A) first prove Solana funds/claim/own-wallet buy and accurate accounting; (B) then, separately on Robinhood, bind a test tenancy to real app parties/signatures, simulated earn→claim→TSLA, and pledge that *same test TSLA* for a new landlord-accepted tenancy, with extra test funds openly disclosed if ~$0.50 earnings cannot cover 150% collateral. No bridge and no assertion that demo parties are user-controlled today. Before integration, contract lacks agreement digest/consent binding, isolated pull payout, and production oracle/sale security. Borrowing remains parked; “likely negative carry” is a scenario, not a universally proven rate comparison. No mainnet, real money or real lending.

**Review ownership and evidence:** The claim of 47 concerns across 46 records is useful *if* counted from published records, but owner's given “~47 interpretations” suffices; don't market all other 15,271 records as automatically true. Existing publication permits candidate/auto_checked; a human review queue and editorial gate are **not built**. Because `llm + reviewed` is currently schema-invalid, propose separating extraction method from human decision with a reviewer/date/reason record before calling anything reviewed. Human review of wording and guessed location separately. A high faithfulness score neither exempts a risky statement nor certifies it. Avoid assuming the owner personally volunteers as interim accountable publisher; ask them who owns editorial approval. An annotation platform and city outreach are off the table.

**Information architecture and privacy:** Me should own consent/connection settings, Home the tenancy and solar reading, Money a single holding/buy card and validator reading, Places one city signal/feed plus optional map, Ideas remaining proposals, Heute only linked previews. The compact total should not show the partial $1.16 during stock quote loading (observed in our screenshot) as complete wealth; don't mix ETH with test dollars. Per-account/city device history must compare review state separately from ID/version; newly placed pins change relevance, not source truth; first visit has no faux unread items. Never leak pins/interests; tile provider still sees viewed area. Fix 'resident of chosen city', raw `none` precision, `auto_checked` numeric score and misleading clubs 'near you'.

**Requests for round 2:** Rewrite a short actionable plan, not a new platform design: four cards with actual data sources and built/missing; 3–5 smallest demo slices starting with Heute and including a real Strausberg RSS headline pilot; a table assigning every fact one home; an explicit same-chain collateral path separate from the first Solana proof; review queue as parallel Stadtstack work; all 13 Ideas plus cockpit/feed/borrowing triage; honest legal caveats and 3–6 owner questions. Flag any claim from the first pass not backed by code/research. Do not modify files. Distinguish participant/editorial review from city endorsement.

## Astra’s revised response

**Ship Heute first:** four quiet rows, one primary action, at most three meaningful changes, and links to authoritative details. Make duplicate removal part of that visible slice. Keep eight city pilots, on-device home/work/interests, no city contact, and test-only finance.

My first pass understated Strausberg’s feed readiness and put too much cleanup before the cockpit. The updated draft corrects both.

Heute should use the existing sources as follows. “Nothing changed” requires a successful comparison; failed reads show “Could not check.” These boundaries follow the [signed-in audit](../research/LEDGER_APP_AUDIT_2026-09-27.md).

| Row | Built and source | Missing / proposed behavior |
|---|---|---|
| **Needs you** | `/api/journey`, `/api/listings`; existing tenancy, invitation and application priorities | One required action linking to Home, otherwise waiting/quiet state. Optional test-earnings claims rank below required responses. |
| **Changed for you** | `/api/city-signals`; public records, review/precision metadata and browser relevance matching | Meaningful personal comparison; maximum three qualified changes. Explain “near home,” “citywide” or “approximate commute” accurately. |
| **Around your city** | `/api/city` supplies atlas context; verified RSS/ICS sources exist externally | Pipeline feed adapter, dated Places list and one headline preview. Publication time and event occurrence remain distinct. |
| **Your things** | `/api/journey`, `/api/portfolio`, `/api/assets`; deposit, holdings, solar and validator readings | Quiet linked status line. Never present an incomplete total as complete, mix validator ETH with test dollars, or turn quote fluctuations into unread events. |

Use one column on desktop and 390px. Source/date, review qualification and test status survive into previews; numeric evaluation scores and technical metadata stay in detail.

Every fact needs one detailed home:

| Home | Owns |
|---|---|
| **Me** | Identity assurance, chosen city, contextual-role summary, private history, wallet and connection permissions. Tenancy-history entries link to Home. |
| **Home** | Listings/applications, agreements, tenancy actions, deposit security, earnings releases, settlement, service-charge example and solar readings. |
| **Money** | Cash, holdings, availability restrictions, buys and receipts, validator readings, local-investment illustrations. Deposit entitlement links to Home; pledged shares count once. |
| **Places** | City signals, news/events, consultations, council papers/meetings, budget facts and explanatory detail, OSM discovery, optional map and measurements, wider-area links. |
| **Ideas** | Remaining proposals and their prerequisites. Remove the already-built map from unfinished work. |
| **Heute** | Priorities and linked previews only. |

Merge the duplicate tSPYx presentations. Give each atlas-derived project one resident-facing signal, linking to the atlas’s interpretation. Retire the second OSM directory only after category, coverage and attribution parity.

The **feed correction is substantial**. The committed [city-feed research](../research/CITY_FEEDS.md) records:

- **Strausberg:** official [news RSS](https://www.stadt-strausberg.de/aktuelles/feed/) and [events RSS](https://www.stadt-strausberg.de/veranstaltungen/feed/) are live, ten items each; newest publication dates September 24 and 23 respectively. Start with **headline, publication date, publisher and link**. Article-text rights remain unconfirmed. Event headlines become “upcoming” only when an occurrence date is verified.
- **Münster, Wuppertal and Dresden:** working press RSS; Münster’s is city-linked Presse-Service. These are subsequent adapters within the same eight-city pilot.
- **Köln:** koeln.de ICS is not municipality-owned and contains past/recurrent entries. Resolve recurrence, exceptions, cancellation and timezones before filtering occurrences; filtering the original `DTSTART` alone is insufficient.
- **Castrop-Rauxel, Düsseldorf and Freiburg:** no verified machine feed in this research. Show source links or coverage gaps, without implying app failure or proving that no feed exists.
- **VBB:** the inspected snapshot contains **6,485 trip updates and zero alerts**. It supports no claim of disruption-alert coverage.

Feed discovery is complete enough to start; app integration is still missing.

**“Since last visit” must describe a user-relevant difference.** Today, [common.ts](../../stadtstack-data/src/common.ts) includes evidence hashes in versions but omits review state; [evaluate.ts](../../stadtstack-data/src/evaluate.ts) also creates council versions separately. Therefore neither changed nor unchanged `version` settles whether something meaningful happened.

Compare normalized user-facing fields and review state separately:

| Difference | What the person sees |
|---|---|
| Newly published, relevant source item | “New paper/news item,” with its source date |
| Historical material first imported | “Newly available here,” without suggesting a new proposal |
| Changed status, amount/year, deadline, occurrence, cancellation, supported action or consequential location correction | The specific difference |
| Editorial correction/rejection or relevant review change | “Corrected” or “Review updated,” including when ID/version stayed unchanged |
| Confirmed tenancy action, claim receipt or purchase completion | The actual state transition |
| Evidence-batch hash, retrieval timestamp, ordering, formatting or quote-only change | No unread event |

An approaching deadline is a **reminder**, not evidence that the source changed.

Keep a successful baseline per account/city on this device, plus separate acknowledgements for items actually displayed or dismissed. Fetching the whole city must not mark everything read. First visit establishes a baseline; returning to a previously visited city restores it. **Changing pins/interests re-ranks existing history—it must not reset that history.** Newly relevant items are not newly published facts.

Preserve last-good data through failures. Missing IDs mean unavailable unless withdrawal/cancellation is evidenced; handle known ID migrations explicitly. Snapshot comparison cannot reconstruct intermediate changes missed between visits. Keep pins/interests local; city/public-ID requests remain visible to the server, and tile requests reveal viewed areas.

The **finance sequence should deliberately contain two independent proofs**:

- **A — smallest signed-in proof, Solana:** simulated yield credit → tenant-signed claim → finalized wallet receipt → selected test-USDC amount → signed tSPYx buy → finalized holding. Replace the fixed-five UI amount using the existing amount-capable backend. Show receipts and reconciled balances, including additional test funds. Transaction order supports a transparent allocation; fungible cash does not prove uniquely identifiable “earnings coins.”
- **B — later complete story, Robinhood:** deploy an earnings escrow backed by an actual app agreement and actual party signatures; simulate yield → tenant claims → selected-amount TSLA purchase → pledge that holding for a **second, new, explicitly landlord-accepted agreement**. The helper currently uses operator-held tenancy signers and its buy spends the entire test-dollar balance. Receiving its payout does not make the recipient its signed-in tenant.

The existing Robinhood escrow’s party addresses are immutable, so this requires a new deployment rather than relabelling the helper. Disclose any extra test funding required for the illustrative collateral ratio. Solana tSPYx supplies no Robinhood TSLA: there is no bridge or migration in this plan.

A direct pledge creates no loan. Before integrating it, bind agreement digest and consent, implement isolated payouts, and demonstrate stale-price, failed-sale, blocked-recipient and exhausted-collateral outcomes. The contract already has stale-price/slippage checks, but also permits protective liquidation **before move-out** and combines settlement transfers. Remaining collateral can leave the landlord short. A labelled test oracle/desk is sufficient for this test-only demonstration; production venue infrastructure is a later concern.

The legal caveat must reach the core earnings story: **§551 BGB says returns belong to the tenant and increase security**, alongside the required-security cap and separation rules. “Claim earnings anytime” and a 150% pledge therefore remain test mechanics requiring German housing-law review before any real offer; landlord agreement alone does not establish compatibility. [§551 BGB](https://www.gesetze-im-internet.de/bgb/__551.html)

Commercial lending generally requires authorization under [§1 KWG](https://www.gesetze-im-internet.de/kredwg/__1.html) and [§32 KWG](https://www.gesetze-im-internet.de/kredwg/__32.html). If Ledger intermediates loans, [§34c GewO](https://www.gesetze-im-internet.de/gewo/__34c.html) may separately apply, depending on activity and exemptions. Permission is not optional when required, and a licensed partner does not automatically cover Ledger’s role. Borrowing stays parked; carry depends on explicit rates, fees and uncertain returns.

**Review work belongs alongside product delivery in Stadtstack.** The publication has 15,318 records, none marked human-reviewed. The initial 47 interpretive concerns cover 46 distinct records; this is queue sizing, not certification of everything else.

Trigger review for missing/failed evaluations, scores below 0.8, consequential interpretations regardless of score, inferred locations, atlas claims, conflicting evidence, rights/date uncertainty and resident corrections. The unsupported “actually spent” claim scored **1.0**; changing the threshold cannot repair that failure. Retain deterministic plan/year/amount checks and review generated `nextStep` and location separately.

Ownership must be assigned: a named Stadtstack editor approves publication; atlas editors own project interpretations; the maintainer fixes collectors. Neither the owner nor municipalities are automatically volunteered. Participant feedback, editorial approval and city endorsement are different things.

The queue, decision log and editorial gate are missing. [schema.ts](../../stadtstack-data/src/schema.ts) currently rejects every `llm + reviewed` record. Preserve extraction method while adding an independent, scoped human decision with reviewer, date, reason and supporting evidence. Reopen approval when that support changes or equivalence cannot be established—not merely because an unrelated record changed a shared response hash. My default is to keep consequential unreviewed interpretations out of Heute while retaining qualified source access in Places.

For reuse, **keep** the existing Node pipeline, CCF/OParl adapters, snapshots, canonical IDs, GeoJSON/catalogue/diffs/MCP, PDF.js and DeepEval. **Adopt** RSS/ICS adapters within that boundary. Add deterministic browser collection or benchmark OCR tools only for demonstrated failures. A small authenticated decision log fits; an annotation platform, new orchestration stack or institutional cockpit does not. Extract the package when independent release needs justify its path/config audit. This follows the [reuse research](../research/REUSABLE_PIPELINE_COMPONENTS.md).

The complete feature triage is:

| Item | Decision |
|---|---|
| Life timeline — partly built | Keep compact history; attestations/disclosure later. |
| Roles everywhere — planned | Later, when a second real shared context exists. |
| Service charges — prototype | Keep collapsed example; real invoices/meters/payments later. |
| Stocks as deposit — prototype | Later test milestone after signed earn→buy and contract corrections. |
| Local investments — illustration | Park offers; retain clearly labelled background. |
| Home shares — planned | Park pending enforceable ownership/acquisition structure. |
| EV/devices — planned | Read-only adapter later; income tokenization parked. |
| Personal map — built | Reuse now; simplify and deduplicate. |
| Budget — partly built | Planned amounts/source detail now; actual spending requires separate evidence. |
| Street→world — partly built | Keep optional links; park broader feeds. |
| Measurable city — partly built | Optional dated observations; no citywide or causal claims. |
| Council decisions — partly built | Rename available content papers/meetings; decisions require evidence. |
| Welcome — partly built | Consolidate discovery now; registration/vouchers parked. |
| Cockpit — missing | First priority. |
| Events/news — sources verified, integration missing | Strausberg headline adapter next; expand within eight pilots. |
| Borrowing — missing | Research only; separate debt product, not collateral escrow. |

The first five demoable slices should be:

1. **Heute shell:** existing primary action, truthful baseline/empty/unavailable states, four restrained rows and working detail links at desktop/390px.
2. **Meaningful return visit:** demonstrate same-ID correction, review-only change, silent hash churn, city switching, changed pins and outage recovery.
3. **Strausberg headlines:** both official RSS sources through the pipeline into Places and one Heute preview; event-page links remain publication-dated until occurrence is verified.
4. **Solana signed claim→buy:** selectable amount, finalized receipts and reconciled accounting without duplicated holdings.
5. **Robinhood agreement-backed earn→TSLA:** actual party acceptance, tenant claim and selected-amount purchase. The new stock-secured tenancy follows as a separate milestone with the contract gates above.

The editorial queue can progress alongside these slices; it need not delay Heute.

I agree with your critique on priority, privacy, feed facts and review ownership. My remaining differences are scope: the complete Robinhood earn→pledge→liquidation→settlement journey is too large to call one smallest slice, and production-grade oracle/venue infrastructure should not become a prerequisite for an explicitly mocked test demonstration. My earlier assignment of editorial accountability to you was also only a proposal, not an owner decision.

I would make these **exact remaining edits** to the [current draft](../LEDGER_OF_LIFE_PLAN.md):

1. In “Last visit,” replace “newly placed home/work pin establishes a baseline” with re-ranking that preserves history; explicitly separate meaningful comparison from display acknowledgement.
2. In Robinhood step 2, replace “bind the existing test-actor escrow” with **deploy a new agreement-backed escrow**; name the earning agreement and subsequent pledge agreement separately.
3. Split build slice 5 at the confirmed TSLA holding. Make stock pledge and protection/settlement a following milestone.
4. In the protection loop, explicitly require isolated payouts and distinguish pre-move-out protective sale from sale to satisfy an approved claim.
5. In review policy, scope approval invalidation to supporting evidence; add missing evaluations as a trigger and cover both version-generation paths plus the compact review projection.
6. Correct two evidence nits: mobile Ideas already has an in-area link—preserve one when removing roadmap boxes; the feed-research footer counts **six endpoints across five cities**, not five feeds. Reconcile the stale timeline, identity, budget and legal reality statements in both ontology files without making that a broad cockpit prerequisite.

The remaining owner questions are:

1. Who owns Stadtstack editorial approval and correction responses, and what response time is realistic?
2. Should consequential unreviewed interpretations stay out of Heute, with qualified source access in Places?
3. On quiet mornings, should the city row show one recent headline automatically or remain collapsed?
4. Which actual app participants will demonstrate tenant and landlord signatures, and what disclosed test-funding budget should the Robinhood story use?
5. After Strausberg, should the three verified municipal press feeds precede Köln’s third-party recurring-events calendar?

No files changed.
