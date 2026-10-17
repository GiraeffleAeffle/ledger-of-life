# R1 nine-town registered-source bounded crawl preparation — 2026-10-13

## Decision and execution boundary

**Prepared, not executed. No nine-town crawl is authorized or started by this report.** The plan inventories **41 registered non-structured source scopes**, recommends **40 source-scoped commands**, and excludes the Hagenow council login. BOB-SH's three scopes are first-pass municipal discovery/inventory checks, not evidence that local planning is absent.

Repository/code baseline: `e73da04ede06a121f5cc212ca52fcf0a6606f482`. Registry SHA-256, both committed Git blob and current checkout: **`e2d0a0ebd8ce3078c7f1a5ece8d50a2540bf25b65a14313f4220967cdcad8041`**. Their bytes were compared and are identical. Last commit touching that file is `9aa41678b66d27338bfce222436f072d99d6a23b`; choosing the full current commit still supplies an authenticated proof of the same registry. The single registered structured GENESIS route is intentionally outside this plan. Do not invoke an unfiltered whole-registry crawl: the standalone crawler does not itself filter out kind=structured or known login sources.

**Pre-run holds:**

1. Main requires the standalone crawler to consume the committed host-spacing configuration before any nine-town run. It currently does not. See §2 for the exact minimal fix and an important correction: current adapters use the municipal **5-second** profile, so it is incorrect to claim these source commands presently fetch at 2 seconds. The owner's ≥2.5-second floor is satisfied by that profile, but config wiring is still a required integration closure.
2. Freeze reviewed code and parser-image contracts, obtain owner authorization for this bounded acquisition scope and production managed-root writes, and coordinate the shared policy-state client. K1-only bounded-unattended permission is **not** permission for these 40 crawls. The standalone CLI has no R1 preauthorization/notification wrapper; operator supervision and the actual nine-town authorization cannot be inferred from its success.
3. Crawl output is not automatically R1 residual-job input. The queued residual path has a corpus-authorization gate gap, and the authenticated import/admission bridge is missing. These are findings, not instructions to bypass either boundary (§6).

Only this report was created. Performed: local source/docs/ops reference reads, immutable Git blob identification, explicitly requested **pure selection validation**, read-only current codec hashing and `assertCivicPolicyAuthority`. Not performed: source requests, crawl, Docker/parser/model execution, registry descriptor generation/import, production database access or writes, policy-authority writes, source edits, build/test/lint/format runs. No file under `~/civic-0.3.2-resume` was changed. Historical production operations below are attributed to documents, not new receipts or observations.

## 1. Canonical registry-config IMPORT descriptor

### Code path and exact meanings

- [`src/district-r1.ts:359–368`](../src/district-r1.ts): `knowledge:r1 registry-descriptor --commit <commit> --output <new-directory>`. This branch runs before the DB-dependent commands and accepts exactly those four arguments. Output must be a **new child directory** under `stadtstack-data/cache/districts/r1-operator`.
- [`src/district-registry-config.ts:40–73`](../src/district-registry-config.ts): `buildOperatorRegistryConfigDescriptor` reads `stadtstack-data/sources/district-registry.json` from the requested **Git commit**, not the mutable checkout; validates metadata/schema; authenticates blob, commit and three tree OIDs; writes private exclusive proof files. Its Git environment disables hooks/global/system config/attributes.
- Outputs in that new directory: `district-registry.json`, `commit-<full-commit>.bin`, three `tree-<oid>.bin` files, and `operator-registry-config.json`. Stdout returns actual `descriptorPath`, `descriptorSha256`, `configurationSha256`, `gitCommit`. Proof directory is mode 0700, files 0600, `wx`.
- The builder creates a **descriptor**, not an IMPORT descriptor or managed source pin. Construct the IMPORT descriptor with the **existing** `operatorRegistryConfigImportSchema` by adding exactly `managedRoot` and `destinationPath` to that descriptor. A bare registry JSON path, a source pin, or the descriptor's own hash is not a substitute for `--registry-config-import` plus the IMPORT file's hash.
- The contract hash covers twelve current source files (registry-config, registry/schema/Git/retained/private-I/O/lineage/policy/origin-contract/fetch/address/authority codecs; lines 75–78). Read-only observed current contract: `69b3c88405e610b223176cf118165bca97998c4affae8ad5fdc6493064b02e80`. Recompute using the canonical builder after any relevant code change; never copy a 0.3.2 contract hash into an R1 descriptor. The registry commit and the executing code-contract pin are distinct.

### Exact operator commands — NOT RUN

Run these only under the final reviewed code, from the R1 package, with a fresh output directory. No production import is included in this descriptor-generation block. It is deliberately documented rather than run because this assignment permits creation of **only this report**.

```sh
umask 077
export PATH=/home/max/.local/share/mise/installs/node/24.21.0/bin:$PATH
export PKG=/home/max/civic-rebuild-r1/stadtstack-data
export REGISTRY_COMMIT=e73da04ede06a121f5cc212ca52fcf0a6606f482
export PROOFS="$PKG/cache/districts/r1-operator/nine-town-2026-10-13-e73da04"
export CONFIG_ROOT="$PKG/cache/districts/r1-nine-town-2026-10-13-control"
cd "$PKG"
npm run knowledge:r1 -- registry-descriptor --commit "$REGISTRY_COMMIT" --output "$PROOFS"
export REGISTRY_DESCRIPTOR_JSON="$PROOFS/operator-registry-config.json"
export REGISTRY_IMPORT_JSON="$PROOFS/registry-config-import.json"
node --experimental-strip-types --input-type=module <<'NODE'
import {readFile,writeFile} from 'node:fs/promises';
import {operatorRegistryConfigSchema,operatorRegistryConfigImportSchema} from './src/district-registry-config.ts';
import {sha256} from './src/district-schema.ts';
const descriptorBytes=await readFile(process.env.REGISTRY_DESCRIPTOR_JSON);
const descriptor=operatorRegistryConfigSchema.parse(JSON.parse(descriptorBytes.toString('utf8')));
const input=operatorRegistryConfigImportSchema.parse({
  ...descriptor,managedRoot:process.env.CONFIG_ROOT,destinationPath:'registry.json'
});
const importBytes=Buffer.from(JSON.stringify(input,null,2)+'\n');
await writeFile(process.env.REGISTRY_IMPORT_JSON,importBytes,{flag:'wx',mode:0o600});
console.log(JSON.stringify({
  descriptorPath:process.env.REGISTRY_DESCRIPTOR_JSON,descriptorSha256:sha256(descriptorBytes),
  importPath:process.env.REGISTRY_IMPORT_JSON,importSha256:sha256(importBytes),
  configurationSha256:descriptor.sha256,gitCommit:descriptor.code.gitCommit,
  managedRoot:input.managedRoot,destinationPath:input.destinationPath
}));
NODE
export REGISTRY_DESCRIPTOR_SHA256="$(sha256sum "$REGISTRY_DESCRIPTOR_JSON" | cut -d' ' -f1)"
export REGISTRY_IMPORT_SHA256="$(sha256sum "$REGISTRY_IMPORT_JSON" | cut -d' ' -f1)"
```

The preparation block writes proof/control metadata only; neither the builder nor merely adding IMPORT fields enrolls a managed root. It does **not** call `importOperatorRegistryConfig`. Therefore producing the IMPORT descriptor does **not inherently require** a production authority write. If the proposed proof/control metadata destination is itself already managed, do not write into it without the canonical role/custody admission; choose a new metadata directory or stop with the exact operation for Main. The fresh names above are proposed, not claimed to have been created or inspected for current enrollment.

### First authority-mutating boundary — STOP here

The first `district-crawl.ts` invocation imports the registry at lines 133–140. [`importOperatorRegistryConfig`](../src/district-registry-config.ts) authenticates all declared endpoints against live **local** opt-out state, the Git proof and code contract; then writes `CONFIG_ROOT/registry.json` through `writeManagedSourceArtifact`. This enrolls `CONFIG_ROOT` as **artifacts**, with one `operator_registry_config` binding per declared endpoint, `independentAllowed:false`. Those bindings cover the **entire approved registry endpoint inventory**, not only the selected source. An objection to a declared endpoint can thus reject registry control admission even for another selected source.

`PoliteFetcher.initialize` enrolls the selected raw root as **fetch**; the CLI enrolls the index output root as **artifacts**. Frontiers, source bodies, immutable observations, derived indexes and temporary source-bearing writes use the existing governed writers/scratch lifecycle, not untracked copies. Paths must remain under the R1 package's ignored `cache`; raw and output roots must be separate/nonoverlapping, IMPORT managedRoot must be separate from raw, original proof inputs cannot overlap its destination, and symlink escapes are refused. This plan also separates managedRoot from all output roots. Proposed production managed roots: **1 shared control + 40 raw + 40 index roots = 81**, before any later preparation/CAS/model roots. They are not enrolled by this assignment.

