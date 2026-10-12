# R1 VM lead resume brief

Handoff requested by Main on **12 October 2026, Berlin**. This file and its containing Git commit are the resume checkpoint. **WIP: R1 is not integrated, verified, value-accepted or released. Do not start source/model batches from this tree yet.** Main explicitly authorized committing incomplete integration so coordination can move from the Mac to the VM.

### VM lead checkpoint — 12 October 2026

- Owner Max prioritizes the first genuine bounded live batch (step 7) by **Wednesday 14 October**, before Thursday travel. This is a target, not permission to relax source, isolation, assessment or publication gates.
- Vikunja **task 68**, **In Arbeit (Agent)**, due 14 October: `R1: erster Live-Batch (Ziel Mi 14.10.)`. Step 1 completed on the VM: clean `rebuild-r1` received at `7922b9210b03dc69e8fe12aa2359ffcc8590ffff`; fetch/fast-forward reported already up to date. This brief and the complete approved plan were read; plan/catalog/question-bank SHA256 values match section 2.
- **Resource hold:** `/home/max/stadtstack-ops/state/0.3.2-heavy-done` was absent at resume. Until it exists, only code work for steps 1–4; no typecheck, tests, PostgreSQL operations, parser image or heavy jobs. After release, at most approximately four concurrent cores. No R1 source/model job or new verification has run.
- Step 2 donor investigation: fetched `council-owner-override` at `f942905aca2206402939d39d695d45d7876f16b2`. Main's read-only operations handoff reports a green source gate and four reviews; its current status reports the root-retirement fix reviewed and gate12 898/898. These are **donor results, not R1 verification**. Integration must retain R1 native/v3/v5/parser/OMP overlays; donor production corpus approvals and deployment work are not R1 execution authorization.
- No changes to `/home/max/civic-0.3.2-resume`, hosted MCP, cluster or Main's `HANDOFF_UPDATES.md`. No cluster commands. Subagents, if used, must use the owner-approved OpenAI models; Haiku remains limited to the separately gated VM-B assessment route.
- Actual resume milestone sent to ntfy `pipeline`, acknowledgement `W5BqmtSJdanL`; evidence appended to Vikunja task 68. This notification is coordination, **not** a bounded executor startup ACK.

## 1. Locations, ownership and observed state

- Repository: `GiraeffleAeffle/ledger-of-life`, branch `rebuild-r1`, draft PR <https://github.com/GiraeffleAeffle/ledger-of-life/pull/7>.
- Mac working clone: `/Users/max/Code/civic-rebuild-r1` (fresh `git clone --no-hardlinks` originally based on pushed `pilot-evidence-value`). Project directory: `stadtstack-data`.
- VM clone: `/home/max/civic-rebuild-r1`; project: `/home/max/civic-rebuild-r1/stadtstack-data`; SSH: `codex-workstation`, user `max`. The new lead runs omp in tmux on that VM.
- Existing original corpus: `/home/max/civic-knowledge-slice`. Never overwrite or implicitly enroll its legacy caches.
- Settled 0.3.1 commit `47083b92ad18613763536ea79d4db1aaccaa6eea` was merged at `d66753e`. Earlier pushed checkpoints: `022a71c` contracts, `442b322` approved plan/dispositions, `d646398` queue/CAS/001, `0d13b27` fifteen native adapter families. The handoff commit adds all subsequent WIP.
- **Do not edit** `/Users/max/Code/civic-pilot-value`. CivicPipelineMap's active source-policy donor is `/Users/max/Code/civic-council-override/stadtstack-data`. Several files here are exact snapshots of that **unreviewed working tree**, not a settled source pin. CivicPipelineMap was still repairing its own source-only gates at freeze. Obtain its reviewed/pushed source-only commit via Main and merge it; do not wait for a fresh 0.3.2 data release, and do not treat current copies as permission to run.
- PostgreSQL **16.15 is actually installed on the VM**, localhost-only. Peer-authenticated role `max` is non-superuser and has no permanent CREATEDB privilege. Production database: `civic_r1`; an unused `civic_r1_test` also exists. Migration **001 was actually applied** from `d646398`. **Never edit 001.** 002/003 are written but have **not been applied by R1**.
- VM Node was observed as `v24.21.0` through mise (`bash -lc`); Codex CLI `0.160.0`. Source-free VM `omp --help` reported **18.8.7**, executable `/home/max/.local/bin/omp` (ELF).
- Main confirmed OpenAI login earlier. Main subsequently confirmed the owner logged omp into Anthropic on the VM and `omp -p --model anthropic/claude-haiku-5-5` answered `ok`. **Do not repeat a probe just to confirm those reports.** They establish availability, not the R1 containment/provenance gates.
- R1 has run **no source collection, parser image build/sandbox run, actual assessment, value test, typecheck, build, repository test suite, lint or formatter**. Synthetic fixtures are authored but unexecuted. Two bridge/broker security findings were fixed and narrowly re-reviewed statically; this is not full integration/security/runtime GO.
- No R1 queue worker, model run, watcher or service was started on the Mac. Finite source-free CLI help/metadata SSH commands have completed. The final VM handoff check actually returned **0 running executors, 0 leased jobs, 0 queued/deferred jobs and 0 approved authorizations** in `civic_r1`; process lookup found no matching district runner/extractor/broker processes. No VM R1 work was mid-run or needed interruption. PostgreSQL remains on the VM. **No R1 worker is enabled unattended.** All R1 child writers are stopped; ParserIsolation and AssessmentHarness were cancelled after cooperative freeze requests did not produce a final acknowledgement. Their existing WIP is retained, not claimed complete. Do not depend on Mac process-local histories.

