# 0015 Home Node joins local infrastructure to the hosted ledger

Status: Accepted (2 October 2026)

## Context

The owner wants other people to contribute their own GPU, solar readings or validator identifiers, with local setup assisted by an LLM, and to see building income redeemed and reinvested. The hosted app deliberately refuses home-network pulls. The existing outbound GPU worker already provides a paired Ed25519 identity, bounded jobs and verified payout selection; replacing its protocol would disrupt the running connector.

## Decision

Evolve the relay into `home-node/home-node.mjs`: one file, zero runtime dependencies, Node ≥22. Preserve existing `--config` invocation, private PKCS#8 key, SPKI public key, host-state file and GPU pairing/poll/result/heartbeat protocol. Retain cold-model preload, bounded deadlines, text-only inference, no tools and independent heartbeats. Users stop their old service before switching executable; no replacement invitation is needed for an existing identity.

Any signed-in account with a verified EVM wallet may pair its own community hosts, limited to two active/suspended hosts per account and fifty globally. `LOCAL_AI_HOST_OWNER_WALLETS` distinguishes operator hosts, not exclusive onboarding. Operators may suspend community hosts. GPU paid answers pay the host's verified payout wallet, or the building distributor only after an explicit opt-in. Free own-host compute remains unpaid.

The setup CLI detects local Ollama/models and optional NVIDIA hardware, pairs with a private invitation, stores an optional HA token in an owner-only local file, selects readings, announces public validator ids and configures local wake. `run` shares config/state with `mcp` and reloads mutable capability configuration. App origin or identity-directory changes require stopping/restarting. `status` and `doctor` never disclose tokens or private keys.

An MCP **stdio** process implements newline-delimited JSON-RPC 2.0: initialization/protocol negotiation, initialized notification, ping, tools/list, tools/call and empty resources/prompts lists. Its tools guide detection → configuration → pairing → optional readings/validator selection → local proof. There is no hosted HTTP MCP endpoint, arbitrary shell tool, general file-read tool or caller-selected secret path. HA connection accepts the token value and stores an origin-bound credential only in the fixed private state-directory file. Prefer interactive setup to keep credentials out of LLM conversations. MCP device origins are restricted to loopback, RFC 1918, link-local, `.local` or `.home.arpa`; only interactive setup may confirm a public HA origin, and MCP cannot change the app origin. MCP does not itself replace the ongoing service.

Normal run/status/MCP refuse group/other-readable, symlinked or foreign-owned config/key/token files and non-owner-only private parent directories. Resolved-path containment and no-follow opens protect secret reads; origin binding prevents a concurrent old configuration from sending a newly changed token to the wrong HA origin. `migrate-permissions --config PATH` is the explicit legacy upgrade: it tightens only current-user-owned regular paths, preserves the identity, and copies any legacy HA token into the fixed state-directory credential file. Symlinks and foreign-owned paths require an owner-reviewed replacement, never automatic permission reassignment.

The [current 2026-07-28 MCP revision](https://modelcontextprotocol.io/specification/versioning) is served through stateless per-request protocol/capability metadata and `server/discover`; legacy clients retain the required `initialize` handshake with 2025-11-25 and earlier supported versions. Modern replies carry `resultType` and server identity; incompatible protocol requests are rejected without running tools.

Selected Home Assistant readings are fetched locally and pushed to `/api/home-node/readings`; chosen GPU model names, public sensor ids and public validator ids go to `/api/home-node/capabilities`. Both use the existing signing bytes (`POST`, exact path, millisecond timestamp, random nonce, SHA-256 of raw body), with server size/time/rate bounds. Normalized power W, energy kWh accumulated since **sensor-local midnight**, a fresh ISO UTC observation timestamp, local calendar date and IANA device timezone leave the node. The node timezone must match the sensor counter's reset timezone; day rollover follows that local date, including DST, and lifetime meters are not daily counters. Unchanged HA state values are observed freshly rather than inheriting a stale `last_updated`. Existing readings without local metadata remain accepted as UTC fallback. Hosted LAN pulls remain refused. Local URL and HA bearer token are never sent to the app. Simulated solar income is a conservative observation-based lower bound, not an attested whole-day meter bill.

Solar assignment is an explicit owner action in the hosted app, off by default, applying to future observations only. A separately keyed hosted job may mint capped **simulated solar feed-in income** to the building distributor; unconfigured means skip. Validator identifiers do not operate or prove a validator, and no validator keys are requested. The building view attributes GPU settlements, simulated solar mints and unattributed transfers. tHOME stakers can claim fictional test rewards and reinvest through claim → desk purchase → approve/stake; these are not legal rights or real investment returns.

Site-paid solar assignment also requires a declared peak capacity and manual operator approval. The declared-capacity ceiling is `min(kWp × 8, 100)` kWh per sensor-local day; above-ceiling history flags an anomaly, pauses income and prevents approval until resolved. The assignment states are unassigned, pending, approved, rejected or paused. Neither local setup nor signed readings alone establishes meter accuracy or eligibility.

The public download endpoint serves the same single file with SHA-256 headers. The checksum protects transport integrity, not against a compromised origin; use a reviewed git revision for independent provenance.

## Consequences

- The home LAN remains private and requires no inbound ports or VPN. Selected local readings, inference answers, public identifiers and liveness are the outgoing data, not credentials.
- The local worker and LLM client are trust boundaries. An owner must review configuration requests and avoid entering secrets in chat; the client/provider has its own retention policy.
- HTTPS is preferred locally too. Plaintext beyond the device requires a loud explicit trusted-LAN opt-in and exposes prompts/HA credentials to that network.
- Signatures authenticate a paired key, not a model, trustworthy meter, attested hardware, accurate reported token counts or truthful validator yields.
- Test networks only: tUSDG/tHOME are fictional units with no monetary value or rights. Real participation would require the applicable regulation; no legal or investment advice is provided.
- This records the checkout's decision, not a deployment, operating-system service installation or verification against the owner's real equipment.

See the [Home Node guide](../../home-node/README.md) and [ADR 0013](0013-outbound-home-node.md) for the preserved GPU trust boundary.