Read-only authority assertion succeeded, yielding authority ID `owner-2026-10-11-codex-workstation`, SHA-256 **`e35c90d1b705a52d739f438ae80b0ab1217db86386826fd9feac2f32329e926f`**, mode `codex-workstation-local`. No reprovisioning was attempted. Operators must assert the same current authority again at execution; a mismatch is a hold, not permission to reset it.

**The exact first managed-write/crawl command is the common function invocation plus its first source call in §4. It is not run.** Do not run the production helper to generate R1 inputs: [`prod032-env.sh`](../../../stadtstack-ops/bin/prod032-env.sh) changes directories and targets the 0.3.2 checkout. Its `registry-import-4.json` is descriptor-4 plus `managedRoot=.../cache/prod032-registry4`, `destinationPath=registry.json`. The reference `prod032-registry-round4.mjs:12–24` both saves descriptors and immediately calls the authority-mutating importer. That latter command must **not** be executed here.

## 2. Bounds and pacing semantics — including findings

D/P/Q/R in the tables mean `--max-documents / --max-pages / --max-requests / --max-rounds`.

- CLI D/P/Q are integers 1–200; rounds 1–10000. Defaults are **8/3/24/1000**. The 1000-round default is not a first bounded pass: the crawler automatically returns to runnable partial frontiers, resetting per-turn adapter budgets. Every recommended executed command explicitly uses **R=1**. No excluded-source 0-bound command is legal; exclusion means **do not invoke it**.
- HTML/document traversal counts **every successful representation**, including root/seed HTML, as a document, not just PDFs. Loop conditions are conjunctive (`district-source-adapters.ts:206–225`): stop on any D/P/Q limit. Therefore P=D for ordinary HTML scopes prevents the low default P=3 from starving later downloads. PDFs are not HTML pages. A cap applies to work this turn, not a lifetime maximum; a resumed frontier may return documents from previous turns. Use fresh planned lanes for a first pass and preserve pending counts.
- Seeds are prepended **before roots** (lines 183–188). Parchim council has **187 seeds and 5 roots**: D=24 is intentionally a small seed-evidence pass; it may never reach roots in this turn. Strausberg planning D=20 is intentionally not all ~230 historically reported links. No claim of archive completeness follows.
- BB DiPlan uses the exact observed POST form, municipality binding, and one API representation before HTML/document work. No statewide 905-procedure response is 905 local procedures. MV uses exact ARS query and `x_GKZ.includes(ags)`, up to P API pages of 100 records each, then a separate HTML-page cap P in document traversal; D does **not** include those API-list requests. P=4, D=12, Q=20 leaves room for discovery and a modest PDF sample, not an exhaustive inventory. BOB requires both exact municipal-code response and independently checked root identity inventory; historically empty scopes have no case-document crawl. No BOB failure falls back to statewide HTML traversal.
- **Q is not a wire-request cap.** `PoliteFetcher.requestCount` increments once per public `fetch()`, not internal robots/TDM or redirect requests (`polite-fetch.ts:384`). HTML Q counts attempted frontier entries; API adapters account for their own public fetch calls. Policy requests, redirect hops and same-process cached API reuse mean console/check counts do not equal HTTP dispatch counts. The ordinary loops remain bounded, but an operator must budget policy/redirect overhead separately. Do not quote Q as an exact total network limit. If owner authorization requires a literal wire cap, that needs a reviewed dispatch-level gate, not a misleading flag label.
- Do **not** add `--page-root` to the general commands. Explicit page/seed selection disables API discovery **and link traversal** entirely (`district-crawl.ts:70`, adapters:226); it is an exact-representation scope, even when called a page root. Overall source coverage remains not_assessed/partial even if targetScope is complete. API page-root selection is rejected. The 0.3.2 patch used this deliberate exact-target mode; this broader bounded pass does not.
- Public gates still apply: actual robots/TDM/access/origin, current objections, SSRF/redirect checks, and 403/429/host stop/cooldown. Owner robots approval does not grant login access, origin, republication rights, current policy, or new corpus authorization. Record actual blocked/excluded/partial outcomes; do not guess alternate endpoints or circumvent barriers.

### Required config wiring and the effective 5-second profile

Finding: `district-crawl.ts:139` constructs `new PoliteFetcher({cacheDir,ownerPolicyLane,policyTtlMs})` without consuming [`sources/district-host-groups.json`](../sources/district-host-groups.json). The shared file requires `minStartIntervalMs:2500`, `maxInFlight:1`; the existing exported strict `HostGroupsSchema` is in `district-r1.ts:79`, used by R1 acquisition at :250–251. There is no standalone CLI spacing flag.

**Minimal fix for Main, not applied:** reuse that existing schema, load/parse `../sources/district-host-groups.json` before constructing the fetcher, extract its sole service group, and add `minDelayMs:group.minStartIntervalMs` at `district-crawl.ts:139`. Add the schema import near its existing imports. The already-existing exact-host queue and private cross-process host lock (`polite-fetch.ts:222–270`) serialize one in flight per actual host; validate maxInFlight=1 through the existing schema rather than adding a second scheduler. Keep source robots Crawl-delay/backoff and stricter profiles. **Per Main's instruction, no nine-town crawl may run before this wiring lands and is reviewed.**

Correction to a constructor-only analysis: `district-source-adapters.ts:29–31` defaults `source.hostProfile` to **municipal**, and none of the 41 registry sources declares an override. `polite-fetch.ts:393` raises the actual host delay to **5000 ms** before robots/TDM. Thus the effective current source spacing is ≥5 seconds, not the constructor's 2000 ms default. Adding minDelayMs=2500 establishes the explicit floor but does **not** lower the municipal profile to 2500. No profile weakening or registry edit is proposed. The requested 2.5-second estimate is a **sizing floor**, with the actual ≥5-second pacing sensitivity reported in §7.

## 3. All 41 registered selections, recommendations and exclusions

Structural validation PASS is not access/legal/runtime permission. All discovery entries carry document-content/legal/TDM gates still to be exercised. The three BOB rows are discovery/inventory-only in the historical zero-result scenario; if a fresh exact-bound procedure exists, its small bounded traversal is permitted only through that existing adapter, never by adding statewide roots. Hagenow publisher is document-only, not generic portal discovery.

