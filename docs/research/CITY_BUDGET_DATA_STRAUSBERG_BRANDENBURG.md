# City budget data: Strausberg, Brandenburg

**Research checked: 26 September 2026.** This note distinguishes adopted budget authority (plans) from cash receipts and year-end actuals. A budget is not evidence that an amount was spent.

## 1. Strausberg: what is published

| Item | What could be verified | Format / freshness |
|---|---|---|
| Budget ordinance | Strausberg adopted a double budget for **2025 and 2026** on 7 November 2024 (decision BV-SVV-2024/0046). The ordinance is published in the city Amtsblatt dated 23 November 2024; the city also lists it under [statutes and ordinances](https://www.stadt-strausberg.de/satzungen-und-verordnungen-2-2/). | Downloadable PDF / official gazette. The gazette says the ordinance **with its components and annexes** may be inspected at the Finance Department by appointment; it does not itself expose a machine-readable plan. [Amtsblatt PDF, pp. 24–25](https://www.stadt-strausberg.de/wp-content/uploads/2024/11/2024-Amtsblatt_07.pdf). |
| Detailed plan and line items | **Not found online** as a complete downloadable plan or structured dataset in the sources examined. The city publication points to in-person inspection for the plan and annexes. | Consequently, planned total results/financial budgets, Gewerbesteuer, income-tax share, key allocations and investments cannot be responsibly quoted from the ordinance excerpt alone. |
| Municipal annual accounts | The city published a notice that the **2018** annual account was adopted 26 September 2024; the account and annexes are available for inspection at the Finance Department. | Inspection, not an online data file per notice. [Amtsblatt PDF, p. 2](https://www.stadt-strausberg.de/wp-content/uploads/2024/11/2024-Amtsblatt_07.pdf). **Current city annual-account year not found** in the sources examined. The 2024/25 gazette search result for a 2023/24 account refers to the Stadtforst enterprise, not the whole city ([2025 Amtsblatt](https://www.stadt-strausberg.de/wp-content/uploads/2025/01/2025_01_Amtsblatt_SRB.pdf)). |
| Open budget visualisation | [OffenerHaushalt Strausberg](https://offenerhaushalt.de/haushalt/BB/Strausberg/) exists, but states that the project is completed and is no longer updated. Do not treat it as current. | Legacy web visualisation; current coverage/year not established. The [project repository](https://github.com/okfde/offenerhaushalt.de) describes it as a front-end to OpenSpending. |
| Council records | Amtsblatt points to the [Strausberg Ratsinformationssystem](https://www.ratsinfo-online.de/strausberg-bi) for current meeting calendar and publishes decisions/notices in PDF gazettes. | Web RIS and PDFs. **OParl API/endpoint not found** in the sources examined; do not assume the RIS exposes OParl. |
| Licence | **No explicit open-data licence found** on the cited city budget ordinance/gazette pages. A public PDF is not by itself a grant of an open-data licence. | Request/reuse terms from the city before republishing its extracted plan. |

## 2. Brandenburg municipal fiscal equalisation (BbgFAG)

The [BbgFAG](https://bravors.brandenburg.de/gesetze/bbgfag) sets out the legal calculation. A municipality's **Steuerkraftmesszahl** represents fiscal capacity; its **Bedarfsmesszahl** represents a notional need. The Bedarfsmesszahl uses a main-approach factor (which rises with population) and a basic amount. General key allocations for municipal tasks are paid when Bedarfsmesszahl exceeds Steuerkraftmesszahl; the law's allocation rate applies to the gap (see §§ 7–10). The Finance Ministry's [Kommunalfinanzen / goals and method](https://mdfe.brandenburg.de/mdfe/de/themen/haushalt-und-finanzen/kommunalfinanzen/ziele-und-funktionsweise-des-kommunalen-finanzausgleichs/) explains the mechanism; formula parameters and annual masses are legally/annually determined, not a fixed city revenue.

The ministry's [Kommunalfinanzen page](https://mdf.brandenburg.de/mdf/de/themen/haushalt-und-finanzen/kommunalfinanzen/) and [investment key allocations page](https://mdf.brandenburg.de/mdf/de/themen/haushalt-und-finanzen/kommunalfinanzen/investive-schluesselzuweisungen-und-bedarfszuweisungen/) are the official starting points for allocation announcements. A municipality-by-municipality current-year allocation file for Strausberg, with a stable downloadable table/format, was **not found** in the sources examined. The pages are web text and linked publications; check the current annual allocation notice before implementation. BbgFAG is legal text, not an allocation dataset; its availability does not supply Strausberg's amount.

## 3. Municipal tax statistics / formats

| Source | Table / coverage | Retrieval |
|---|---|---|
| Regionaldatenbank Deutschland | **71231-01-03-5**, “IST-Aufkommen, Grundbeträge, Hebesätze, Realsteueraufbringungskraft, Gewerbesteuerumlage, Gewerbesteuer netto, Gemeindeanteil an der Einkommensteuer …” (see [table listing](https://www.regionalstatistik.de/genesis/online?language=de&sequenz=statistikTabellen&selectionname=71231)). Includes municipal-level annual Realsteuervergleich data, including income-tax share (and Umsatzsteuer share in the detailed table listing). | [Regionalstatistik GENESIS](https://www.regionalstatistik.de/genesis/online?language=de&sequenz=statistikTabellen&selectionname=71231) offers table selection/download; the 2024 [Destatis Realsteuervergleich publication](https://www.destatis.de/DE/Themen/Staat/Steuern/Steuereinnahmen/Publikationen/Downloads-Realsteuern/statistischer-bericht-realsteuervergleich-2141010247005.html) says the contents are also available in GENESIS topic 71231. Check the table's current last year in the interface. |
| Amt für Statistik Berlin-Brandenburg | [L II 2-j Gemeindefinanzen](https://www.statistik-berlin-brandenburg.de/l-ii-2-j/) and [L II 6-j Realsteuerhebesätze](https://www.statistik-berlin-brandenburg.de/l-ii-6-j/); the latter reports rates from quarterly municipal cash-statistics returns. Its [71231 metadata (2023)](https://download.statistik-berlin-brandenburg.de/36ed545bbf7be862/d5ef55849833/MD_71231_2023.pdf) describes layout tables and machine-readable data and points to Regionaldatenbank for municipal values. | Statistical reports / downloadable tables and Regionaldatenbank. Annual reports are not real-time. |
| Destatis GENESIS / Regionalstatistik | Table family **71231** (Realsteuervergleich); table code above is the municipality-level detailed table. | CSV/Excel/table download via Regionalstatistik/GENESIS. The [Destatis 2024 report](https://www.destatis.de/DE/Themen/Staat/Steuern/Steuereinnahmen/Publikationen/Downloads-Realsteuern/statistischer-bericht-realsteuervergleich-2141010247005.html) is the cited primary entry point. |

**Licence:** the cited metadata/source materials did not establish the licence for each exact table/export. Do not label the extracted values `dl-de/by-2-0` without confirming the dataset's own metadata/terms. Statistical tables can be downloaded, but downloadability is not proof of a particular licence. Preserve statistical source, table number, reference year, retrieval date and the terms presented at export. For federal government statistical data, consult the [Destatis terms of use](https://www.destatis.de/EN/Service/Terms-of-use/terms-of-use.html) and any table-specific metadata.

## 4. National tax-sharing rules (primary law)

Under [§ 1 Gemeindefinanzreformgesetz](https://www.gesetze-im-internet.de/gemfinrefg/__1.html), municipalities receive **15%** of wage tax and assessed income tax, and **12%** of specified capital-income tax receipts. The municipality's allocation is distributed using a municipal key; it is not simply 15% of residents' personal tax bills paid directly to their town. The municipal share of turnover tax is governed by [§ 5a GemFinRefG](https://www.gesetze-im-internet.de/gemfinrefg/__5a.html), with state and municipality distribution keys.

Under [§ 6 GemFinRefG](https://www.gesetze-im-internet.de/gemfinrefg/__6.html), Gewerbesteuerumlage is calculated from actual Gewerbesteuer divided by the municipality's assessment rate and multiplied by the statutory multiplier. The current statutory federal multiplier is **14.5 percentage points** and the state multiplier **20.5 percentage points** (source: § 6(3), linked law; verify version in force for the displayed tax year). Therefore gross Gewerbesteuer receipts and net revenue after the levy are different quantities.

## 5. Existing structured-budget projects

- **OffenerHaushalt.de:** a historical visualisation and dataset frontend; its Strausberg page explicitly says it is not updated ([Strausberg page](https://offenerhaushalt.de/haushalt/BB/Strausberg/); [GitHub project](https://github.com/okfde/offenerhaushalt.de)). Its existence is not evidence of current, complete Strausberg budgets.
- **OpenSpending:** open-source infrastructure for publishing and exploring public finance data ([project](https://github.com/openspending)); no current Strausberg dataset was verified there.
- **GovData:** Germany's federal data portal can be searched at [GovData](https://www.govdata.de/suche); a current Strausberg full-budget dataset was **not found** in the searches undertaken. No claim of Brandenburg-wide budget coverage is made.
- **Brandenburg-specific:** official budget ordinance is discoverable via city statutes and gazette, but detailed plan downloads/current structured budget data were not located (see §1).

## 6. Recommendation for Ledger of Life / Stadtstack atlas

Show a small, dated **revenue-and-spending plan snapshot**, not “what one resident's taxes pay for.” Keep planned amounts, actuals and estimates distinct. Minimum useful fields: `municipality` (AGS, name, district, state), `fiscalYear`, `measure` (e.g. planned ordinary income, planned ordinary expenditure, investment receipts/expenditure, Gewerbesteuer gross/net, Gemeindeanteil Einkommensteuer, Gemeindeanteil Umsatzsteuer, Schlüsselzuweisung), `amountEUR`, `status` (`plan|amendedPlan|actual|estimate`), `period`, `source` (publisher, exact URL, table/page/line), `publishedAt`, `retrievedAt`, `asOf`, `licence` (exact identifier or `unknown`), and `notes` (e.g. gross/net, accounting basis, caveats). Include the full budget-plan lines only once obtainable; derive per-resident figures only with a dated population denominator and clearly label the arithmetic.

Suggested refresh: check city plan/changes on each annual budget adoption and any Nachtrag; update actuals when the annual account is published. Refresh statistical tax data annually when the corresponding table is released, recording its reference year—quarterly cash-statistics releases may be newer but provisional. This is a recommendation, not a claim that Strausberg currently publishes on those schedules. Do not display values as current if their reference year or licence is unknown.

```json
{
  "municipality": {"ags": "12064472", "name": "Strausberg", "district": "Märkisch-Oderland", "state": "Brandenburg"},
  "fiscalYear": 2025,
  "measures": [{
    "id": "gemeindeanteil_einkommensteuer",
    "amountEUR": null,
    "status": "plan",
    "period": "2025",
    "source": {"publisher": "Stadt Strausberg", "url": "https://www.stadt-strausberg.de/wp-content/uploads/2024/11/2024-Amtsblatt_07.pdf", "locator": "Haushaltssatzung; detailed plan annex not online in source examined"},
    "publishedAt": "2024-11-23",
    "retrievedAt": "2026-09-26",
    "asOf": "2025 budget plan",
    "licence": "unknown",
    "notes": "Do not substitute statutory percentage for city amount."
  }]
}
```

The AGS is **12064472**, verified against the official Destatis GV-ISys and Amt für Statistik Berlin-Brandenburg municipal-directory sources ([directory entry point](https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/_inhalt.html); [official statistical profile keyed by Strausberg's ARS](https://www.statistik-berlin-brandenburg.de/zensus/gdb/bev/bb/12/12064/120640472472_Strausberg_Stadt_bev.pdf)). The plan amounts remain unavailable; until the city plan and dataset terms are obtained, publish **source map + missing-value disclosure**, not invented budget totals.

## Not found / next source checks

1. Strausberg full 2025/26 household plan PDF or structured export and its detailed totals/line items; attempted city statutes page, 2024 Amtsblatt, and targeted searches for individual plan figures.
2. Current whole-city Jahresabschluss downloadable online; the accessible notice covered 2018 and inspection, while the more recent annual-account notice found was Stadtforst-only.
3. A machine-readable Strausberg OParl API endpoint.
4. A current, per-municipality BbgFAG allocation download/format specifically exposing Strausberg's allocation.
5. Exact table-export licence for Regionalstatistik 71231; licence requires table/export metadata confirmation.
6. A currently maintained OpenSpending/GovData full-budget dataset for Strausberg; checked the linked project, Strausberg OffenerHaushalt page and portal search.
 
## Legal obligations and where the plan actually is

**Why it is hard to find:** the law requires notice of the Haushaltssatzung and public access to the detailed Haushaltsplan, but the notice/access duty is not equivalent to proactive publication of the complete plan online, much less a machine-readable export. Strausberg's notice follows that model: the ordinance is in the Amtsblatt while components and annexes are offered for inspection at the Finance Department ([2024 Amtsblatt, pp. 24–25](https://www.stadt-strausberg.de/wp-content/uploads/2024/11/2024-Amtsblatt_07.pdf)).

### Statutory duties and access

- BbgKVerf §§ 65–66 govern the Haushaltssatzung and its Haushaltsplan; § 69 governs enactment. Under § 69(5), the Satzung is publicly announced after required approvals/receipt, and the notice identifies where it and its Anlagen can be inspected. The statute provides public display/inspection of the Satzung and Anlagen for seven working days. It does not require online publication or machine-readable formats. The current consolidated law is dated 5 March 2024 and was amended in December 2025; apply the version in force for the budget year.
- The Haushaltsplan is the plan component required by § 66 and is among the documents made available with the Satzung under § 69. Inspection is distinct from a duty to upload the complete plan. Strausberg's gazette notice expressly directs readers to in-person inspection ([Amtsblatt PDF](https://www.stadt-strausberg.de/wp-content/uploads/2024/11/2024-Amtsblatt_07.pdf)).
- Annual-account duties are in BbgKVerf § 80 (not § 82). Section 80 sets preparation/submission and audit/adoption requirements and provides for public notice of the decision and public inspection of the Jahresabschluss and Anlagen for seven working days. Deadlines and transition rules must be read in the version applicable to that accounting year; the adopted 2018 account notice is in the Strausberg Amtsblatt ([p. 2](https://www.stadt-strausberg.de/wp-content/uploads/2024/11/2024-Amtsblatt_07.pdf)). The obligation is public access after adoption, not online publication.
- No general duty to publish municipal budget plans online or as machine-readable open data was identified in Brandenburg's [E-Government Act (BbgEGovG)](https://bravors.brandenburg.de/gesetze/bbegovg) or [Open Data Act (BbgODG)](https://bravors.brandenburg.de/gesetze/bbgodg) that overrides this distinction. Federal [EGovG § 12a](https://www.gesetze-im-internet.de/egovg/__12a.html) applies to data held by federal authorities and certain federal public-law bodies, not automatically to municipalities.
- The EU [Open Data Directive (EU) 2019/1024](https://eur-lex.europa.eu/eli/dir/2019/1024/oj) establishes reuse rules for documents already accessible under national law; it does not itself require all municipal documents to be made accessible. The specified high-value data categories and [Implementing Regulation (EU) 2023/138](https://eur-lex.europa.eu/eli/reg_impl/2023/138/oj) cover geospatial, earth observation/environment, meteorological, statistics, companies and mobility, not municipal budgets as a category.
- Citizens may apply under Brandenburg's [Akteneinsichts- und Informationszugangsgesetz (AIG)](https://bravors.brandenburg.de/gesetze/aig) for access to records held by public bodies. AIG § 1 establishes access in principle; §§ 5–6 concern application/procedure and access, subject to statutory exclusions, protected interests, fees and redaction. Request the complete 2025/26 plan and annexes from the Stadt Strausberg Kämmerei, specifying electronic copies; this is an access request, not evidence the plan is online.

### Search for the actual plan and comparison

Targeted web searches for `BV-SVV-2024/0046`, “Haushaltsplan 2025/2026 Strausberg pdf”, the city [statutes page](https://www.stadt-strausberg.de/satzungen-und-verordnungen-2-2/) and [RIS](https://www.ratsinfo-online.de/strausberg-bi) did not surface an accessible plan attachment or downloadable complete plan. The official gazette remains the verified primary document; it points to inspection, and no plan totals are quoted because no underlying plan document was obtained. The RIS may require its own dynamic document search; search-engine absence does not prove that no attachment exists.

Comparable publication demonstrates that online plans are a municipal choice, not a uniform format requirement: [Bernau's budget information](https://www.bernau.de/de/rathaus-service/buergerinformation/haushalt.html) and [“Der Haushaltsplan”](https://www.bernau.de/de/rathaus-service/buergerinformation/haushalt/artikel-der-haushaltsplan.html) provide plan information and documents; [Brandenburg an der Havel's 2025/26 plan component](https://www.stadt-brandenburg.de/fileadmin/pdf/20/HH-Plan_2025-2026/01_02_Vorbericht_Haushaltssatzung_Beschluss_2025_2026.pdf) is a downloadable PDF.

### Is the 2018 annual account backlog exceptional?

No. Reporting on Brandenburg municipalities described widespread delays in audited annual accounts and cited staffing capacity; examples included municipalities whose last audited accounts were several years old ([Tagesspiegel, 21 March 2023](https://www.tagesspiegel.de/potsdam/brandenburg/wenn-der-abschluss-fehlt-nach-der-umstellung-auf-die-doppik-droht-brandenburgs-kommunen-ungemach-9532265.html)). This is backlog context, not a claim about the cause of Strausberg's delay. The Strausberg notice says its 2018 account was adopted in 2024 ([Amtsblatt p. 2](https://www.stadt-strausberg.de/wp-content/uploads/2024/11/2024-Amtsblatt_07.pdf)).
