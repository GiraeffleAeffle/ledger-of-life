# R1 execution state

Updated 2026-10-11. **R1 is in implementation, not accepted or released.**

## Authority and immutable inputs

Approved contract: `/Users/max/Code/ledger-of-life-review/platform/CIVIC_PIPELINE_REBUILD.md` (11 October independent-review corrections). Nine pilot towns only. Frozen `evaluation/pilot-questions.json` remains unchanged. R1 target: without-graph usefulness ≥30/60, ≥8 full answers, correctness 60/60, sources ≥46/60, and seven same-release graph pairs gain ≥2 usefulness points without correctness loss. Separate R4 transfer floor is **not run / not established**; no six-town expansion is authorized.

Working clone: `/Users/max/Code/civic-rebuild-r1`, branch `rebuild-r1`, created with `git clone --no-hardlinks` from the pushed `pilot-evidence-value`. That branch is the frozen 0.3.0 baseline, not the in-flight 0.3.1 release. Shared graph/schema/publication migration is held pending CivicPipelineMap's settled 0.3.1 and acquisition/origin/opt-out commits. Never edit `/Users/max/Code/civic-pilot-value`.

## Current durable state

- Shared source-native observation/locator/discovery/coverage contract: `src/district-adapter-contract.ts`. It does not synthesize model receipts or prose quotations for table cells.
- Native-ID adapters (A), decision/finance chains (B), then contextual families (C) have separate implementation owners. No source collection or context import has run.
- Postgres 16.15 packages installed on `codex-workstation`; local-only peer-authenticated database configuration is being established. Queue migration and bounded runner are not yet applied.
- Parser isolation, queue/CAS, identity/temporal rules and blind assessment harness are under implementation. No unattended run or sandbox approval exists yet.
- No paid provider calls, no model assessments, no source collection, no publication, and no acceptance checks have been executed by this rebuild.

## Safe continuation boundaries

Use Postgres and the VM private CAS, not SQLite or public `out/` storage. R1 runs only bounded explicitly authorized batches; it is not an unattended production service. Pause on expired authorization, lease/budget/isolation failure, unresolved critical assessment or rights exception. Preserve resumable dispositions and original receipts. The existing VM corpus is `~/civic-knowledge-slice`; do not overwrite it or silently import stale policy proofs.

Parser subprocesses must use the credential-free sandbox and pinned image, not host fallbacks. A security-reviewer pass on runner/isolation/secrets is mandatory before any unattended batch; sentinel environment/filesystem/network tests must pass before downloaded documents are parsed. Provider credentials belong only in approved model processes. API keys are R2-only; R1 uses authorized Codex and Haiku 5.5 subscription routes with actual provenance and unknown billing recorded as unknown, not zero.

Notification topic `pipeline` is **held pending owner approval and governed ntfy ACL creation by Main**. Do not create/use it yet. Until available, record holds here and notify Main. Never use contact-form topic `contact`.

## Publication and evaluation boundary

Merge the settled acquisition implementation before schema migration; reuse its origin, robots override and opt-out controls rather than establishing a second policy engine. Freeze all 30 question/source dispositions before context imports. Accessible admitted sources must actually be ingested to count operational; blocked/unknown/unexercised distributions remain explicit coverage gaps. Native document IDs are not counted as completed projects.

After code integration, the integration owner runs type checking, repository tests, Postgres integration and parser isolation/security gates. Then collect only bounded admitted nine-town sources, assess changed/critical evidence through blinded A/B and third-pass reconciliation, and publish an immutable candidate through the existing manifest/predecessor path. Evaluate through actual candidate MCP calls including pagination, not private candidate shortcuts. Report all answers and unchanged question IDs, evidence hashes, three totals, and paired graph results. Missing value targets mean **not value-accepted**, not permission to relax questions or fabricate chains.

Only CivicMCP's governed release path may deploy. No cluster access or active release switch is authorized for this worker. Exact replay must preserve authentic earlier `priorRelease`, all non-knowledge staging inputs, original hashed clocks and pinned graph `asOf`; never use the target release as its predecessor.