| Municipality (AGS) | Source ID | Dispatch / role | Bounds D/P/Q/R | Registered roots / seeds | Offline selection | Source-specific scope note |
|---|---|---|---|---|---|---|
| strausberg (12064472) | `strausberg-planning` | HTML/document | 20/20/24/1 | 1 / 0 | PASS (checkout + commit) | Official Bauleitplanung index; registry records owner report of ~230 public PDF links, not measured completeness. First 20 representations only; keep persistent remainder. |
| strausberg (12064472) | `strausberg-website` | HTML/document | 8/8/12/1 | 1 / 0 | PASS (checkout + commit) | Home/navigation discovery; no registered seed. Relevant same-origin civic links only, not a site-wide mirror. |
| strausberg (12064472) | `strausberg-council` | HTML/document | 16/16/20/1 | 1 / 0 | PASS (checkout + commit) | ALLRIS public si010; historical robots denial retained, owner override is not origin/rights permission. No observed OParl configured. |
| strausberg (12064472) | `strausberg-participation` | diplan-list | 12/12/16/1 | 1 / 2 | PASS (checkout + commit) | DiPlan POST has all filters blank (historical statewide 905); require adapter municipal identity filter. Two seeds: FNP Solarpark Flugplatz PDF and Altstadt Quartier procedure. |
| strausberg (12064472) | `strausberg-gazette` | HTML/document | 12/12/16/1 | 1 / 1 | PASS (checkout + commit) | Neue Strausberger Zeitung/Amtsblatt index plus issue 01/2026 PDF seed; full newspaper text is not blanket official work. |
| hoppegarten (12064227) | `hoppegarten-website` | HTML/document | 8/8/12/1 | 2 / 0 | PASS (checkout + commit) | Two registered roots: homepage and heat-planning news page; small bounded navigation plus both roots, not a heat-plan completion claim. |
| hoppegarten (12064227) | `hoppegarten-council` | HTML/document | 16/16/20/1 | 1 / 0 | PASS (checkout + commit) | SessionNet public root; HTML fallback, OParl unobserved. A shallow pass may discover few documents. |
| hoppegarten (12064227) | `hoppegarten-participation` | diplan-list | 12/12/16/1 | 1 / 1 | PASS (checkout + commit) | Blank-filter statewide DiPlan POST, municipal binding required; registered Schulcampus Lindenallee/Virchowstraße procedure seed. |
| hoppegarten (12064227) | `hoppegarten-gazette` | HTML/document | 12/12/16/1 | 1 / 0 | PASS (checkout + commit) | Amtsblatt index; bounded issue PDFs, dates must come from contents, not directory names. |
| ruedersdorf-bei-berlin (12064428) | `ruedersdorf-bei-berlin-website` | HTML/document | 8/8/12/1 | 2 / 0 | PASS (checkout + commit) | Homepage and registered Kommunale Wärmeplanung root; keep page-date separate from project start/completion. |
| ruedersdorf-bei-berlin (12064428) | `ruedersdorf-bei-berlin-council` | HTML/document | 16/16/20/1 | 1 / 0 | PASS (checkout + commit) | ALLRIS public HTML root; no guessed OParl; only actual public links. |
| ruedersdorf-bei-berlin (12064428) | `ruedersdorf-bei-berlin-participation` | diplan-list | 12/12/16/1 | 2 / 3 | PASS (checkout + commit) | DiPlan statewide POST plus municipal Bauleitplanung root; three seeds (two Hybridkraftwerk B-Plan/FNP PDFs, Biomassezentrum page), two configured origins. Preserve distinct instruments. |
| ruedersdorf-bei-berlin (12064428) | `ruedersdorf-bei-berlin-gazette` | HTML/document | 12/12/16/1 | 1 / 0 | PASS (checkout + commit) | Gemeindemagazin/bekanntmachungen index; restrict released facts to independently gated sections. |
| ratzeburg (01053100) | `ratzeburg-website` | HTML/document | 8/8/12/1 | 1 / 2 | PASS (checkout + commit) | Homepage plus two official B-Plan 78/FNP 72 public-exhibition PDF seeds; seeds are processed before roots. |
| ratzeburg (01053100) | `ratzeburg-council` | HTML/document | 16/16/20/1 | 3 / 0 | PASS (checkout + commit) | Three registered SessionNet entry roots; HTML discovery, not exhaustive proceedings coverage. |
| ratzeburg (01053100) | `ratzeburg-participation` | HTML/document | 12/12/16/1 | 1 / 1 | PASS (checkout + commit) | Official Bebauungspläne index plus B-Plan 56 second-amendment notice download seed. |
| ratzeburg (01053100) | `ratzeburg-gazette` | HTML/document | 12/12/16/1 | 1 / 1 | PASS (checkout + commit) | Amtliche Bekanntmachungen index plus city-council meeting notice PDF seed. |
| ratzeburg (01053100) | `ratzeburg-bob-sh` | bobsh-list | 4/4/6/1 | 0 / 0 | PASS (checkout + commit) | DISCOVERY/SCOPED-INVENTORY first pass. Exact municipalCode 01053100; historically zero procedures. POST and independent root identity inventory both required; no local inactivity inference. |
| moelln (01053090) | `moelln-website` | HTML/document | 8/8/12/1 | 1 / 0 | PASS (checkout + commit) | Homepage/nav first pass; no seed; only relevant linked civic representations. |
| moelln (01053090) | `moelln-council` | HTML/document | 16/16/20/1 | 1 / 0 | PASS (checkout + commit) | ALLRIS integration si010 HTML root; no observed OParl. Public access gates apply. |
| moelln (01053090) | `moelln-participation` | HTML/document | 12/12/16/1 | 2 / 1 | PASS (checkout + commit) | Registered source URL itself is BP 86 second-amendment Begründung PDF; also registered Bauleitplanung HTML root. Seed PDF and index both matter. |
| moelln (01053090) | `moelln-gazette` | HTML/document | 12/12/16/1 | 1 / 0 | PASS (checkout + commit) | Amtliche Bekanntmachungen index; bounded linked notices. |
| moelln (01053090) | `moelln-bob-sh` | bobsh-list | 4/4/6/1 | 0 / 0 | PASS (checkout + commit) | DISCOVERY/SCOPED-INVENTORY first pass. Exact municipalCode 01053090; historically zero. Empty current result means only this scoped list. |
| schwarzenbek (01053116) | `schwarzenbek-website` | HTML/document | 8/8/12/1 | 1 / 0 | PASS (checkout + commit) | Homepage/nav first pass; no registered seed. |
| schwarzenbek (01053116) | `schwarzenbek-council` | HTML/document | 16/16/20/1 | 1 / 0 | PASS (checkout + commit) | SessionNet owl-it public /schwarzenbek/bi/ root; tenant path not all owl-it municipalities. |
| schwarzenbek (01053116) | `schwarzenbek-participation` | HTML/document | 12/12/16/1 | 1 / 1 | PASS (checkout + commit) | Bauen-Umwelt root plus B-Plan 23 Am Hainholz/Gülzower Straße amendment PDF seed. |
| schwarzenbek (01053116) | `schwarzenbek-gazette` | HTML/document | 12/12/16/1 | 1 / 3 | PASS (checkout + commit) | Amtliche Bekanntmachungen root plus three award PDFs (school lift, roofing, roundabout); no payment inferred from award. |
| schwarzenbek (01053116) | `schwarzenbek-bob-sh` | bobsh-list | 4/4/6/1 | 0 / 0 | PASS (checkout + commit) | DISCOVERY/SCOPED-INVENTORY first pass. Exact municipalCode 01053116; historically zero; do not expand statewide root navigation. |
| ludwigslust (13076090) | `ludwigslust-website` | HTML/document | 8/8/12/1 | 1 / 0 | PASS (checkout + commit) | Homepage/nav first pass; no seed. |
| ludwigslust (13076090) | `ludwigslust-council` | HTML/document | 16/16/20/1 | 1 / 0 | PASS (checkout + commit) | SessionNet ris.ludwigslust.de public root; OParl unobserved. |
| ludwigslust (13076090) | `ludwigslust-participation` | mv-bauleitplan | 12/4/20/1 | 1 / 1 | PASS (checkout + commit) | Gaia GET with ARS 130760090090, each returned record must carry AGS 13076090. Registered TE11/Lewens PDF seed on bauleitplaene-mv.de; new linked origins add policy overhead. |
| ludwigslust (13076090) | `ludwigslust-gazette` | HTML/document | 12/12/16/1 | 1 / 1 | PASS (checkout + commit) | Allgemeine Bekanntmachungen page is also a Biogasanlage Kummer notice seed; duplicate URL de-duplicated, source text required for stage. |
| parchim (13076108) | `parchim-website` | HTML/document | 8/8/12/1 | 1 / 2 | PASS (checkout + commit) | Homepage and two planning notice PDF seeds (B-Plan 54.1 and Vietingshof West); seeds precede home. |
| parchim (13076108) | `parchim-council` | HTML/document | 24/24/28/1 | 5 / 187 | PASS (checkout + commit) | Five ALLRIS public entry roots and 187 registered seeds. Seeds precede roots: first 24 may be seed-only, not discovery of all five roots; preserve pending frontier. |
| parchim (13076108) | `parchim-participation` | mv-bauleitplan | 12/4/20/1 | 1 / 0 | PASS (checkout + commit) | Gaia GET with ARS 130760108108; returned-record x_GKZ must include AGS 13076108, not hostname or textual guess. |
| parchim (13076108) | `parchim-gazette` | HTML/document | 12/12/16/1 | 1 / 1 | PASS (checkout + commit) | Uns Pütt index plus B-Plan 39 first-amendment publication PDF seed. |
| hagenow (13076060) | `hagenow-publisher-gazette` | HTML/document | 12/12/12/1 | 1 / 12 | PASS (checkout + commit) | Independent original Wittich newspaper, 12 exact registered PDF seeds, followLinkedDocuments=false. Official notice sections only (issue 341 pp.3–4); ads/news are not blanket official works. NOT a mirror/access bypass. |
| hagenow (13076060) | `hagenow-website` | HTML/document | 8/8/12/1 | 1 / 0 | PASS (checkout + commit) | Homepage registered; historical municipal-site blockers mentioned in publisher scope. One governed attempt may end blocked; no fallback guessing. |
| hagenow (13076060) | `hagenow-council` | EXCLUDED | 0/0/0/0 | 1 / 0 | PASS (checkout + commit) | EXCLUDE: registered URL is /ratsinfo/logon, ALLRIS Anmeldung; public archive not established. Zero requests, no login/captcha/credential attempts. |
| hagenow (13076060) | `hagenow-participation` | mv-bauleitplan | 12/4/20/1 | 1 / 1 | PASS (checkout + commit) | Gaia GET ARS 130760060060, returned AGS 13076060; registered municipal BP39 PDF seed. Historical Gaia/municipal blockers remain possible; genuine runtime refusal is a hold. |
| hagenow (13076060) | `hagenow-gazette` | HTML/document | 12/12/16/1 | 1 / 0 | PASS (checkout + commit) | Municipal downloadcenter root; historical blockers possible; keep independent publisher scope separate, not a replacement claim. |

## 4. Exact per-source crawl commands — prepared only, DO NOT RUN before holds close

Use this common definition **from the R1 package** after descriptor generation and actual acquisition authorization. It names distinct per-source raw/index roots, always sets every bound, uses only registered municipality/source IDs, and issues source-scoped commands sequentially. It neither starts an all-registry crawl nor relies on a deprecated registry path. The first call is also the exact operation at which control/raw/index root enrollment and source acquisition would begin.

