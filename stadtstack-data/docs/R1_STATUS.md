# R1 execution state

Updated 2026-10-11. **R1 is in implementation, not accepted or released.**

## Authority and immutable inputs

Approved contract: [`CIVIC_PIPELINE_REBUILD.md`](CIVIC_PIPELINE_REBUILD.md), copied unchanged from the approved planning checkout (11 October independent-review corrections). Nine pilot towns only. Frozen `evaluation/pilot-questions.json` remains unchanged. R1 target: without-graph usefulness ≥30/60, ≥8 full answers, correctness 60/60, sources ≥46/60, and seven same-release graph pairs gain ≥2 usefulness points without correctness loss. Separate R4 transfer floor is **not run / not established**; no six-town expansion is authorized.

Working clone: `/Users/max/Code/civic-rebuild-r1`, branch `rebuild-r1`, created with `git clone --no-hardlinks` from pushed `pilot-evidence-value`. That branch is the frozen 0.3.0 baseline. Settled 0.3.1 commit `47083b92ad18613763536ea79d4db1aaccaa6eea` is merged at `d66753e`, pushed to `rebuild-r1`; initial contracts commit is `022a71c`. Acquisition/origin/opt-out integration remains held pending its settled pin. Graph/query work is nonoverlapping and proceeding; schema/publication changes wait. Never edit `/Users/max/Code/civic-pilot-value`.

## Current durable state

- Shared source-native observation/locator/discovery/coverage contract: `src/district-adapter-contract.ts`. It does not synthesize model receipts or prose quotations for table cells.
- Native-ID adapters (A), decision/finance chains (B), then contextual families (C) have separate implementation owners. No source collection or context import has run.
- Postgres 16.15 installed on `codex-workstation`, restricted to localhost, peer-authenticated non-superuser role `max` and database `civic_r1`. Queue migration is not yet applied. VM clone `/home/max/civic-rebuild-r1` tracks `rebuild-r1`; Node/npm are available through `bash -lc` (mise shims). Locked npm dependencies are installed.
- Parser isolation and queue/CAS are under security review; no unattended run, parser image build or sandbox approval exists yet. Blind assessment harness and frozen 30-row disposition matrix are written, not exercised.
- No paid provider calls, no model assessments, no source collection, no publication, and no acceptance checks have been executed by this rebuild.

## Safe continuation boundaries

Use Postgres and the VM private CAS, not SQLite or public `out/` storage. R1 runs only bounded explicitly authorized batches; it is not an unattended production service. Pause on expired authorization, lease/budget/isolation failure, unresolved critical assessment or rights exception. Preserve resumable dispositions and original receipts. The existing VM corpus is `~/civic-knowledge-slice`; do not overwrite it or silently import stale policy proofs.

Parser subprocesses must use the credential-free sandbox and pinned image, not host fallbacks. A security-reviewer pass on runner/isolation/secrets is mandatory before any unattended batch; sentinel environment/filesystem/network tests must pass before downloaded documents are parsed. Provider credentials belong only in approved model processes. API keys are R2-only; R1 uses authorized Codex and Haiku 5.5 subscription routes with actual provenance and unknown billing recorded as unknown, not zero.

Notification topic `pipeline` is **held pending owner approval and governed ntfy ACL creation by Main**. Do not create/use it yet. Until available, record holds here and notify Main. Never use contact-form topic `contact`.

## Publication and evaluation boundary

Merge the settled acquisition implementation before schema migration; reuse its origin, robots override and opt-out controls rather than establishing a second policy engine. Freeze all 30 question/source dispositions before context imports. Accessible admitted sources must actually be ingested to count operational; blocked/unknown/unexercised distributions remain explicit coverage gaps. Native document IDs are not counted as completed projects.

After code integration, the integration owner runs type checking, repository tests, Postgres integration and parser isolation/security gates. Then collect only bounded admitted nine-town sources, assess changed/critical evidence through blinded A/B and third-pass reconciliation, and publish an immutable candidate through the existing manifest/predecessor path. Evaluate through actual candidate MCP calls including pagination, not private candidate shortcuts. Report all answers and unchanged question IDs, evidence hashes, three totals, and paired graph results. Missing value targets mean **not value-accepted**, not permission to relax questions or fabricate chains.

Only CivicMCP's governed release path may deploy. No cluster access or active release switch is authorized for this worker. Exact replay must preserve authentic earlier `priorRelease`, all non-knowledge staging inputs, original hashed clocks and pinned graph `asOf`; never use the target release as its predecessor.

## Implementation contracts and current limitations

The 15 adapter families use native raw-field locators, immutable byte hashes and explicit completeness dispositions. Synthetic native-format fixtures demonstrate intended mappings, not live endpoint compatibility. Primary schema research has inspected selected GENESIS, WFS, energy-atlas, census and education metadata; this is not corpus ingestion. Default unknown-rights distributions stay held. Original PDFs route to isolated text/OCR and substantive verification, never pretend to be spreadsheet cells. Registry/source contract integration and live nine-town ingestion remain necessary.

Structured records use `kind: structured` verification with deterministic native-field replay and current shared-policy receipts; no invented model, faithfulness score or prose quote. Text records keep genuine extraction/judge provenance. Context records remain searchable observations, not counted projects. Native identity keys exclude labels; original mentions, aliases and versioned accepted/proposed/contested/retracted assertions remain reversible. Conflicting identifiers block whole-cluster merges. Model matches are shadow-only. Unknown effective intervals never mean current; graph `asOf` is explicit and fixed, while legal/financial event chains retain distinct dated roles.

`district-assessment.ts` CLI contracts:

- `pass ITEM ROLE PROVIDER OUTPUT LEDGER PAUSE [A B]`: isolated blinded role input; C binds both A/B receipts.
- `reconcile ITEM A B C OUTPUT`: deterministic contradiction checks remain authoritative.
- `audit FRAME SEED OUTPUT` and `audit-log FRAME SEED CHECKS OUTPUT`: reproducible sampled owner packet and actual review log, capped at 120 minutes before affected acceptance pauses.

Original evidence and exact locators are required; contexts beyond the inherited 24 KiB subscription interface limit hold rather than truncate. Submission intent files are exclusive and immutable: an ambiguous crash requires reconciliation, never automatic duplicate submission. Codex runs on the Linux VM; Haiku 5.5 runs on the Mac. Mac absence is not authorization to substitute another assessor. AI consensus remains provisional, not independently validated gold. No actual assessments or owner audit have run.

Publication changes bind typed structured evidence, identity assertions and `asOf` through the existing manifest. MCP reader DTOs retain native observation/date-role/financial-role/locator fields; structured filtering and pagination must not turn source metadata into project outcomes. A required publication-input seal accounts for all original knowledge/nonknowledge staging dependencies and authentic prior-release signal/change members. Current policy rechecks produce separate admissibility receipts without relabeling original generation provenance or changing exact replay clocks.