## 2. Contract and immutable inputs

Read the entire approved `docs/CIVIC_PIPELINE_REBUILD.md` first. It is copied unchanged from the approved planning checkout. Nine pilot towns only; no R4 transfer collection is authorized.

| Input | Frozen SHA256 |
| --- | --- |
| Approved plan | `cec8d20a8f443db49744e1b8ce51be6283184526e0895aa0010abcf8b0c2bdf2` |
| `sources/civic-source-catalog.csv` | `c19460dddf97c1e4ac2ef85d5bb34a9feff9482af2e8399d06c5b20001d05e40` |
| `evaluation/pilot-questions.json` | `2e74ab25477c83ed58a34e1a57ae76c16ed7f524fe7e6865106bfcc32bad18cc` |
| Original 0.3.1 registry bytes | `9095c7a241fa5cc1a2d75030286d8690cc5bf6d3e05990c56f7a5199c304b554` |

R1 acceptance: frozen **30** questions, without-graph usefulness **at least 30/60**, **at least eight full answers**, correctness **60/60**, sources **at least 46/60**; seven same-release graph pairs must gain **at least two usefulness points** without correctness loss. Report every unchanged question ID, evidence and the actual scores. An honest failed gate is not acceptance. Separate R4 local/transfer floors are **not run / not established**.

Owner policy: robots override with honest UA/contact `https://stadtstack.eu/kontakt`, per-host politeness, opt-out/purge; never bypass login, captcha or paywall; official works processed; reserved third-party works excluded; facts plus short quotes only. Distribution-specific unknown rights remain explicit holds. Paid provider ceiling R1–R3 is $100; **R1 permits subscription routes, not paid API execution**. API keys in the owner's Keychain are R2-only; never print/read them into R1 tools, parser children, CAS or logs. CLI API-price estimates are not invoices; unknown billing remains null, not zero.

## 3. Main's settled decisions — preserve these

### Retained original gates

Main approved a distinct **`retained_original_gates`** admission provenance **only for byte- and claim-equivalent authenticated retained records**, allowing the explicitly approved v2→v3 schema projection. Preserve original claims, source/generator/judge metadata and clocks. Label it **not new AI reconciliation and not independent gold**. No invented old run ID, HTTP observation, prepared receipt, native receipt or A/B/C seal; do not re-acquire 228 originals merely to carry unchanged 0.3.1 publication facts.

New or changed critical claims still require genuine original-evidence A/B/C and deterministic reconciliation. The frozen 30-question value assessment **also still requires actual original-evidence A/B/C**; retention is no scoring shortcut. Canonical retained-role helpers were still landing; two current donor leaves (`retained-knowledge-lineage.ts`, `retained-knowledge-coverage.ts`) were copied into this WIP for VM access, but caller/schema integration is unfinished.

### VM Haiku B through stock omp

Primary B transport is now **stock omp on the VM**, logical model `claude-haiku-5-5`, selector `anthropic/claude-haiku-5-5`, owner Max subscription. It is a different transport for the **same model**, never a model substitution. Record actual `omp-cli` version, model and run provenance. The native omp executor **is not implemented/enabled yet**; only truthful metadata/identity support is implemented.

Main explicitly ruled **no omp fork or patched build**. Provider-level internal retries for this read-only assessment are acceptable: record `transportMayInternallyRetry=true`, final response/usage and the limitation that final usage need not account for discarded attempts. Do not claim one wire request. Keep blinding, reconciliation, source/current-policy and zero-API-key-fallback gates. Do not automatically retry a possibly submitted run on the Mac or a different model.

The Mac RAM bridge remains an explicit fallback, with its separate real client contract, VM authority, intents and purge acknowledgements. Its stricter deny-write/deny-fork supervisor profile remains unexercised; native incompatibility is a hold, not permission to relax it.

### Hosted serving and signed revocations

Hosted MCP serves a **sealed immutable publication**, with current source-policy gates at publication — **no per-read dependency on the home VM, copied policy state or new broker/shared PG authority**. An explicit VM-local candidate mode may keep current-authority checks. Hosted reads apply a small **signed governed revocation mask**; expedited republish target is **at most 24 hours**. Administrative withholding is not a civic withdrawal or a `get_changes` event.

Filter every data/derived surface: direct record/source/core and original-record exports, source registries, case/history/metric context, graphs/mentions/edges/paths, change evidence, feeds and served counts. Bind cursors/view caches to immutable release plus mask identity. Never resurrect an old positive/current role by deleting revoked negative/end-date/uncertainty evidence. Missing/invalid signed configuration fails closed, not to an empty mask.