```sh
export AUTHORITY_SHA256=e35c90d1b705a52d739f438ae80b0ab1217db86386826fd9feac2f32329e926f
export CRAWL_PREFIX="$PKG/cache/districts/r1-nine-town-2026-10-13"
crawl_one() {
  local city="$1" source="$2" documents="$3" pages="$4" requests="$5" rounds="$6"
  node --experimental-strip-types src/district-crawl.ts \
    --registry-config-import "$REGISTRY_IMPORT_JSON" \
    --registry-config-import-sha256 "$REGISTRY_IMPORT_SHA256" \
    --policy-authority-sha256 "$AUTHORITY_SHA256" \
    --cache "$CRAWL_PREFIX-$source-raw" \
    --output-root "$CRAWL_PREFIX-$source-index" \
    --municipality "$city" --source "$source" \
    --max-documents "$documents" --max-pages "$pages" \
    --max-requests "$requests" --max-rounds "$rounds" \
    --revalidate-after-hours 24
}
crawl_one strausberg strausberg-planning 20 20 24 1
crawl_one strausberg strausberg-website 8 8 12 1
crawl_one strausberg strausberg-council 16 16 20 1
crawl_one strausberg strausberg-participation 12 12 16 1
crawl_one strausberg strausberg-gazette 12 12 16 1
crawl_one hoppegarten hoppegarten-website 8 8 12 1
crawl_one hoppegarten hoppegarten-council 16 16 20 1
crawl_one hoppegarten hoppegarten-participation 12 12 16 1
crawl_one hoppegarten hoppegarten-gazette 12 12 16 1
crawl_one ruedersdorf-bei-berlin ruedersdorf-bei-berlin-website 8 8 12 1
crawl_one ruedersdorf-bei-berlin ruedersdorf-bei-berlin-council 16 16 20 1
crawl_one ruedersdorf-bei-berlin ruedersdorf-bei-berlin-participation 12 12 16 1
crawl_one ruedersdorf-bei-berlin ruedersdorf-bei-berlin-gazette 12 12 16 1
crawl_one ratzeburg ratzeburg-website 8 8 12 1
crawl_one ratzeburg ratzeburg-council 16 16 20 1
crawl_one ratzeburg ratzeburg-participation 12 12 16 1
crawl_one ratzeburg ratzeburg-gazette 12 12 16 1
crawl_one ratzeburg ratzeburg-bob-sh 4 4 6 1
crawl_one moelln moelln-website 8 8 12 1
crawl_one moelln moelln-council 16 16 20 1
crawl_one moelln moelln-participation 12 12 16 1
crawl_one moelln moelln-gazette 12 12 16 1
crawl_one moelln moelln-bob-sh 4 4 6 1
crawl_one schwarzenbek schwarzenbek-website 8 8 12 1
crawl_one schwarzenbek schwarzenbek-council 16 16 20 1
crawl_one schwarzenbek schwarzenbek-participation 12 12 16 1
crawl_one schwarzenbek schwarzenbek-gazette 12 12 16 1
crawl_one schwarzenbek schwarzenbek-bob-sh 4 4 6 1
crawl_one ludwigslust ludwigslust-website 8 8 12 1
crawl_one ludwigslust ludwigslust-council 16 16 20 1
crawl_one ludwigslust ludwigslust-participation 12 4 20 1
crawl_one ludwigslust ludwigslust-gazette 12 12 16 1
crawl_one parchim parchim-website 8 8 12 1
crawl_one parchim parchim-council 24 24 28 1
crawl_one parchim parchim-participation 12 4 20 1
crawl_one parchim parchim-gazette 12 12 16 1
crawl_one hagenow hagenow-publisher-gazette 12 12 12 1
crawl_one hagenow hagenow-website 8 8 12 1
# EXCLUDED — DO NOT RUN: crawl_one hagenow hagenow-council 1 1 1 1
crawl_one hagenow hagenow-participation 12 4 20 1
crawl_one hagenow hagenow-gazette 12 12 16 1
```

Each output is `$CRAWL_PREFIX-<source-id>-index/index.json`, schema `stadtstack-crawl-index-v1`, plus durable per-source frontier state in its raw root. The file is rewritten during source persistence and again at completion. Do not hash/authorize it while the process is still running, and do not resume a frozen index in place. Each per-source index still contains not_checked rows for the other registry sources; these are deliberate out-of-slice dispositions, not new checks. Source-level console success can contain blocked/no_documents/partial outcomes; inspect the actual index checks, excludedDocuments, and source coverage rather than relying on exit code alone.

The project-level `cache/district-crawl.lock` admits one crawler process. Do not parallelize these commands, steal host locks, or automatically delete an interrupted lock. Coordinate active process identity and owner-controlled recovery. Separate source processes repeat registry import/control persistence and policy cache warmup; they do **not** share process-local robots/TDM/API responses.

## 5. Offline validation actually performed

Called the real exported `validateDistrictCrawlSelection(registry,{municipality,sourceId})` for **every one of the 41 table rows** against both:

1. current `sources/district-registry.json` parsed with `parseOperatorRegistryConfiguration`;
2. exact `git show e73da04ede06a121f5cc212ca52fcf0a6606f482:stadtstack-data/sources/district-registry.json`, parsed with the same code.

**Result: 41/41 PASS in checkout, 41/41 PASS in committed registry; 82 checks, 0 FAIL.** Node process exit 0, stderr empty. Registry hashes above match and byte equality was true. Hagenow council's ID passes membership validation but is intentionally excluded for access reasons. No targets override is used in the planned commands, so no extra target-selection validator was needed. Numerical profiles are within the documented CLI ranges for the 40 executed selections; the excluded row's 0/0/0/0 is an inventory notation, not supplied CLI flags.

Reproduction of the selection check (local only; not a crawler invocation):

```js
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {parseOperatorRegistryConfiguration} from './src/district-registry-config.ts';
import {validateDistrictCrawlSelection} from './src/district-crawl.ts';
const towns=new Set(['strausberg','hoppegarten','ruedersdorf-bei-berlin',
  'ratzeburg','moelln','schwarzenbek','ludwigslust','parchim','hagenow']);
const checkout=parseOperatorRegistryConfiguration(JSON.parse(readFileSync('sources/district-registry.json')));
const committed=parseOperatorRegistryConfiguration(JSON.parse(execFileSync('/usr/bin/git',
  ['show','e73da04ede06a121f5cc212ca52fcf0a6606f482:stadtstack-data/sources/district-registry.json'],
  {cwd:'..',maxBuffer:8*1024*1024}).toString('utf8')));
for(const city of checkout.municipalities.filter(c=>towns.has(c.id)))
  for(const source of city.sources.filter(s=>s.kind!=='structured'))
    for(const registry of [checkout,committed])
      validateDistrictCrawlSelection(registry,{municipality:city.id,sourceId:source.id});
```

This checks registry schema, unique municipality/source membership and current-source IDs, **not** reachability, actual request count, source permission, parser execution, registered body contents, or production inventory-root admission. None of those was simulated or fabricated.

## 6. Crawl indexes → owner-authorized frozen corpora → residual work

### Freeze and authorization (common to both routes)

1. Finish the bounded process; retain exact managed `index.json` bytes, raw SHA-addressed bodies, original immutable observations, registry-control pin and all ancestry. Audit real coverage and exclude withheld bodies; keep explicit negative/partial dispositions. A finite bounded corpus may validly have partial source coverage.
2. Freeze each source index in its existing managed location by **not rewriting it**. Compute SHA-256 of the actual final file. Later resumes must use a distinct index generation while maintaining valid source custody. No plain copy into `out`, report directories or unmanaged “frozen” folders. Any managed copy must be enrolled through canonical writers and preserve actual original bindings. Absolute body/observation paths and the preparation path equality below must remain meaningful.
3. Obtain/record owner approval of the **exact index hash(es)** and bounded source/municipality scope. A registry/robots approval is not a corpus approval. This plan's per-source outputs require up to 40 distinct approved corpus hashes; an optional aggregate would be a **new managed artifact and new exact hash**, with all ancestry and no synthetic date/completeness. Aggregation is not needed to run per-source residual preparation.
4. Main adds only actual owner-authorized SHA-256 literals to `src/district-corpus.ts`'s `authorizedPilotCorpusSchema`, preserving existing approved generations. No wildcard, caller-selected digest acceptance, temporary test hash, fabricated approval, or automatic expansion. Review/commit the allowlist/code closure and corresponding tests/docs before processing. The current eight literals are two historical pilot corpora plus six 0.3.2 round-2/round-3 patch snapshots; **none is a newly acquired nine-town index**.
5. Source/receipt currentness is separate from immutable generation clocks. Keep actual retrievedAt/checkedAt/status and original observation hashes. Expired permission requires legitimate source revalidation/current proof, not merely changing a clock in copied metadata. Corpus authorization does not resurrect opted-out, excluded, login-bound or stale bytes.

### Existing merged direct text-preparation route — real, but not the queue bridge

R1 contains the canonical path used for the earlier patch corpora:

