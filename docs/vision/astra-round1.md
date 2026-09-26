# Astra · Round 1

> Working draft from the first read-only alignment pass, retained for comparison. Some source claims were superseded by the interface research and the final vision document.

**Alignment draft · 26 September 2026**

**The owner’s intent, restated.** You want people to see and understand what is changing around them before they need to understand the institutions and documents behind it. “Stadt im Wandel” expresses that experience: familiar places on a map, with each project explaining its status, timeline, next step and remaining unknowns. Someone should learn something useful without first reading a 65-page planning document. Maps, charts, timelines and clear language offer different ways into the same information. Behind those views, we collect scattered material, extract supported statements and preserve the evidence for each statement. Publishing reusable open data and MCP access allows other people and tools to create further views. Ledger of Life makes this personal by connecting someone’s identity, home, possessions, activities and surrounding decisions, with private information under their control. Within Stadtstack’s four levels, this understanding supports deliberation, decisions and action, while rights, trust and learning between cities run throughout the experience. [Stadtstack model](https://stadtstack.giraeffleaeffle.chatgpt.site)

The first product test is whether a resident can answer: **What is changing here? What happens next? What remains unknown?**

**What exists today.** The following distinctions come from repository documents, relevant code and source checks; proposed work follows below.

- **Stadtstack atlas:** the local page and API respond with 24 Strausberg projects, map/timeline interfaces, summaries, next steps, unknowns and sources. The read model declares research as of 5 September 2026, `pending_review`, and incomplete municipal coverage. Its 3D explanation identifies existing OSM buildings and approximate heights; it does not claim to show future buildings. [Local atlas](http://localhost:4317/?city=strausberg)
- **Ledger:** implemented readers and views show atlas projects and consultations, OSM clubs/sports facilities, weather and nearby particulate readings. EU-wallet verification exists against a test verifier, and the life timeline includes app tenancies and self-declared earlier places. Some ontology status labels lag the implementation. The personal home map, interest matching and a genuine “changed since your last visit” neighbourhood feed remain proposals. [Product brief](file:///Users/max/Code/rental-deposit-hackathon/docs/LEDGER_OF_LIFE.md)
- **CCF:** registry loading, OParl collection, normalization and Git history exist. Current collection follows bodies, meetings and papers with a two-page cap; it does not yet walk all agenda items and attachments. Git data is the wired interface; REST/MCP remains planned. This is a useful starting point, with further work needed for complete decision coverage. [CCF status](https://github.com/komma-systems/ccf), [collector implementation](https://github.com/komma-systems/ccf/blob/main/src/source/oparl.rs)

The unified claim-level evaluation, publishing contract and end-to-end integration described below are proposals. The optional `STADTSTACK_ATLAS_AND_CCF_INTERFACES.md` was absent.

**How the parts should cooperate.** Start with the existing atlas and a small collection of reviewed records. The intended flow is:

**Sources → collection and extraction → evidence checks and human review → versioned public records → atlas, charts, MCP and Ledger.**

CCF supplies the council-record branch of this flow. Browser agents handle selected department pages and PDFs where suitable APIs or exports are unavailable. Geoportals/DiPlan provide planning geography; OSM provides map context and contributed places; open-data portals provide additional datasets. Social media could later supply leads, with separate corroboration before making consequential claims.

| Component | Proposed responsibility and handoff |
|---|---|
| Collector operator | Runs bounded API requests or browser agents in an isolated VM; hands over source captures, retrieval metadata and extraction candidates. |
| CCF maintainer | Owns council adapters, upstream identifiers and source correction/deletion history. Consumers preserve those identifiers and versions. |
| Stadtstack publisher and editor | Own project matching, extracted statements, evidence bindings, review decisions, rights checks and corrections to Stadtstack’s interpretation. |
| Open-data/MCP publisher | Exposes the same eligible, versioned records through downloadable formats and read-only tools, retaining evidence and limitations. |
| Atlas and Ledger product owners | Atlas owns the shared city experience; Ledger owns private location, interests and personal relevance. Both consume the same public records. |

A council paper becomes a project milestone only when its relationship and decision status are supported. An agenda entry alone cannot establish that something was approved. CCF’s upstream records stay intact; corrections to our summaries belong to our derived records, while corrections from councils arrive through CCF’s source history.

The shared contract should be small but explicit:

| Required information | Meaning |
|---|---|
| Stable record/project ID and version | Identifies the same subject across views; records what changed or superseded an earlier version. |
| Source URL, publisher and precise locator | PDF page plus section/table/row or bounding box; HTML heading and anchored passage; API object ID and field. Bind these to a source version/hash. |
| Extracted statement | One checkable assertion, with supporting passage and a distinction between source statement, calculation and interpretation. |
| Faithfulness score and review state | Nullable score, evaluator/version and rationale; `pending_review`, `reviewed`, `rejected` or `review_due`, with reviewer and review date. Editorial review is distinct from city confirmation. |
| Licence and reuse basis | Source-content terms, dataset terms, attribution and rights for our additions; explicitly `unknown` where unresolved. |
| Geometry | Shape or point, coordinate system, source, method and precision; explicitly distinguish an official boundary from an approximate location. |
| Time and coverage | Publication, retrieval and modification times; the statement’s **as-of** date; event date versus planned date; known coverage gaps. |

**Discovery and republication require separate decisions.** A catalogue can point to sources and expose permissible metadata while redistribution of full documents remains unresolved. MCP must preserve this distinction. Unknown rights should prevent automatic full-text republication or a blanket “open data” label. Conversely, absence of a licence badge does not automatically prohibit reuse: German law excludes specified official works from copyright protection, while third-party plans, photographs and other attachments require separate assessment. [UrhG §5](https://www.gesetze-im-internet.de/urhg/__5.html)

Publish eligible records as JSON, GeoJSON and CSV, with a short data dictionary, rights information and correction history. MCP then offers ways to find projects, retrieve their evidence and inspect changes. ODIS demonstrates discovery, data access and analysis over Berlin’s portal; its own evaluation also describes limitations from data quality and model behaviour. [ODIS account](https://odis-berlin.de/aktuelles/2026-06-29-mcp-server/), [MCP documentation](https://github.com/technologiestiftung/open-data-mcps/blob/main/berlin-open-data-mcp/README.md)

**What evaluation must establish.** Faithfulness measures how an answer relates to the supplied context. It cannot prove that the source is correct, current or complete. DeepEval’s documented LLM mode judges extracted claims against retrieval context, including a non-contradiction criterion; publication should require positive supporting evidence as well. [DeepEval faithfulness](https://deepeval.com/docs/metrics-faithfulness)

For the pilot:

1. **Check provenance:** every displayed factual statement resolves to an actual passage in the captured source. Check OCR, table columns, dates, units and document versions.
2. **Evaluate individual claims:** retain the score and explanation. A provisional score of **0.95** can flag candidates for review, but an aggregate passing score cannot excuse an unsupported deadline, amount, decision or status. Missing evidence remains unknown.
3. **Review every published pilot claim:** a named person checks meaning, qualifications and misleading omissions. Calibrate the metric against a small human-labelled set containing German planning language, negations, changed decisions and planned-versus-completed examples.
4. **Propagate corrections:** changed or withdrawn evidence triggers review of dependent summaries, charts and personal notifications.

Spatial reasoning needs its own checks. A street-name match cannot establish a project boundary; proximity cannot establish legal impact on a home. A faithful summary of a planning document also cannot establish that construction has begun.

Measure usefulness alongside extraction quality: can residents identify the current state, next step and uncertainty, and locate the evidence when they want it?

**The personal map.** Ledger’s Overview would contain “What changed near me,” opening a map centred on a privately chosen home or neighbourhood. Projects, relevant council matters, clubs, shops and services appear as selectable layers, with a timeline and an equivalent readable list. Each item explains why it appears: nearby, on a followed street, or matching an explicitly selected interest.

The home marker represents the person’s private context. It is not uploaded to OSM or included in public exports, Git history or the public MCP service. Start with local matching against city-wide public data. Avoid sending exact coordinates to external models; geocoding, tiles, analytics and remote queries also need scrutiny because requests can reveal location. Sharing a map should remove the home marker and other identifying context.

EU-wallet locality can help select a city; it does not establish an exact dwelling. Public city information should remain browseable without identity verification. Private interests stay optional and removable. OSM places should retain their contributed-data status and attribution, without implying verified opening hours, membership availability or partnership. [OSM terms](https://www.openstreetmap.org/copyright)

**Pilot recommendation: keep Strausberg for the visual experience; use Münster for a bounded council integration proof.** Strausberg offers the existing atlas and a convincing transformation from departmental documents into understandable project stories. A city response should not be a prerequisite for that demonstration.

The budget premise needs correction. **“No online budget” is too broad.** The published 2025/26 ordinance contains headline totals: for example, originally planned investment payments of **€17,941,270 for 2025** and **€12,609,320 for 2026**. These support a small, clearly dated chart of the original plan; they do not establish expenditure actually incurred, project allocations or the latest amended position. [Ordinance, page 1, §1](https://www.stadt-strausberg.de/wp-content/uploads/2025/04/2024-11-07_Haushaltssatzung_2025_2026.pdf)

The city also links an interactive budget whose returned page identifies Strausberg and exposes year options through 2024. Its complete figures and a current 2025/26 detailed plan were not verified here. The repository’s stronger absence claim should therefore be reconsidered. [Official city navigation](https://www.stadt-strausberg.de/satzungen-und-verordnungen-2-2/)

Current BbgKVerf §69(5) requires public notice and an inspection route; it does not prescribe complete online publication or contain the research note’s seven-working-day wording. An electronic-copy request remains possible under AIG procedures, with applicable restrictions. [BbgKVerf §69](https://bravors.brandenburg.de/gesetze/bbgkverf#69), [AIG §§6–7](https://bravors.brandenburg.de/gesetze/aig)

For council data, no Strausberg OParl endpoint is confirmed. Münster, Köln and Wuppertal returned OParl System objects during this review. Münster additionally returned meeting and paper pages containing September 2026 records; licence fields were absent in the sampled system/body/records, so reuse still needs assessment. [Münster meetings](https://oparl.stadt-muenster.de/bodies/0001/meetings), [papers](https://oparl.stadt-muenster.de/bodies/0001/papers)

If continuous council ingestion is the essential hackathon promise, choose Münster as the primary pilot. Berlin is attractive for demonstrating existing MCP access and charts, but does not automatically provide a ready project atlas or street-level decision feed.

**A phased, smallest true demonstration.**

1. **Complete one visual story.** Refresh one Strausberg project from its official page, PDF and location evidence. Use one bounded collection run, extract a handful of claims, evaluate them and record real human review. Show status, timeline, next step and unknowns in the existing atlas. For example, an elapsed consultation deadline must not remain labelled “open”; the subsequent decision may still be unknown.
2. **Carry those same records through every promised outlet.** Provide an eligible JSON/GeoJSON download, a minimal read-only MCP query and Ledger’s private-location view. Preserve identical IDs, versions and evidence. Demonstrate a correction reaching each view; label any replay as a replay. A small chart of sourced budget totals can demonstrate another presentation using the same principles. [Datawrapper’s chart/map/table model](https://www.datawrapper.de/)
3. **Extend after the chain works.** Add a bounded CCF/Münster import, scheduled refreshes, broader source coverage, stronger spatial checks and interest matching. Expand autonomous collection after measuring review effort and reliability.

Success is a person understanding a real project, an assistant retrieving the same supported answer, and a correction appearing consistently. A few reviewed files and one collector are sufficient to prove that.

**Risks that need explicit ownership.** Collection can overload sites or violate access terms: prefer documented interfaces, respect robots rules, identify the collector, rate-limit and stop at access barriers. Robots rules themselves are not permission to reuse content. [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) Isolated browser agents should have bounded destinations, no personal credentials and no direct publishing authority; source text must be treated as untrusted input.

Licences, database rights and attribution must survive exports and charts. Public PDFs may contain private addresses, signatures or submissions: remove unnecessary personal data before public Git history or remote-model processing. Incorrect deadlines, project boundaries or approval claims can cause real harm; the publisher needs a correction route, withdrawal capability and a named editorial owner. Missing coverage must remain visible so an empty map is never presented as proof that nothing is happening.

**Questions for the product owner:**

- Which first audience matters most: an existing resident, someone moving in, or someone following local decisions?
- Is hackathon success primarily visual understanding in Strausberg, or reliable council ingestion in Münster?
- Should the first personal view use a neighbourhood selection or an exact private home pin?
- Who will review claims and own corrections after the demonstration?
- Which additional view best proves the vision: a budget chart, a project timeline, or a personalised change feed?

*Read-only review; no repository files were edited.*