CivicMCP initially provisioned the Mac Keychain Ed25519 signer (`org.stadtstack.mcp.revocation-signer`, account `max`, private PKCS#8 DER). **Main then authorized a NEW independent VM signer and BOTH public pins in governed trust.** CivicMCP reports the VM key actually generated locally at `/var/lib/stadtstack-signer/revocation-signer.pem`, root-only mode 0600 inside a 0700 directory; its public-only receipt is `/var/lib/stadtstack-signer/revocation-signer.public.json`. No Mac private key was copied. Never print or place either private key in an image, model/parser process, environment, argv, logs or repository. VM signing is no longer blocked on the traveling Mac; this does not authorize an arbitrary signed target set or cluster rollout.

Public-only pins (not secrets; retain both): Mac key ID `ed25519:9a687b0082820b1df5743cd2faa1150bd38171fab50d8248d6cad28aca59ab1e`, SPKI `MCowBQYDK2VwAyEA7pH0triIjJrhZWSYqriNuor/5UYHQZnvZK9lSjvuAPA=`; independent VM key ID `ed25519:8393ad2b0087229073c57103c2e47a1b6f6e987c781b00bcbbaae060aa5ceebd`, SPKI `MCowBQYDK2VwAyEAkod48Z56zro687MC/XdBpzQX3N+YtSMb9U5c0ZIkVeA=`. Mac public receipt: `~/.cache/cluster-ops/mcp-revocation-signer-public.json`. Do not reprobe or expose private key material to confirm this reported provisioning.

ONE shared pure contract is `src/civic-revocations.ts`: Ed25519, domain `stadtstack:civic-revocations:ed25519:v1\n`, canonical unsigned envelope, opaque literal record/registry IDs, exact normalized hosts, explicit MCP-source versus municipality-scoped registry-source targets. `signRevocations` owns serialization (no appended newline). Trust is independently governed, including the **exact complete signed artifact SHA256**, not a payload-only digest, and immutable release ID. No production signed artifact/trust cohort has been fabricated or activated.

`loadGovernedRevocations(releaseId, env)` in `src/mcp-revocation-config.ts` reads once at startup. Required paths, reserved by CivicMCP:
- `STADTSTACK_MCP_REVOCATION_TRUST_FILE=/run/config/mcp-revocations/trust.json`
- `STADTSTACK_MCP_REVOCATIONS_FILE=/run/config/mcp-revocations/revocations.json`

Both come from one read-only projected config revision. Bounded regular files, protected owner/root permissions and same physical revision/root are required; ConfigMap symlinks are supported without escape. Missing/tampered/mixed configuration prevents serving/readiness. No request-time filesystem reads. Governed UID/RV CAS and revision-triggered **Recreate** replace the immutable in-memory cohort; no stale-serving replica/automatic revocation rollback. `mcp-hosted.ts` now explicitly calls `loadRelease(governedReleaseDirectory(), {mode:'sealed'})`, but the safe reader-view integration is unfinished.

### Source authority and notifications

Source-policy authority is VM-only: `/home/max/.local/state/stadtstack-data/civic-policy`, ID `owner-2026-10-11-codex-workstation`, Linux hostname `codex-workstation`, machine-id **file bytes** SHA256 `84e44b05b75fbed614c6a2e74690d2580c0035039055077acf22b6ba68f24dfd`. Missing/copied/foreign authority fails closed. R1 has not provisioned production authority; do not assume another owner has not since done so. No implicit provisioning, legacy-root enrollment or machine-pin bypass. Synthetic tests use explicitly provisioned `fixture:<UUID>` realms and returned authority SHA pins, never forged production markers or a CLI fixture flag.

`LegalPages.ContactGoLive` reports governed ntfy provisioning complete, signed source `8d5a51cf`, exactly one generic POST acknowledged and owner-read observed. Fixed endpoint `https://ntfy.stadtstack.eu/pipeline`; VM max-owned token `/home/max/.config/stadtstack/ntfy/pipeline-publisher.token`, mode 0600. Read only in the approved process, never print or put in argv. Topic `contact` remains for the contact form. **No additional ntfy test was authorized.** Real authorized pipeline startup/hold/checkpoint/failure notifications use `district-notifications.ts`; bounded unattended jobs require a fresh durable startup ACK, never replay an old provider message ID.

## 4. Exact resume order

1. **Receive this checkpoint on the VM.** Fetch/fast-forward `rebuild-r1` without discarding any new VM lead work. Use the containing commit as the WIP pin; read this brief and the whole approved plan. No model/source command yet.
2. **Merge CivicPipelineMap's reviewed source-only pin when supplied.** Current borrowed files are unreviewed snapshots. Reconcile complete acquisition/authority/managed source/registry-config/retained/Git proof/observation/prepared/cache closure. Preserve R1 native/v3/isolated parser overlays, genuine original HTTP bytes, control-resource `document|robots|tdm` distinctions, redirect/304 policy behavior and all six `ResourcePolicyInspection` fields. Preserve current model/OMP and signed-mask metadata overlays; do not overwrite them with v2 donor files.
3. **Close known WIP interfaces before attempting to run the tree:**
   - `mcp-query.ts` still lacks the announced `QueryVisibility` and `QueryIndex.withRevocations`; `mcp-release.ts` already imports/consumes them. Finish one signed safe-view builder and all surface projections, not a response-only scrub.
   - `mcp-source-identity.ts` has the exact shared canonical/source-ID codec and `createSafeKnowledgeReadView`/`assertSafeKnowledgeReadView`. Its text descriptor currently passes unused `registrySourceId` into the narrow source hash-input literal: remove that property there, retaining it on the OUTER descriptor. CivicPipelineMap fixed this one line in its copy. Preserve exact source IDs.
   - `district-graph.ts` still imports `canonical` from `mcp-pagination.ts`, whose re-export was removed. Import the pure source-identity leaf. `conservativeGraphReadView` exists but is not connected to `GraphIndex`, mask-bound cursors/receipts or serving. Validate unchanged record subsets/identity closure, preserve original `asOf`, remove affected structural components without positive-role resurrection, and never expose revoked names/quotes/blockers.
   - `mcp.ts` injected release and `mcp-tools.ts` hosted factory still contain superseded per-read VM-policy assumptions. Complete sealed verified-view versus explicit VM-candidate mode; reject cached VM mode from hosted serving. Bind each response to the same safe view actually queried. Move the old VM opt-out regression to candidate mode; add real signed-mask fixtures.
   - `projectMaskedReleaseMetadata` in `mcp-release.ts` is WIP. Prevent a registry-source revocation in one municipality from globally masking a shared URL elsewhere; distinguish served-view counts from immutable publication/crawl/lineage counts. Masked coverage is NOT an immutable coverage-v5 artifact.
   - Complete `retained_original_gates` integration across the retained helper, critical private/public schemas, preparation, policy inventory, publication inputs, coverage and replay. Current critical gating still rejects retained critical records without new A/B/C. Keep Main's explicit exemption narrow/authenticated; never label it AI reconciliation. The donor retained helper/coverage leaf must be reconciled with R1 v3/v5/OMP metadata and exact approved historical projection.
   - `district-publication-provenance.ts` replaced replay-only provenance. Update `test/replay-pipeline.test.ts` imports/version/fixtures (old `ReplayPrivateProvenanceSchema` is gone); new pins require `bytes` and `independentAllowed`. Update preparation failure fixtures that lack required provenance. Preserve true mixed HTTP/prepared/operator-config control ancestry; model input remains selected actual prepared text.
   - Finish standalone publisher input custody. Nested replay/`withPreparedKnowledge` uses genuine lease callbacks; ordinary standalone path reads still need canonical pinned/source-accounted transport. No structural `activeScratch` flag or fake lease object.
   - Include `district-regional-statement-verification.ts` in the publication contract fingerprint (the async custody/hash/result gate moved there). Public `regional-statement.ts` is data/types only; worker and canonical `regional/statements.mjs` supply isolated parsing. Check pure public critical/structured schema imports do not pull VM-only execution into the sealed distribution.
   - **Structured registry admission is partially wired by parent:** `district-structured-registry-admission.ts` adds canonical descriptor+exact managed config reauthentication; `enqueueStructuredSnapshot` now REQUIRES `registry:{path,sha256}` and `registrySha256`, and includes them in selector/input identity. `district-structured-jobs.ts` selector/execution, CLI callsite and state/fixture calls still need those fields, execution reauthentication and helper/dependency fingerprint updates. Existing `district-structured-registry.ts` remains the separate original catalog PROPOSAL helper, not admission.
4. **Implement the actual stock omp VM B transport**, using the constraints in section 6. Metadata schemas alone do not enable it. Preserve approved internal retry disclosure; no fork. Enforce Max OAuth-only/no API-key fallback before source handoff, clean filesystem/tool/context profile, independently bounded process lifetime, actual JSONL identity/output validation and source-owned persistence. Current `assessment_b` queue handler is still the Mac bridge; integrate a genuine native VM path without inventing a Mac purge ACK or retrying ambiguously on another transport.
5. **Run one coordinated integration verification after the code/dependency closures land.** Typecheck, full tests (including disposable real PG), focused source lifecycle/security review, then reviewed parser image and actual OS sentinels. Do not mark synthetic fixtures as production evidence. Fix failures; no masking/relaxing gates to make them pass.
6. **Freeze source/code/image contracts, apply only unapplied migrations and explicitly provision/admit the real VM source/control roots.** Authenticate registry descriptors and original source bindings. Test actual lifecycle/opt-out/purge, source-only model custody and native OMP profile before unattended authorization. Mac fallback remains separately gated.
7. **First bounded live source batch, then all nine pilot dispositions.** Use exact catalog/registry roots and actual committed discovery links; no guessed URLs or manufactured OParl selected-Body authority. Missing `oparlContext` alone is not a blanket hold: canonical shared policy decides ordinary admission versus restricted origin. Accessible admitted sources must actually be ingested; blocked/unexercised sources stay honestly labelled. Report the first-live checkpoint to Main.
8. **Genuine assessments, immutable candidate and exact replay.** Use actual native run/archive-v2 artifacts, source/member/critical/identity receipts, authentic earlier `priorRelease`, original clocks and common graph `asOf`. Existing core remains exact authenticated prior bytes with original gates, not a new PDF/model verification. Reconstruct every manifest member and exact manifest bytes with network/providers disabled.
9. **Run the frozen value test via actual candidate MCP calls/pagination**, explicitly in VM-candidate mode where appropriate. Complete real A/B/C reviews and owner exception/sample audit within the approved <=2-hour target; AI consensus is not independent gold. Report all 30 answers and seven graph pairs, unchanged denominators and actual gate verdict. Only then ask CivicMCP for governed hosted release/revocation cohort activation. No cluster access from this worker/lead unless separately delegated.

## 5. Child slices frozen at handoff

All listed work is code/fixtures, not exercised verification. The VM lead owns integration; do not restart old Mac children implicitly.

| Slice / files | State and immediate follow-up |
| --- | --- |
| QueueCas: `district-jobs.ts`, CAS/step receipts, 001–003 ordering | Implemented single-process bounded/fenced queue, immutable receipts, subscription-cost distinction, safe metadata API, authority-first lock ordering. 001 applied/immutable; 002/003 unapplied. Real PG fixtures unrun. |
| Native adapters + shared tables: `src/adapters/*`, individual contracts/tests | All 15 families implemented with synthetic native fixtures. Two static review rounds produced concrete fixes: genuine units/date formats/inherited row/column styles, geographic key columns, capacity vs receipts, privacy, identity and procurement keys. Funding mixed independently valid/held rows now partial; global schema/ambiguous rows still held. No live format/rights readiness claimed. |
| IdentityTemporal: case/entity/graph modules; `district-native-identity-integration.test.ts` | Native funding-v2/council-v3/EU procurement graph dispatch fixed with parser-produced fixtures. Temporal negation/end/unknown semantics implemented. Signed-mask graph serving/cursors NOT wired; see section 4. |
| StructuredReaders: MCP/query/district/pagination/source-identity files | Native DTO/role/date/stage/supersession/native-context work implemented. Signed all-surface view NOT complete; old injected per-read VM assumptions remain. |
| StructuredPublication: prepare/publish/data-release/MCP loader/replay + publication leaves | Native receipts, coverage-v5 privacy projection, input seals, authentic predecessor/core, archive-v2 and nested preparation custody implemented. Retained critical role, standalone publish custody, mask views and several test/import boundaries remain WIP. |
| ParserIsolation: parser isolation/workers, policy inspection, prepared source, Dockerfile/fixtures | Source-owned daemon/container custody and all-MIME/default parser work present. Cancelled at freeze without a fresh final handoff; retain current files as WIP. No image built or approved; no native sandbox run. Verify six-field policy inspection, exact prepared membership and all required assets after canonical merge. |
| AssessmentHarness: assessment/evaluator + critical contracts/private/public helper + stage evidence | Blind A/B/C and actual CAS replay implemented; current source/model custody migrated. Cancelled at freeze while the new retained-original role/pure public import work remained incomplete; no fresh AI proof may be fabricated. Reconcile actual current helper/leaf/fixture state before resuming. |
| TextProducerCutover: inference/extract/preparation/reassessment/corpus + fixtures | V3, Codex VM custody, actual archive-v2 producer, explicit registry descriptor and mixed-role ancestry implemented. No legacy model/HTTP relabel. Latest canonical dependent pin/schema changes must be merged. |
| R1OperatorCli: `district-r1.ts`, host groups, CLI/metadata tests | Explicit registry flags, exact registry, proposal-only frozen catalog, bounded commands, shared PG pacing, real HTTP proofs, audit-only PG projection implemented. New parent structured-registry fields still need handler/CLI/test completion. |
| ResidualQueueIntegration: `district-residual-jobs.ts` + tests | Genuine preparation predecessor, source/registry bindings and existing extraction APIs integrated. Text export requires actual sealed run/composition, not invented aggregate clocks. |
| AssessmentVmBroker: broker, 003, unit/PG tests | VM intents/leases/receipts/purge ACK implemented; locks run→authorization→job→bridge lease through COMMIT. Eight controlled PG interleavings authored, not run. Current B queue path is Mac bridge. |
| HaikuMemoryBridge: bridge/lifetime + tests | Independent lifeline/deadline/group-teardown supervisor; deny-write/deny-fork; no purge ACK without teardown; source-free readiness. Two focused static security findings addressed including broker race. Native Mac sentinels/compatibility still unrun; fallback only. |
| OmpModelProvenance | `omp-cli` + Anthropic Haiku exact route, actual version/digest, CLI-reported identity checks in schema/receipt/coverage/lineage/replay. No native execution permission/runner added. Historical Codex/Claude identities unchanged. |
| OmpVmProtocol | Read-only matching-v18.8.7 research; concrete handoff below. No auth/provider probe repeated. |
| RevocationContract + parent config loader | Pure real Ed25519 verifier/signer/matcher and governed startup reader implemented; synthetic crypto/config tests authored, not run. No production signed artifact. CivicPipelineMap mirrors shared files independently; check final shared hashes when merging. |
| StateProofFixtures/TextLineageFixtures/V3 fixture work | Genuine synthetic authority/HTTP/CAS/PG/lineage cases authored. New registry and retained/serving changes require final fixture migration. |
| Parent-only work | Policy receipts/content-free metadata; authentic HTTP proof/state wrappers; native public-field privacy; registry admission helper WIP; isolated regional quotation worker/verifier; retained-core/legacy command cleanup; forced sealed startup; governed revocation loader; this brief. |

## 6. Stock omp VM implementation handoff

Matching source tag: `can1357/oh-my-pi` **v18.8.7**, tree `f261ed9faf16b61880b544f599876bface4ded0d`. Source/docs, not runtime claims:
- <https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/modes/print-mode.ts>
- <https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/ai/src/providers/anthropic.ts>
- <https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/ai/src/types.ts>
- `omp://auth-broker-gateway.md`, `omp://cli-reference.md`, `omp://environment-variables.md`, `omp://settings.md`, `omp://system-prompt-customization.md`, `omp://extension-loading.md`, `omp://mcp-config.md` (using these docs is authorized).

Use stock binary, direct spawn/no shell, source only through private stdin. Relevant observed flags: `--print --mode json --model anthropic/claude-haiku-5-5 --thinking off --no-session --no-tools --no-lsp --no-pty --no-extensions --no-skills --no-rules --no-title --no-prewalk --profile ... --cwd ... --config ... --system-prompt ... --max-time ...`. Paths/argv must be source-free. Non-TTY stdin is the prompt; do not add a guessed `-`. No @attachment/source argument, model cycling, continue/resume, hooks or plugin flags. `--mode json` is JSONL framing, **not native schema-constrained output**. Parse the final text strictly with the existing assessment schema; no fence stripping, repair model or fabricated result.

Controls need real review, not just flags: `--no-tools` disables built-ins only; disable/physically exclude MCP/extensions/plugins/hooks/skills/rules/context files. CLI custom system prompt retains generated context/footer; pin/review its source-free wrapper rather than claiming complete raw system replacement. Use clean launch cwd AND private HOME/profile/ancestors, no .env or owner's repo/config exposure. Explicit settings include `autoResume:false`, `extensions:[]`, `workspace.additionalDirectories:[]`, `retry.enabled:false`, `retry.modelFallback:false`, empty fallback chains, `retry.waitForUsageReset:false`, `retry.usageAwareFallback:false`, `providers.anthropic.serverSideFallback:false`, cache warming off/retention none, all compaction/autoContinue/contextPromotion/advisor/autolearn/loop guards off, memory off, `features.unexpectedStopDetection:none`, `mcp.enableProjectConfig:false`, plan off. These are not proof of complete isolation; invalid settings may warn/fall back. **Do not invent `mcp.enabled=false`.** Environment must be an allowlist, excluding API keys, endpoint/header/Foundry/proxy overrides and foreign config/debug state.

Authentication remains a concrete implementation prerequisite: CLI broker account pools filter OAuth identities **but leave API-key credentials visible**. Default/config/env/stored key tiers can override/fallback. Owner's confirmed Max login is availability ground truth, not an implemented per-run isolation mechanism. `auth-broker list` lists supported providers; `status` is health only. **Never dump `/v1/snapshot`, credential DB/config or token commands into tools/logs**: snapshots include OAuth access tokens and API keys (only refresh tokens are redacted). A narrow approved resolver must guarantee the actual selected OAuth capability and no API-key tier/reselection, with token-free truthful metadata. No whole-vault copy.

An additional **help-only** observation worth investigating without printing credentials: stock `omp token PROVIDER --account N` is documented to select the Nth **OAuth account**, and `--list` lists OAuth account identities. Only `omp token --help` was run, never token retrieval. Review its exact matching-version implementation and possible protected in-process OAuth capability handoff to an isolated model-only namespace; do not assume this is already a safe implemented solution. Do not fake a refresh token or duplicate mutable credential authority.

`--no-session` alone does not prevent logs/cache/history/blob writes. Profile roots: private HOME `.omp/profiles/PROFILE/agent`; named profiles ignore `PI_CODING_AGENT_DIR`. `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS=0` disables snapshot-cache reads/writes, not live secret-bearing snapshots. Keep all source-bearing writes inside registered lease-owned filesystem containment. Read-only pinned binary/assets/CA roots, minimal approved auth capability, no host repo/home/SSH/Docker socket. Independently supervise startup/stdin/request/drain/teardown; a PID namespace/cgroup or reviewed equivalent must prevent descendant escape. `withManagedSourceScratch` provides authority/lease/process bookkeeping, **not an OS filesystem sandbox**.

Actual JSONL: session header; `message_start`, `message_update`, `message_end`; `turn_end` and `agent_end` may repeat messages. Authoritative completed `message_end.message` must have role assistant, provider `anthropic`, api `anthropic-messages`, model `claude-haiku-5-5`, stopReason `stop`, text content and consistent terminal exit. Reject tool calls/results, extra unapproved turns/fallback/compaction, malformed/truncated frames, length/error/aborted/toolUse and inconsistent identities. Count repeated message copies once. `message.model` normally echoes OMP's catalog model ID, not independent provider attestation. Keep optional `upstreamModel` unknown if absent; reject a present unapproved mismatch. `credentialId` alone does not prove Max. Final `usage.{input,output,cacheRead,cacheWrite,totalTokens}` and `usage.cost` are final response estimates, not guaranteed all-attempt accounting/invoices.

Central metadata APIs already in `district-model-contract.ts`: `SUPPORTED_MODEL_ROUTES`, `SupportedModelRouteSchema`, `ModelEvidenceSchema`, `modelIdentitySha256`, `assertModelEvidenceIdentity`, `assertModelResponseIdentity`. Omp logical requested/reported model remains `claude-haiku-5-5`; literal CLI selector is separate transport metadata. Existing native `district-model.ts` remains Codex/VM-only; add a deliberate reviewed B route, not a basename fallthrough in managed `spawn` or a fixture bypass.

## 7. VM commands and safe operational sequence

These are **resume commands after the relevant gates**, not evidence that they were executed. `$REGISTRY_CONFIG`, `$REGISTRY_CONFIG_SHA`, input JSON paths and authorization IDs must come from actual authenticated artifacts/approvals, never samples or invented receipts.

```sh
# Receive the handoff; do not reset/discard new VM work if this refuses.
git -C /home/max/civic-rebuild-r1 fetch origin rebuild-r1
git -C /home/max/civic-rebuild-r1 merge --ff-only origin/rebuild-r1
cd /home/max/civic-rebuild-r1/stadtstack-data
export DATABASE_URL='postgresql:///civic_r1?host=/var/run/postgresql'

# After code/dependency closure, main integration checks (not yet run):
npm ci --ignore-scripts
npx tsc --noEmit
node --experimental-strip-types --test --test-concurrency=2 test/*.test.ts
```

For real PG fixtures, provide `DISTRICT_TEST_DATABASE_URL` to a **disposable CREATEDB-capable local test cluster/role**, not production `civic_r1`. One isolated Unix-socket approach, run as `max` after review:

```sh
PG_BIN=/usr/lib/postgresql/16/bin
TEST_PG=$(mktemp -d /tmp/civic-r1-pg.XXXXXX)
"$PG_BIN/initdb" -D "$TEST_PG/data" --auth-local=trust --auth-host=reject --no-locale
"$PG_BIN/pg_ctl" -D "$TEST_PG/data" -l "$TEST_PG/postgres.log" -o "-h '' -k $TEST_PG -p 55432" start
export DISTRICT_TEST_DATABASE_URL="postgresql:///postgres?host=$TEST_PG&port=55432"
# Run the coordinated tests here; they create/drop their own test databases.
# Always stop this disposable cluster afterward, including on test failure:
"$PG_BIN/pg_ctl" -D "$TEST_PG/data" -m fast stop
# Remove only the TEST_PG directory you just created when no evidence is needed.
```

Do not permanently grant CREATEDB/superuser to production `max`. Prioritize queue/broker controlled interleavings, actual operator audit-before-CAS/purge privacy, state/HTTP binding, registry descriptor/prepared cache, critical/retained lineage, native mapper/style, signed mask/read surfaces and exact replay suites. Full tests should include the real PG tests, not merely skip them.

After static/security review, build the allowlisted parser image on the VM (no downloaded source processing during build):

```sh
docker build --file Dockerfile.parser --tag stadtstack-parser:review .
docker image inspect --format '{{.Id}}' stadtstack-parser:review
```

Record the actual immutable image ID and `parserIsolationContractSha256()`. A privileged reviewer installs the **real** `/etc/stadtstack/parser-isolation-review.json` according to the exported schema, root-owned/nonwritable ancestry and mode 0644. No fake review receipt, runtime pull or host fallback. Then run the authorized `STADTSTACK_PARSER_SECURITY_TESTS=1` Linux gates with real authority and truthful synthetic inspection bindings; test filesystem/env/network/no source argv, limits and daemon cleanup/recovery. The full regional-wrapper positive needs an actual admitted HTTP original; a synthetic pre-admission worker test must not claim it has one.

Only after review/integration:

```sh
# Explicit operator provisioning ONLY if needed/authorized; never repair foreign state implicitly.
node --experimental-strip-types src/civic-opt-out.ts provision
# Applies ordered independently hash-pinned migrations; 001 must remain unchanged.
npm run knowledge:r1 -- migrate

: "${REGISTRY_CONFIG:?actual approved registry descriptor path required}"
: "${REGISTRY_CONFIG_SHA:?actual descriptor SHA256 required}"
REGISTRY_ARGS=(--registry-config "$REGISTRY_CONFIG" --registry-config-sha256 "$REGISTRY_CONFIG_SHA")
npm run knowledge:r1 -- catalog "${REGISTRY_ARGS[@]}"
# Catalog writes an UNCHECKED date-named proposal, never an execution admission.

npm run knowledge:r1 -- enqueue-acquisition "${REGISTRY_ARGS[@]}" < "$ACQUISITION_JSON"
npm run knowledge:r1 -- authorize "${REGISTRY_ARGS[@]}" < "$AUTHORIZATION_JSON"
# AUTHORIZATION_ID is the real returned UUID; B-only and non-B batches remain separate.
./scripts/r1-vm-run.sh 300 "${REGISTRY_ARGS[@]}" --authorization-id "$AUTHORIZATION_ID" --max-jobs 5 --mode bounded_unattended
```

All non-migration R1 commands require registry-config path+SHA; JSON goes on stdin, **not an invented `--manifest` flag**. Actual schemas are in `district-r1.ts`/`district-residual-jobs.ts`. Authorization JSON fields: `approvalSha256`, `approvedBy`, `expiresAt`, actual `jobKeys`, `ags`, `maxJobs`, `maxElapsedMs`, `category`, `mode`. Never invent approval hashes. Attended mode uses explicit owner presence. GNU timeout's TERM/KILL outer deadline is mandatory in addition to JS/lease limits; no infinite watchdog/default service.

Further commands using the same registry flags and bounded JSON stdin: `representations`, `enqueue-structured`, `results`, `enqueue-residual-preparation`, `enqueue-residual-extraction`, `enqueue-assessment-b`, `export`, `export-text-contribution`. **The structured registry WIP must be completed first.** `enqueue-assessment-b` currently means the Mac broker path, not the missing omp VM runner. The broker's fixed SSH command remains VM-local `district-assessment-broker.ts` with the same peer-auth `DATABASE_URL`; no reverse SSH or new ports for the Mac fallback.

Fixed VM data locations relative to the project:
- `cache/districts/cas` — private CAS; `sha256/xx/hash`; existing owned cache/CAS directories were set to mode 0700.
- `cache/districts/r1-fetch` — separately managed acquisition root.
- `cache/districts/r1-operator` — controlled proposal/operator metadata, not an arbitrary raw-copy exemption.
- Source authority at `/home/max/.local/state/stadtstack-data/civic-policy`.

Postgres keeps content-free policy/HTTP metadata and closed artifact/source/proof audit pins/counts. Full native records, diagnostics, descriptors and run payloads stay source-bound purgeable CAS content; **audit SHA differs from artifact SHA**. Back up DB metadata, referenced CAS and authenticated control/proof inputs together. No raw quotes/error fragments in immutable audits or public coverage. No arbitrary parser module/shell command in job selectors.

For serving, `STADTSTACK_MCP_RELEASE_DIR` is REQUIRED absolute and must not be historical `out/`. Hosted mode uses the signed config cohort above and immutable seals only. Candidate/evaluator mode must explicitly select VM-current-policy, not generate a fake signer to satisfy missing production configuration. The all-surface mode migration remains WIP.

## 8. Scope/continuity boundaries

Keep deterministic/native verification distinct from text-model verification; never invent model names, faithfulness, quotes or timestamps for structured rows. Native year/month/period precision is explicit; calendar overlap is a derived search range, not a legal event day. Supporting originals have independent true HTTP/policy bindings. Case/entity IDs are source/issuer/scoped, not label similarity; full-case metric history is computed before filters/pages. Document buckets and context observations are not projects. Identity assertions/admissions remain reversible, and active graph closure cannot introduce hidden held mentions.

Reuse canonical planning-stage/supersession/council/changes semantics, including original predecessor change clocks and before/after revisions. No target-as-predecessor or empty-diff fallback. Retained lineage and native generation groups are separate cohorts; do not count retained publication records as a fabricated extraction run.

By the owner's Thursday 15 October travel, the intended unattended capability is **bounded preauthorized VM fetch/parse/Codex and, once integrated/gated, omp Haiku B**, with durable queue/dispositions/notifications. This is a target, not an already enabled production service. Missing approval, lease, source rights, isolation, model transport or unresolved critical exception must pause safely. The Mac model bridge is fallback only; the separately approved independent root-only VM revocation signer removes the signing dependency on the Mac.

Only CivicMCP's governed path may deploy; no worker cluster access. CivicMCP's latest handoff says future approved cluster work is from the VM through `sudo stadtstack-session` only, under Main's governance — not permission for this data worker to access the cluster. Source code/model availability is not release authorization. No 0.3.2 signed artifact, trust cohort, configuration or rollout was activated by this handoff; the existing hosted frozen release is not switched.

## 9. Owner backlog retained, not R1 scope expansion

Owner reports Rateo has 26,554 Berlin district council items (2021–2026), 91% decision status and party attribution; these are supplied comparison figures, not R1 measurements. R2 should implement an attributed CC BY 4.0 API external-bundle adapter through the same planned Kair/Braid interface: `https://rateo.berlin/api/vorgang/<district>/<id>`, reference MCP `https://rateo.berlin/api/mcp`. API only/polite, no scraping; start heat/solar Berlin–MOL comparison without pretending external labels are independent official verification. No R1/R4 collection expansion.

R1's bounded council addition is explicit native decision status/result and proposing organization/faction only; never infer from agenda/vote counts/title/account or create a person directory. Hybrid semantic search and an approved-topic subscription digest are later work, not acceptance substitutes.

Comparable-case reference for Sage/Rateo discussion remains the existing typed model: enduring case/project versus procedure/event/document bucket; issuer-scoped native identity; string AGS/admin level/boundary vintage; canonical topics; dated instrument/stage/date-role/modality/history; short exact quote or native locator; original URL/hash/validation basis; current/superseded state and fixed asOf. Keep Berlin borough powers distinct from Brandenburg municipality powers. Unknown dates/identity/outcomes stay explicit; no new interchange schema is claimed delivered.