- `district-extract.ts prepare` / npm `knowledge:prepare-text` → `prepareFrozenCorpus` in `district-preparation-run.ts:21–90`.
- It requires `--index`, `--corpus-sha256`, `--raw-root`, pinned `--registry-config` and `--registry-config-sha256`; asserts managed index plus exact operator-control bindings; calls **`loadFrozenCorpus`**, which checks the owner allowlist and byte hash; groups identical bytes per municipality; matches municipality/AGS/district/source; requires source.checkState=checked and source.url.
- For each representation it verifies that `resolve(dirname(index),document.localPath)` equals the exact `rawRoot/sha256/<body-hash>`, then authenticates the actual in-root observation through `readBoundSourceObservation`. No relocated observation or fake body receipt is admitted. It prepares real text through the reviewed sandbox and writes real `PreparedDocument` receipts and `stadtstack-preparation-plan-v1` using the fixed managed prepared/artifact roots. The preparationPlanSchema independently restricts corpusSha256 too.
- Later `district-extract.ts run` / assemble consume the pinned preparation plan, real result receipts and archive the actual generation contracts; they produce native extraction runs, records and quarantine. These are distinct from R1 queued residual StepReceipts. They are not relabelled as queue predecessors.

Operator syntax after exact corpus authorization (variables refer to real produced hashes/paths, not values invented in this report):

```sh
node --experimental-strip-types src/district-extract.ts prepare \
  --index "$NEW_INDEX" --corpus-sha256 "$ACTUAL_APPROVED_CORPUS_SHA256" \
  --raw-root "$SOURCE_RAW_ROOT" \
  --registry-config "$REGISTRY_DESCRIPTOR_JSON" \
  --registry-config-sha256 "$REGISTRY_DESCRIPTOR_SHA256"
```

Do not run this now: it creates managed preparation artifacts and runs parsers. It proves that crawl-index→prepared-text functionality exists; it does **not** create R1 policy receipts, sharded DistrictCas duplicates or residual enqueue manifests.

### What the 0.3.2 production “intake” actually did

Read-only evidence: `~/stadtstack-ops/bin/prod032-env.sh:15–25`, `STATUS_0.3.2.md:45–55,58–61`, `prod032-build-plans.mjs:69–106`, the production prepare-knowledge schema, and R1 [`docs/PIPELINE_HANDOFF.md:149–174`](../docs/PIPELINE_HANDOFF.md). The old handoff's “only old two hashes” statement describes its time; current district-corpus.ts has all eight.

- Three **exact bounded targets**, not nine-town full crawls: Strausberg's registered Solarpark FNP PDF (seed-document mode), Rüdersdorf's registered Wärmeplanung page and Hoppegarten's registered Wärmeplanung page (page-root mode). The helper used **1/1/1/1** and source-specific raw/index generation 3. Page selection intentionally collected that page only, not all links.
- Actual round-2 and round-3 index digests were appended to the corpus allowlist (status says append-only). Current round-3 approved literals: Strausberg `1306a37e00e47505bd9f8f13a80521587cb6efd41ad2a9a945b00b4b8446225d`; Rüdersdorf `5dcbf35e456d0c2fc04dd7ecfd3cb069f76020ffbb67c5bd245e1bacb7193db6`; Hoppegarten `9aae0d802de6aeb9b349bef5cd9862ceb573091dbad45f121bfacb39ad8f600a`. Round-2 literals remain to authenticate existing prepared plans; they are not permission for new source bytes.
- Real native preparation/extraction was then run; the status records approved run order Rüdersdorf native5 → Strausberg native5 → Hoppegarten native7, with native6 rejected and not used, and the actual gpt-6.1-sol results. The production builder authenticates preparation/work/results/prepared receipts, reads **index3**, requires its hash to equal the native run's corpus hash, and builds native contributions plus retained-publication baseline.
- The old production `stadtstack-managed-knowledge-intake-v1` plan consumed **completed native runs/prepared admissions + retained public baseline**, not raw indexes alone. Its intake/publication/replay ran genuine publication-side gates. Descriptor-3 failed replay after codec code changed; descriptor/import-4 pinned the final current contract for the same approved registry, followed by fresh generation-9 roots. Do not reuse invalid prior generations or copy their receipts as R1 evidence.
- R1 intentionally replaced that old plan-based intake/publication interface (`R1_STATUS.md:25`). Its current `prepare-knowledge.ts` / `knowledge:prepare` uses explicit `--records`, `--quarantine`, optional authenticated `--text-composition`, independently pinned `--private-provenance`, and other real admission inventories. It checks each native contribution's **authorized corpus hash at line 67**, then writes prepared publication outputs. Package scripts contain **no knowledge:intake** entry; no district-intake module was found. The ops builder imports deleted donor schemas and **must not be run against R1**.

**Conclusion:** the merged direct preparation path exists; the production publication-intake path has a genuine R1 replacement, but **neither is a raw-crawl→R1 PolicyReceipt/CAS/residual-input bridge**.

### Queued residual gate gap — confirmed statically

`ResidualInputSchema` (`district-residual-jobs.ts:21`) uses generic `HashSchema` for corpusSha256. `loadResidualSource` at :39 reads `cas.read(input.corpusSha256)` then **`frozenCorpusSchema`**, without `authorizedPilotCorpusSchema` or `loadFrozenCorpus`. `enqueueResidualPreparation` (:107–110), the execution sourceScoped/admitted paths (:62–69,97–104), committed extraction enqueue (:112–121), and the R1 CLI (:425–433) contain **no compensating corpus allowlist check**. CAS enforces exact byte hash/private filesystem bounds, not owner scope authorization. The function also does not assert the corpus's managed operator-config/observation ancestry before reading it, unlike prepareFrozenCorpus.

Therefore **any CAS-stored hash containing a schema-valid index can satisfy the corpus-hash portion of queued enqueue/execution**, provided the selected original, admitted registry, valid current PolicyReceipt, observation/body and remaining source gates pass. It does **not** admit arbitrary unapproved source bytes without those other gates. Publication composition later enforces the corpus allowlist in `prepare-knowledge.ts:67`, but that is too late to stop unapproved parser/model execution. This is a real execution authorization gap, not proof that models ran improperly. No exploit or synthetic execution was attempted.

**Minimal closure:** apply the shared authorized-corpus schema in `ResidualInputSchema` and defensively at the `loadResidualSource` corpus load boundary (or a shared pure byte-loader used by file and CAS routes), verify managed exact-index ancestry there, and keep source/receipt gates. Add unauthorized-hash rejection tests for both enqueue and execute paths. Do not force the operator to “solve” it by adding arbitrary hashes.

### Proposed minimal bridge design and file-level slices — NOT IMPLEMENTED

This design is for Main's next implementation assignment, not an executable claim about this tree:

1. **Pacing/config slice:** `src/district-crawl.ts`, existing `HostGroupsSchema`/config, `test/district-crawl.test.ts` (and existing R1 config tests if extraction of the shared schema is chosen). Read the same strict config and enforce its min interval; retain 5-second municipal/robots/backoff rules and one host in flight. No crawling needed to test dispatch options/serialization.
2. **Corpus admission slice:** `src/district-corpus.ts`, `src/district-residual-jobs.ts`, existing corpus/residual tests. Share exact authorized digest + bytes validation; make it unavoidable at residual enqueue and execution; check complete operator/HTTP ancestry of the corpus CAS member. Only add the eventual **actual owner-approved** nine-town hashes after acquisition, not during design.
3. **Authenticated import/admission slice:** preferably an exported, bounded `importCrawlCorpusForResidual` alongside the existing loader in `src/district-residual-jobs.ts`, wired as an explicit `district-r1.ts` command. Use existing helpers, not a second policy engine: `readOperatorRegistryInputPin` / `persistOperatorRegistry`, `loadFrozenCorpus`, managed index binding assertions, `readBoundSourceObservation`, `HttpObservationProofSchema` / `authenticatedHttpBinding`, `createPolicyReceipt`, `persistR1Representation`, `DistrictCas.put` inside existing managed writers, and store.addArtifact.
   - Inputs: independent index hash/path and original raw root, exact registry descriptor pin, explicitly selected document IDs, registered AdapterScope identities (publisherId, sourceId, municipalityId, AGS, tenant, observationWindow), declared permission and real per-document residual bounds. Authenticate selected documents against the frozen index and registered scope; never infer publisher identity from a host or a quote. No networking, models or implicit queue execution in import.
   - Validate every chosen original's actual managed observation/body and current source policy. The observation is copied **byte-for-byte** and retains original observationId/hash/clocks. Derive a new current PolicyReceipt only via createPolicyReceipt and actual rechecked evidence; stale source policy requires separately authorized revalidation, not a forged checkedAt. Preserve the registry-approved URL host/municipal identity and the recorded request selector; if a request/body/redirect chain cannot be recovered from actual evidence, hold that document rather than inventing a POST body or redirect history.
   - Persist the exact original index bytes to managed sharded CAS under **both** registry-control and actual HTTP/denial ancestry; keep its actual approved SHA unchanged. Authenticate dependencies for the full index, including negative audit entries, not just selected model documents. Persist selected originals/PolicyReceipts/immutable observations with persistR1Representation, whose existing code commits content-free PG audit before purgable CAS duplication. Enroll registry CAS through persistOperatorRegistry. Do not write untracked CAS files.
   - Output genuine `ResidualInputSchema` manifests: documentId, approved corpusSha256, exact registrySha256 and descriptor pin, actual policyReceiptSha256, actual httpObservation ID/hash, maxDocuments=1, maxChunks≤24, maxModelCalls 2–48, paidMicroUsd=0. One selected original per job; identical-byte municipal grouping needs explicit selection without fabricating aliases. Unsupported ZIP/GML MIME handling stays as the existing residualMimeSupported gate, not automatic synthetic text conversion.
   - Only after successful import should operators use the existing enqueue-residual-preparation command. Execution needs separately approved R1 job keys/lanes. enqueue-residual-extraction must continue to consume the **actual committed succeeded preparation job** and its StepReceipt/prepared hash; never synthesize acquire/preparation receipts or relabel old direct runs as queue predecessors.
4. **Coverage/export interface:** `src/district-r1.ts`, `src/district-r1-state.ts`, existing residual/export and composition tests, README/status documentation. If the import exposes an acquisition descriptor, factor/reuse existing private descriptor/audit persistence rather than copying its schema; identify it as authenticated **imported observation**, not a live acquire_representation StepReceipt. Existing export-text-contribution already requires a genuine sealed native run/composition; importing crawl originals does not magically provide that run. Keep direct preparation/extraction and queued extraction identities distinct, and require real run assembly/archive before publication export.

These slices share the existing registry/policy/HTTP contracts. The bridge is production-state-writing and must receive separate authority/DB permission before running. Its absence does **not** block preparing this plan or later acquisition under an approved crawl-only scope, but it blocks claiming automatic queued residual readiness. Main should run the coordinated tests/review after implementation; this assignment did not.

## 7. Per-source requests, sandbox volume and wall-time

### What is counted after the throughput changes

Current `polite-fetch.ts:501–563` runs resource-policy, exact-byte origin classification and PDF metadata/version commands sequentially in **one source-owned representation sandbox**. This replaces the old 2–4-sandboxes-per-document model. Robots and standardized TDM are still separate policy representations. They amortize **per origin per PoliteFetcher process**, not across these 40 separate commands. 404/410 policy absence performs no representation inspection, hence no policy sandbox; an inspectable policy body normally adds one. 304 documents still need current inspection of retained bytes. Blocked/error/excluded representations may inspect before being rejected, or stop before a sandbox.

Planning formula: **B ≈ N + R + T**, where N is all source/API HTML/PDF/JSON/etc representations reaching inspection, R inspected robots bodies, T inspected TDM bodies. No separate extra sandbox is charged for PDF version/XMP when co-located. For O initially configured origin sessions, cold wire baseline is approximately **N + 2O**, sandbox baseline **N + O** if robots is inspectable and standardized TDM absent, or **N + 2O** if both are inspectable. Known policy URLs for these nine API scopes are only /robots.txt and are filtered out of additional TDM retrieval at fetcher:420; **do not add nine extra TDM calls**. New linked document origins, redirects, policy TTL expiry, failures and actual robots Crawl-delay add uncertainty.

The following is a **healthy-source modeling assumption, not measured demand or yield**. N includes API-list/root inventory fetches; its low/high scenario is a scheduling estimate, not a lower guarantee. A blocked source can deliver **zero admitted documents** with nonzero requests/sandboxes. BOB's N=2 assumes its historical exact-scoped zero result remains zero. If new procedures exist, BOB can use up to two discovery + four document representations (six total) and remains within Q=6. Municipal home/council roots can also have no qualifying expansion. Columns O use known configured roots/seeds/API origins; newly discovered origins are not counted in O.

| Source ID | Healthy fetched representations / fetch calls N (assumption) | Attempt ceiling Q | Configured origin sessions O | Approx. inspection sandboxes N+R+T |
|---|---:|---:|---:|---:|
| `strausberg-planning` | 10–20 | 24 | 1 | 11–22 |
| `strausberg-website` | 3–8 | 12 | 1 | 4–10 |
| `strausberg-council` | 5–16 | 20 | 1 | 6–18 |
| `strausberg-participation` | 6–13 | 16 | 1 | 7–15 |
| `strausberg-gazette` | 6–12 | 16 | 1 | 7–14 |
| `hoppegarten-website` | 3–8 | 12 | 1 | 4–10 |
| `hoppegarten-council` | 5–16 | 20 | 1 | 6–18 |
| `hoppegarten-participation` | 6–13 | 16 | 1 | 7–15 |
| `hoppegarten-gazette` | 6–12 | 16 | 1 | 7–14 |
| `ruedersdorf-bei-berlin-website` | 3–8 | 12 | 1 | 4–10 |
| `ruedersdorf-bei-berlin-council` | 5–16 | 20 | 1 | 6–18 |
| `ruedersdorf-bei-berlin-participation` | 6–13 | 16 | 2 | 8–17 |
| `ruedersdorf-bei-berlin-gazette` | 6–12 | 16 | 1 | 7–14 |
| `ratzeburg-website` | 3–8 | 12 | 1 | 4–10 |
| `ratzeburg-council` | 5–16 | 20 | 1 | 6–18 |
| `ratzeburg-participation` | 6–12 | 16 | 1 | 7–14 |
| `ratzeburg-gazette` | 6–12 | 16 | 1 | 7–14 |
| `ratzeburg-bob-sh` | 2–2 | 6 | 1 | 3–4 |
| `moelln-website` | 3–8 | 12 | 1 | 4–10 |
| `moelln-council` | 5–16 | 20 | 1 | 6–18 |
| `moelln-participation` | 6–12 | 16 | 1 | 7–14 |
| `moelln-gazette` | 6–12 | 16 | 1 | 7–14 |
| `moelln-bob-sh` | 2–2 | 6 | 1 | 3–4 |
| `schwarzenbek-website` | 3–8 | 12 | 1 | 4–10 |
| `schwarzenbek-council` | 5–16 | 20 | 1 | 6–18 |
| `schwarzenbek-participation` | 6–12 | 16 | 1 | 7–14 |
| `schwarzenbek-gazette` | 6–12 | 16 | 1 | 7–14 |
| `schwarzenbek-bob-sh` | 2–2 | 6 | 1 | 3–4 |
| `ludwigslust-website` | 3–8 | 12 | 1 | 4–10 |
| `ludwigslust-council` | 5–16 | 20 | 1 | 6–18 |
| `ludwigslust-participation` | 6–16 | 20 | 2 | 8–20 |
| `ludwigslust-gazette` | 6–12 | 16 | 1 | 7–14 |
| `parchim-website` | 3–8 | 12 | 1 | 4–10 |
| `parchim-council` | 12–24 | 28 | 1 | 13–26 |
| `parchim-participation` | 6–16 | 20 | 1 | 7–18 |
| `parchim-gazette` | 6–12 | 16 | 1 | 7–14 |
| `hagenow-publisher-gazette` | 6–12 | 12 | 1 | 7–14 |
| `hagenow-website` | 3–8 | 12 | 1 | 4–10 |
| `hagenow-council` | 0 (excluded) | 0 | 0 | 0 |
| `hagenow-participation` | 6–16 | 20 | 2 | 8–20 |
| `hagenow-gazette` | 6–12 | 16 | 1 | 7–14 |

### Whole-pass arithmetic and estimate

- **40 executed selections; 1 excluded.** Sum of adapter public-fetch/attempt budgets **Q=630** (not a wire cap).
- Healthy-source central scenario **N≈204–477** fetched representations. Bounded successful-representation envelope allowing four MV API pages per source and newly nonempty BOB lists is **N≤489**; discarded/refused inspected representations can add work without increasing that admitted count. D is not a yield promise.
- Initially configured **43 origin sessions** across the 40 separate processes: all but Rüdersdorf participation, Ludwigslust participation and Hagenow participation have one known origin; those three have two. This repeats the same city/portal host policies across processes. Unknown API-discovered file hosts can increase O.
- Central **B≈247–563** inspection sandboxes (204+43 to 477+86); bounded successful envelope **≤575** (489+86), before additional origins/expiry/refused inspections. A highly conservative one-inspection-per-attempt estimate is **≤716** (630+86), **not** a strict sandbox bound under redirects/renewals. Index/frontier/control write scratch leases are not counted as Docker parser sandboxes.
- Cold no-redirect wire scenario **N+86≈290–563** requests. At a hypothetical exactly **2.5-second** serial start spacing this contributes about **12.1–23.5 minutes**, using request-count×spacing as a conservative simple additive budget (first request does not require a full preceding interval). Using all attempted Q plus policies gives **716×2.5≈29.8 minutes**. These are pacing scenarios, not total runtime bounds. Real municipal source profile is **≥5 seconds**, so corresponding pacing-only values are approximately **24.2–46.9 minutes**, or **59.7 minutes** at attempted Q. Hosts may impose longer delays/cooldowns, and inventory/sandbox work often already exceeds the spacing, so simply adding the full spacing budget can double-count idle time.

**Wall-time planning, all [INFERENCE]:** [the throughput analysis](r1-throughput-options-2026-10-13.md) supplied ~55 seconds per sandbox before the lifecycle coalescing, not a measured post-merge timing. Its modeled saving was ~12 seconds for 8/9→6/7 inventory load/save cycles. Use **~43 seconds per sandbox as a provisional post-change assumption**, not an observation. That gives **~3.0–6.7 hours** for B=247–563 inspection lifecycle cost alone; 575 successful-envelope sandboxes is ~6.9 hours, and 716 attempted-envelope sandboxes ~8.6 hours. If post-change cost remains 55 seconds rather than 43, the central sandbox-only range is **~3.8–8.6 hours**.

Successful representations also incur actual managed-body/observation admission writes and frontier/index writes. There are 40 repeated control imports, one-source persist plus final persist per process (about **80 index persists**), durable source/frontier work, and growing shared-inventory cost. The coalesced parser sandbox model does not cover those writes. Assuming **another 10–25 seconds per successful representation** for admission/frontier bookkeeping adds approximately **0.6–3.3 hours** for N=204–477, before fixed control/index overhead. This bookkeeping assumption is deliberately not claimed measured; the existing analysis and status do not supply a post-change end-to-end crawl timing.

**Recommended planning window: roughly 4–10 hours for this entire first pass, potentially longer** if actual sandbox costs remain near 55 seconds, additional policy origins appear, registry/index ancestry writes are expensive, or inventory grows. Allow a supervised workday rather than promising a <2-hour batch. Pure pacing alone is minutes; governed inventory/sandbox lifecycle is hours. Rapid refusal can end much earlier with few admitted documents. No hard completion ETA or exhaustive source coverage is warranted without a first real authorized pilot measurement. This estimate excludes later freeze review, owner approvals, corpus/CAS import, text preparation, models, A/B/C, publication and replay. Do not extrapolate the old “~26 hours at ten documents” four-sandbox model after the co-location change; equally, do not advertise “one sandbox” as the entire cost of a fetched document.

## 8. Main's remaining checks and execution prerequisites

This preparation's requested offline selection check is complete. All other runtime evidence is explicitly absent. Main should close and coordinate, **not run under this report's authority**:

- Strict host-config wiring review/test, keeping municipal/robots/backoff safety; no source code was modified here.
- Corpus allowlist enforcement at queued enqueue and execute, with negative tests, exact index ancestry and owner-authorized hash additions only after real freeze.
- Reviewed offline managed crawl→R1 import bridge, CAS/observation/current-policy rejection tests and actual PG admission under approved state-writing authority. Confirm imported evidence never fabricates an acquisition StepReceipt.
- Final immutable code/registry/image pins and parser review, genuine nine-town acquisition authorization, actual root inventory capacity/admission, shared-host/policy-client coordination, ntfy/operator supervision appropriate to the approved mode. Read-only authority assertion here is not these execution permissions.
- After a bounded authorized run: report observed fetch/wire counts separately, per-source partial/blocked/excluded/empty scopes, actual sandbox/runtime overhead, final corpus hashes and owner approvals. No current site availability is inferred from historical registry discovery.

## Appendix: exact committed source endpoints and initial registered roots

These URLs were read from the current committed registry; none was requested over the network. The general commands in §4 use the complete registered roots/seeds through their source ID. Seed counts are shown rather than duplicating all 187 Parchim targets. API forms, municipal binding and seed documents remain in the pinned registry, not manually guessed command parameters.

### strausberg-planning

- Registered URL: https://www.stadt-strausberg.de/bauleitplanung-2/
- Registered page roots (1):
  - https://www.stadt-strausberg.de/bauleitplanung-2/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.stadt-strausberg.de.

### strausberg-website

- Registered URL: https://www.stadt-strausberg.de/
- Registered page roots (1):
  - https://www.stadt-strausberg.de/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.stadt-strausberg.de.

### strausberg-council

- Registered URL: https://strausberg.allris.cloud/public/si010
- Registered page roots (1):
  - https://strausberg.allris.cloud/public/si010
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://strausberg.allris.cloud.

### strausberg-participation

- Registered URL: https://bb.beteiligung.diplanung.de/verfahren/altstadtquartier-srb/public/detail
- Configured API: POST https://bb.beteiligung.diplanung.de/list/json (diplan-list)
- Registered page roots (1):
  - https://bb.beteiligung.diplanung.de/verfahren/altstadtquartier-srb/public/detail
- Registered seeds: 2; followLinkedDocuments: true.
- Initial configured origin(s): https://bb.beteiligung.diplanung.de.

### strausberg-gazette

- Registered URL: https://www.stadt-strausberg.de/neue-strausberger-zeitung/
- Registered page roots (1):
  - https://www.stadt-strausberg.de/neue-strausberger-zeitung/
- Registered seeds: 1; followLinkedDocuments: true.
- Initial configured origin(s): https://www.stadt-strausberg.de.

### hoppegarten-website

- Registered URL: https://www.gemeinde-hoppegarten.de/
- Registered page roots (2):
  - https://www.gemeinde-hoppegarten.de/
  - https://www.gemeinde-hoppegarten.de/news/1/1240589/nachrichten/kommunale-w%C3%A4rmeplanung-in-hoppegarten.html
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.gemeinde-hoppegarten.de.

### hoppegarten-council

- Registered URL: https://ratsinfo.gemeinde-hoppegarten.de/
- Registered page roots (1):
  - https://ratsinfo.gemeinde-hoppegarten.de/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://ratsinfo.gemeinde-hoppegarten.de.

### hoppegarten-participation

- Registered URL: https://bb.beteiligung.diplanung.de/verfahren/eb568622-04ec-41e7-8069-fd8204fa88d8/public/detail
- Configured API: POST https://bb.beteiligung.diplanung.de/list/json (diplan-list)
- Registered page roots (1):
  - https://bb.beteiligung.diplanung.de/verfahren/eb568622-04ec-41e7-8069-fd8204fa88d8/public/detail
- Registered seeds: 1; followLinkedDocuments: true.
- Initial configured origin(s): https://bb.beteiligung.diplanung.de.

### hoppegarten-gazette

- Registered URL: https://www.gemeinde-hoppegarten.de/amtsblatt/index.php
- Registered page roots (1):
  - https://www.gemeinde-hoppegarten.de/amtsblatt/index.php
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.gemeinde-hoppegarten.de.

### ruedersdorf-bei-berlin-website

- Registered URL: https://www.ruedersdorf.de/
- Registered page roots (2):
  - https://www.ruedersdorf.de/
  - https://www.ruedersdorf.de/meine-gemeinde/konzepte/kommunale-waermeplanung/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.ruedersdorf.de.

### ruedersdorf-bei-berlin-council

- Registered URL: https://ratsinfo-online.net/ruedersdorf-bi/allris.net.asp
- Registered page roots (1):
  - https://ratsinfo-online.net/ruedersdorf-bi/allris.net.asp
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://ratsinfo-online.net.

### ruedersdorf-bei-berlin-participation

- Registered URL: https://bb.beteiligung.diplanung.de/plan/bplan53biomassezentrum
- Configured API: POST https://bb.beteiligung.diplanung.de/list/json (diplan-list)
- Registered page roots (2):
  - https://bb.beteiligung.diplanung.de/plan/bplan53biomassezentrum
  - https://www.ruedersdorf.de/meine-gemeinde/bauen-und-wohnen/bauleitplanung/
- Registered seeds: 3; followLinkedDocuments: true.
- Initial configured origin(s): https://bb.beteiligung.diplanung.de, https://www.ruedersdorf.de.

### ruedersdorf-bei-berlin-gazette

- Registered URL: https://www.ruedersdorf.de/politik-verwaltung/bekanntmachungen/gemeindemagazin/
- Registered page roots (1):
  - https://www.ruedersdorf.de/politik-verwaltung/bekanntmachungen/gemeindemagazin/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.ruedersdorf.de.

### ratzeburg-website

- Registered URL: https://www.ratzeburg.de/
- Registered page roots (1):
  - https://www.ratzeburg.de/
- Registered seeds: 2; followLinkedDocuments: true.
- Initial configured origin(s): https://www.ratzeburg.de.

### ratzeburg-council

- Registered URL: https://session.ratzeburg.de/ri/?fdirect=1
- Registered page roots (3):
  - https://session.ratzeburg.de/ri/?fdirect=1
  - https://session.ratzeburg.de/ri/default.php
  - https://session.ratzeburg.de/ri/info.php
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://session.ratzeburg.de.

### ratzeburg-participation

- Registered URL: https://www.ratzeburg.de/Stadtentwicklung/Bauleitplanung/Bebauungspl%C3%A4ne-der-Stadt-Ratzeburg
- Registered page roots (1):
  - https://www.ratzeburg.de/Stadtentwicklung/Bauleitplanung/Bebauungspl%C3%A4ne-der-Stadt-Ratzeburg
- Registered seeds: 1; followLinkedDocuments: true.
- Initial configured origin(s): https://www.ratzeburg.de.

### ratzeburg-gazette

- Registered URL: https://www.ratzeburg.de/B%C3%BCrgerservice/Bekanntmachungen-Ortsrecht/Amtliche-Bekanntmachung/
- Registered page roots (1):
  - https://www.ratzeburg.de/B%C3%BCrgerservice/Bekanntmachungen-Ortsrecht/Amtliche-Bekanntmachung/
- Registered seeds: 1; followLinkedDocuments: true.
- Initial configured origin(s): https://www.ratzeburg.de.

### ratzeburg-bob-sh

- Registered URL: https://bob-sh.de/
- Configured API: POST https://bob-sh.de/list/json (bobsh-list)
- Registered page roots (0):
  - None; do not add statewide roots.
- Registered seeds: 0; followLinkedDocuments: false.
- Initial configured origin(s): https://bob-sh.de.

### moelln-website

- Registered URL: https://www.moelln.de/
- Registered page roots (1):
  - https://www.moelln.de/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.moelln.de.

### moelln-council

- Registered URL: https://www.moelln.sitzung-online.de/integration/si010
- Registered page roots (1):
  - https://www.moelln.sitzung-online.de/integration/si010
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.moelln.sitzung-online.de.

### moelln-participation

- Registered URL: https://www.moelln.de/fileadmin/Stadt_Moelln/Dateien/Bebauungsplaene/BP_86/2.Aenderung/Begruendung.pdf
- Registered page roots (2):
  - https://www.moelln.de/fileadmin/Stadt_Moelln/Dateien/Bebauungsplaene/BP_86/2.Aenderung/Begruendung.pdf
  - https://www.moelln.de/buergerservice-politik/bekanntmachungen/bauleitplanung
- Registered seeds: 1; followLinkedDocuments: true.
- Initial configured origin(s): https://www.moelln.de.

### moelln-gazette

- Registered URL: https://www.moelln.de/buergerservice-politik/bekanntmachungen/amtliche-bekanntmachungen
- Registered page roots (1):
  - https://www.moelln.de/buergerservice-politik/bekanntmachungen/amtliche-bekanntmachungen
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.moelln.de.

### moelln-bob-sh

- Registered URL: https://bob-sh.de/
- Configured API: POST https://bob-sh.de/list/json (bobsh-list)
- Registered page roots (0):
  - None; do not add statewide roots.
- Registered seeds: 0; followLinkedDocuments: false.
- Initial configured origin(s): https://bob-sh.de.

### schwarzenbek-website

- Registered URL: https://www.schwarzenbek.de/
- Registered page roots (1):
  - https://www.schwarzenbek.de/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.schwarzenbek.de.

### schwarzenbek-council

- Registered URL: https://sessionnet.owl-it.de/schwarzenbek/bi/
- Registered page roots (1):
  - https://sessionnet.owl-it.de/schwarzenbek/bi/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://sessionnet.owl-it.de.

### schwarzenbek-participation

- Registered URL: https://www.schwarzenbek.de/Themen/Bauen-Umwelt/
- Registered page roots (1):
  - https://www.schwarzenbek.de/Themen/Bauen-Umwelt/
- Registered seeds: 1; followLinkedDocuments: true.
- Initial configured origin(s): https://www.schwarzenbek.de.

### schwarzenbek-gazette

- Registered URL: https://www.schwarzenbek.de/Service/Amtl-Bekanntmachungen/
- Registered page roots (1):
  - https://www.schwarzenbek.de/Service/Amtl-Bekanntmachungen/
- Registered seeds: 3; followLinkedDocuments: true.
- Initial configured origin(s): https://www.schwarzenbek.de.

### schwarzenbek-bob-sh

- Registered URL: https://bob-sh.de/
- Configured API: POST https://bob-sh.de/list/json (bobsh-list)
- Registered page roots (0):
  - None; do not add statewide roots.
- Registered seeds: 0; followLinkedDocuments: false.
- Initial configured origin(s): https://bob-sh.de.

### ludwigslust-website

- Registered URL: https://www.ludwigslust.de/
- Registered page roots (1):
  - https://www.ludwigslust.de/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.ludwigslust.de.

### ludwigslust-council

- Registered URL: https://ris.ludwigslust.de/
- Registered page roots (1):
  - https://ris.ludwigslust.de/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://ris.ludwigslust.de.

### ludwigslust-participation

- Registered URL: https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan&offset=0&n=100&crs=EPSG%3A25832&x_filter%5Bregionalschluessel%5D=130760090090
- Configured API: GET https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan&offset=0&n=100&crs=EPSG%3A25832&x_filter%5Bregionalschluessel%5D=130760090090 (mv-bauleitplan)
- Registered page roots (1):
  - https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan&offset=0&n=100&crs=EPSG%3A25832&x_filter%5Bregionalschluessel%5D=130760090090
- Registered seeds: 1; followLinkedDocuments: true.
- Initial configured origin(s): https://www.gaia-mv.de, https://bauleitplaene-mv.de.

### ludwigslust-gazette

- Registered URL: https://www.ludwigslust.de/Politik-Verwaltung/Verwaltung/%C3%96ffentliche-Bekanntmachungen/Allgemeine-Bekanntmachungen-/
- Registered page roots (1):
  - https://www.ludwigslust.de/Politik-Verwaltung/Verwaltung/%C3%96ffentliche-Bekanntmachungen/Allgemeine-Bekanntmachungen-/
- Registered seeds: 1; followLinkedDocuments: true.
- Initial configured origin(s): https://www.ludwigslust.de.

### parchim-website

- Registered URL: https://www.parchim.de/
- Registered page roots (1):
  - https://www.parchim.de/
- Registered seeds: 2; followLinkedDocuments: true.
- Initial configured origin(s): https://www.parchim.de.

### parchim-council

- Registered URL: https://parchim.sitzung-mv.de/public/gr020?GRLFDNR=1
- Registered page roots (5):
  - https://parchim.sitzung-mv.de/public/gr020?GRLFDNR=1
  - https://parchim.sitzung-mv.de/public/si018
  - https://parchim.sitzung-mv.de/public/do011
  - https://parchim.sitzung-mv.de/public/vo040
  - https://parchim.sitzung-mv.de/public/si010
- Registered seeds: 187; followLinkedDocuments: true.
- Initial configured origin(s): https://parchim.sitzung-mv.de.

### parchim-participation

- Registered URL: https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan&offset=0&n=100&crs=EPSG%3A25832&x_filter%5Bregionalschluessel%5D=130760108108
- Configured API: GET https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan&offset=0&n=100&crs=EPSG%3A25832&x_filter%5Bregionalschluessel%5D=130760108108 (mv-bauleitplan)
- Registered page roots (1):
  - https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan&offset=0&n=100&crs=EPSG%3A25832&x_filter%5Bregionalschluessel%5D=130760108108
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.gaia-mv.de.

### parchim-gazette

- Registered URL: https://www.parchim.de/de/politik-verwaltung/verwaltung/amtliches-bekanntmachungsblatt-uns-puett/
- Registered page roots (1):
  - https://www.parchim.de/de/politik-verwaltung/verwaltung/amtliches-bekanntmachungsblatt-uns-puett/
- Registered seeds: 1; followLinkedDocuments: true.
- Initial configured origin(s): https://www.parchim.de.

### hagenow-publisher-gazette

- Registered URL: https://epaper.wittich.de/frontend/catalogs/547927/1/pdf/complete.pdf
- Registered page roots (1):
  - https://epaper.wittich.de/frontend/catalogs/547927/1/pdf/complete.pdf
- Registered seeds: 12; followLinkedDocuments: false.
- Initial configured origin(s): https://epaper.wittich.de.

### hagenow-website

- Registered URL: https://www.hagenow.de/
- Registered page roots (1):
  - https://www.hagenow.de/
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.hagenow.de.

### hagenow-council

- Registered URL: https://hagenow.sitzung-mv.de/ratsinfo/logon
- Registered page roots (1):
  - https://hagenow.sitzung-mv.de/ratsinfo/logon
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): not fetched (excluded).

### hagenow-participation

- Registered URL: https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan&offset=0&n=100&crs=EPSG%3A25832&x_filter%5Bregionalschluessel%5D=130760060060
- Configured API: GET https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan&offset=0&n=100&crs=EPSG%3A25832&x_filter%5Bregionalschluessel%5D=130760060060 (mv-bauleitplan)
- Registered page roots (1):
  - https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan&offset=0&n=100&crs=EPSG%3A25832&x_filter%5Bregionalschluessel%5D=130760060060
- Registered seeds: 1; followLinkedDocuments: true.
- Initial configured origin(s): https://www.gaia-mv.de, https://www.hagenow.de.

### hagenow-gazette

- Registered URL: https://www.hagenow.de/service-fuer-buerger/downloadcenter/bekanntmachungen-und-sonstiges.html
- Registered page roots (1):
  - https://www.hagenow.de/service-fuer-buerger/downloadcenter/bekanntmachungen-und-sonstiges.html
- Registered seeds: 0; followLinkedDocuments: true.
- Initial configured origin(s): https://www.hagenow.de.
