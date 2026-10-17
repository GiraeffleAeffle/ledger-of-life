# omp v18.9.2: Anthropic OAuth-only print-run isolation

## Evidence boundary and short verdict

This is **read-only source research at GitHub tag `can1357/oh-my-pi/v18.9.2`**, not main. No omp execution, token command, credential/config/database inspection, auth endpoint request, build or test was performed. The authorized local runner brief, `stadtstack-data/docs/R1_STATUS.md` section 6, was read. All source references below are file-and-line links to the tag. `[INFERENCE]` means a design conclusion; `[UNKNOWN]` means not established, not a runtime observation.

**Verdict:** [INFERENCE] Passing a genuine Anthropic OAuth access bearer obtained in-memory by a trusted parent using **`omp token anthropic --account N`** is a sound **credential-only isolation design** for a stock top-level print run **if all other credential sources are actually absent**. The child needs no owner's credential store and cannot refresh this env-only bearer. However, the premise **“private empty roots + spawn-time env allowlist” alone is insufficient** for a complete isolated assessment: launch/project dotenv, discovered project configuration/context, argv/model overrides, generated prompt wrappers, hidden retries, catalog egress and independent disk writes remain. OAuth transport also does not establish the token's identity/subscription tier or guarantee zero extra-usage billing. The necessary qualifications and exact controls follow.

## 1. Anthropic credential classification and headers

### Environment strings versus stored OAuth

`getEnvApiKey` returns a string using catalog env configuration plus AI registry hooks. Anthropic's environment hook chooses `ANTHROPIC_OAUTH_TOKEN` before `ANTHROPIC_API_KEY`; when Foundry is enabled it first tries `ANTHROPIC_FOUNDRY_API_KEY`. `$pickenv` trims and takes the first nonempty value. This is **priority within the env tier**, not priority over models config or stored credentials. [a-env][a-envhook][u-pickenv]

The exact OAuth classifier is **`key.includes("sk-ant-oat")`**, not strict prefix validation. Header construction uses `options.isOAuth ?? isAnthropicOAuthToken(options.apiKey)`. Thus a genuine OAuth bearer from env receives Claude OAuth request shaping; merely naming a variable `ANTHROPIC_OAUTH_TOKEN` does not turn an API key into OAuth. The name does not import an OAuth row, expiry, refresh token or account metadata. [a-tokenclass][a-headers]

### First-party transport

- OAuth: **`Authorization: Bearer <access token>`**, `anthropic-beta` including **`oauth-2025-04-20`**, Claude Code utility/agent beta profile and fingerprint/user-agent headers. Client options set `apiKey:null` and `authToken:<bearer>`.
- Ordinary first-party API key: **`X-Api-Key`** defaults to the selected key.
- Nonofficial base URLs normally use Bearer even for non-OAuth; Cloudflare AI Gateway uses `cf-aig-authorization`. Bearer by itself therefore does not prove subscription OAuth.
- **Caller/config-provided `X-Api-Key` remains honored even on the OAuth branch**. A clean custom-header/config environment is part of credential isolation, not an optional nicety. [a-betas][a-headers][a-clientopts]

The built-in Anthropic auth policy is named **Anthropic (Claude Pro/Max)**, authorizes at `claude.ai/oauth/authorize`, is organization-scoped, and requests `user:inference` plus other account/session/MCP/file scopes. The env bearer uses the OAuth request path without executing login. [a-authpolicy] [UNKNOWN] Token-byte detection is not independent proof of subscription, entitlement, organization or billing mode.

### Refresh when only env has the access token

**No refresh exchange is made for that env-only token in the empty-store scenario.** The OAuth selector first filters stored OAuth rows and returns undefined if none. The cascade then reaches env. The coding-agent retry resolver can request `forceRefresh:true`, but with no stored OAuth row it simply resolves the same env string again; auth retry rejects the already-tried bearer. It neither constructs a refresh token nor writes that env string as a new OAuth account. [a-select][a-cascade][c-keyresolver][a-authretry]

This should not be confused with creating a malformed **stored** OAuth row: stale/forced stored rows can invoke the provider refresher using their stored refresh material. The env design avoids that path. Expiry/revocation requires trusted-parent reacquisition for a new run, not child self-refresh. [a-refresh][a-authpolicy]

## 2. Complete credential ladder and remaining selection paths

### Where the selected key is consumed

ModelRegistry delegates model request keys to `authStorage.keys.get/getWithCredential`; the coding-agent resolver performs initial lookup, refresh-current and sibling rotation. AI `stream.ts` consumes the resolver and carries the accepted credential ID/OAuth identity along with the accepted bearer. This is a real request path, not just a helper exposed but unused. [c-modelkeys][c-keyresolver][a-streamretry]

### Actual unrestricted provider credential order

First successful tier wins:

| Priority | Credential source |
|---|---|
| 1 | Runtime key override, including CLI `--api-key` |
| 2 | Explicit provider `apiKey` registered from `models.yml`/models config |
| 3 | Stored OAuth account selected/ranked/refreshed from the active credential store |
| 4 | Stored `api_key` whose source is `login` |
| 5 | Registered provider config **fallback** key |
| 6 | Env key; Anthropic OAuth env before API-key env, with Foundry exception above |
| 7 | Other stored `api_key` credentials |
| failure | No key, or deferred transient OAuth refresh failure if no later source serves |

The full implementation is `packages/ai/src/auth/cascade.ts:#resolve`. Config values can be env references, literal secrets or command-resolved secrets; ModelRegistry installs the coding-agent config resolver and `setConfig` entries. There is not a separate unnamed “settings key tier” above this ladder: provider registrations feed the runtime/config cascade, and broker settings choose the active backing store. [a-cascade][a-configkeys][c-modelconfig]

### Auth broker: disabled when no URL

URL precedence: **`OMP_AUTH_BROKER_URL` → `auth.broker.url` in agent `config.yml`/`config.yaml`**. Token precedence: **`OMP_AUTH_BROKER_TOKEN` → global config `auth.broker.token` → config-root `auth-broker.token` file**. No URL returns null and opens local SQLite at agent.db; URL but no token is an error, not a silent local fallback. Registered `auth.broker.url` and `auth.broker.token` are string/default undefined with those env bindings; discovery intentionally reads global agent config, not general project/overlay credential redirection. [a-brokerconfig][a-brokeropen][c-brokersettings]

### With fresh private roots and only the OAuth credential env, every relevant remaining route

1. **Runtime/config credentials:** still selectable if the launch passes `--api-key`, explicit extensions, custom model/provider registration, models apiKey, header/endpoint overrides or foreign config. These must be absent, not merely outside the env allowlist. Empty agent DB eliminates stored OAuth/login/static-key tiers; no broker URL eliminates broker credentials. Then Anthropic env is the only remaining credential tier. [a-cascade][a-brokeropen]
2. **Dotenv can repopulate excluded credentials/settings after spawn.** Utils eagerly fills unset env vars from launch/project `.env`, agent `.env`, config-root `.env`, home `.env`, in that order after existing process env. Bun may autoload project dotenv before user code, including compiled binaries and mode-specific dotenv files. Therefore the **actual OS launch cwd** and its dotenv sources must be clean; `--cwd` parsed later is not proof against earlier injection. Private HOME alone does not solve this. [u-dotenv]
3. **Auth refresh/rotation retries:** re-enter the same ladder. Empty pool/no alternate config makes the same bearer the only answer and prevents another account/API key; accidentally exposing a store/config permits normal rotation. Env-only never gains a refresh credential. [a-select][c-keyresolver][a-authretry]
4. **Startup model selection:** pin exact **`anthropic/claude-haiku-5-5`**, not a role, wildcard, alias or provider default. The bundled Anthropic default is **`claude-opus-5-5`**; Haiku 5.5 has its own seed at the first-party endpoint. With no explicit selector SDK can pick configured/default/first-available models; an unresolved explicitly requested model skips generic first-available fallback. Token env alone does not pin Haiku. [p-anthropic][c-startmodel]
5. **Configured model/role fallback chains:** can change model **and provider**. Default `retry.fallbackChains` is `{}`; `expandDefaultRetryFallbackChains` expands a configured default array, it does not supply a baked chain. For a fixed route set `retry.enabled:false`, `retry.modelFallback:false`, keep chains `{}`, and disable usage-aware fallback/context promotion/prewalk. A keyless/local provider is not excluded merely by removing paid keys. [s-retry][s-fallback][c-fallback][c-turnretry][c-startmodel]
6. **Anthropic server-side fallback:** default false; when enabled, settings wrapper injects a model's catalog chain and provider sends fallback beta/body. This changes provider-server model routing under the selected bearer, not a new client credential tier. Keep false and do not pass explicit `options.fallbacks`. [s-serverfallback][c-streamsettings][a-serverfallback]
7. **Configured native gateway transport:** `model.transport === "pi-native"` dispatches to a gateway that resolves its own model/credentials, bypassing the ordinary provider path. An unmodified first-party bundled Haiku seed does not set this; exclude custom transport/models/extension overrides. [a-native][p-anthropic]
8. **Side-model/tool work:** title, prewalk, compaction, advisor, memory/autolearn, cache warming and smart unexpected-stop recovery are separate from the primary model. Disable their actual master settings/flags below, plus tools/extensions/MCP. Unrelated shared catalog fetches can still occur without unrelated inference credentials (section 6). [s-all][c-cli-gates][c-auxgates][c-catalogstart]

[INFERENCE] With clean launch sources, exact first-party model, no overrides/fallbacks/side models, empty credentials and no broker, the traced normal request path has no alternate paid API credential to select. This is client routing evidence, not attestation of the remote server's internal implementation.

## 3. `omp token <provider> [--account N] [--list] [--force-refresh]`

Implementation is **`packages/coding-agent/src/commands/token.ts`**. Registered flags include `--raw`, `--force-refresh`, `--account/-a` integer and `--list/-l`; provider is required. [c-tokenflags]

| Invocation | Exact stdout/security behavior |
|---|---|
| `omp token anthropic` | Normal credential ladder; **can print API key/non-OAuth credential**. Prints one resolved string plus newline, not an output JSON envelope. Unless `--raw`, parses structured credential JSON and prints string `token` field when present; otherwise prints original string. |
| `--raw` | Entire raw resolved credential string; may itself be structured JSON for some providers. Not a secret-free mode. |
| `--account N` | One-based index over **stored active OAuth accounts only**, excluding API keys/env credentials. Selects `accounts[N-1].credentialId` then `oauth.accessById`; prints accessToken + newline. Exact-ID lookup does not rank/rotate/fall back to siblings or API keys. |
| `--list` | Human lines `N. label`; label = email else accountId else projectId else enterpriseUrl else `credential #id`, append `(orgName or orgId)` if different. Only OAuth accounts; no explicit credential-type column and no access/refresh token/expiry. Not complete canonical identityKey. Takes precedence over account/refresh flags. |

Sources: [c-tokenaccount][c-tokenbare][a-oauthaccounts][a-oauthexact]. `oauth.accounts` itself is read-only/no token refresh. An ordinal is stable stored order for that snapshot, not immutable identity across store changes. [a-oauthaccounts]

### Refresh and owner's-store mutation

`--account` normally refreshes if expired/within refresh skew; `--force-refresh` forces selected row refresh even when fresh. `#resolveStoredOAuthAccess` refreshes the exact ID, reloads that row and uses no sibling fallback. Refresher merges tokens/expiry and persists with CAS/update and in-memory pool resync. Thus parent acquisition **may mutate the owner's store without --force-refresh**, local agent.db or configured canonical broker store; it is not a read-only accessor. [a-oauthexact][a-oauthresolve][a-refreshpersist]

### Exit codes

Success/list returns normally (ordinary code 0). No OAuth accounts, N outside 1..count, unsuccessful selected OAuth access or no resolved bare credential sets **1**, with stderr diagnostics; storage closes in finally. CLI usage errors (missing/invalid flags/args) are also **1**. Uncaught command errors propagate to fatal handling, also **1** with cleanup/forced-exit safeguards. These are command-source codes, not an observed execution. [c-tokenaccount][c-tokenbare][u-clierrors][c-cli-fatal][u-fatal]

[INFERENCE] Trusted parent must use **--account**, not bare token; identify the intended current row by trusted metadata, fail on nonzero/invalid/extra output, validate token shape privately, and never log/store bearer stdout. Ordinal N alone should not be treated as permanent account identity.

## 4. Retries and registered settings — exact names, types, defaults

### Distinct retry layers

**Auth retry:** `createAuthRetryKeyState` / `resolveNextAuthRetryKey` are in **`packages/ai/src/auth-retry.ts`**, not select.ts. Max **64 accepted auth attempts**; ordinary auth errors refresh-current once then distinct sibling rotation; policy/403/usage-limit errors skip to rotation (concurrency-cap exception); typed token-refresh error has one special refresh replay. Already-seen bearer is refused except explicit after-sibling-wait. `stream.ts` buffers pre-output events and can retry only before replay-unsafe output; select.ts supplies restricted/ranked/refreshed stored candidates. No registered `retry.enabled` gate in this AI-layer auth loop. [a-authretry][a-streamretry][a-select]

**Anthropic HTTP/provider retry:** hardcoded **10** transient retries before meaningful/replay-unsafe output. Transient HTTP/transport/overload/5xx/429 and retryable SSE-envelope/parse failures can qualify; account quota/ordinary auth errors do not use this transient loop. Backoff .5s exponential, capped 8s, up to 25% jitter, Retry-After honored subject to delay cap. Although client construction has a nominal retry option, **the stream request explicitly sets client `maxRetries:0`**, so do not multiply ten provider retries by the client's nominal five. Generic client would retry connection/408/409/429/5xx and honor x-should-retry, but not inside this zero-retry stream call. [a-providerretry][a-providerloop][a-retryclass][a-httpclient]

**Whole-turn agent retry/fallback:** registered `retry.enabled/maxRetries/baseDelayMs/maxDelayMs/...` govern turn recovery. The settings wrapper also passes registered `retry.maxDelayMs` to provider retry delay (default 300000ms); it does not change hardcoded provider count. Additional finite compatibility/shape-repair retries and **two benign empty-completion retries** remain separate: empty replay requires stop, no meaningful committed content, output <=1 token, no pause/compaction, and delays 500/1000ms. [c-turnretry][c-streamsettings][a-providerloop][a-emptyretry]

**Therefore `retry.enabled:false` is not a one-wire-attempt guarantee.**

### The actual registered schema

**`packages/coding-agent/src/config/registry.ts`** defines typed registration/validation; **`config/all-settings.ts`** imports domain registrations. There is no one static JSON runner schema supplying these keys: the domain files below contain exact registrations. [s-registry][s-all]

| Exact key | Type | Default | Source |
|---|---|---|---|
| autoResume | boolean | false | [s-modes] |
| extensions | array | [] | [s-extensions] |
| workspace.additionalDirectories | array | [] | [s-workspace] |
| retry.enabled | boolean | true | [s-retry] |
| retry.maxRetries | number | 10 | [s-retry] |
| retry.baseDelayMs | number | 500 | [s-retry] |
| retry.maxDelayMs | number | 300000 | [s-retry] |
| retry.waitForUsageReset | boolean | false | [s-retry] |
| retry.modelFallback | boolean | true | [s-retry] |
| retry.fallbackOn | enum any / usage-limit / except-usage-limit | any | [s-retry] |
| retry.usageAwareFallback | boolean | false | [s-retry] |
| retry.fallbackChains | record (selectors → chain arrays) | {} | [s-fallback] |
| providers.anthropic.serverSideFallback | boolean | false | [s-serverfallback] |
| providers.anthropic.slowMode | enum off / auto | off | [s-serverfallback] |
| providers.cacheRetention | enum auto / short / long / none | auto | [s-cache] |
| providers.cacheWarming | enum off / streaming / idle | idle | [s-cache] |
| contextPromotion.enabled | boolean | false | [s-contextpromotion] |
| prewalk.enabled | boolean | false | [s-prewalk] |
| advisor.enabled | boolean | false | [s-advisor] |
| autolearn.enabled | boolean | false | [s-autolearn] |
| autolearn.autoContinue | boolean | false | [s-autolearn] |
| autolearn.minToolCalls | number | 5 | [s-autolearn] |
| model.loopGuard.enabled | boolean | true | [s-loopguards] |
| model.loopGuard.checkAssistantContent | boolean | true | [s-loopguards] |
| model.loopGuard.toolCallReminder | boolean | true | [s-loopguards] |
| model.toolCallLoopGuard.enabled | boolean | true | [s-loopguards] |
| model.toolCallLoopGuard.threshold | number | 5 | [s-loopguards] |
| model.toolCallLoopGuard.exemptTools | array | [wait] | [s-loopguards] |
| memory.backend | enum off / local / hindsight / mnemopi / sharpshooter | off | [s-memory] |
| features.unexpectedStopDetection | enum none / mechanical / smart | mechanical | [s-unexpected] |
| mcp.enableProjectConfig | boolean | true | [s-mcp] |
| plan.enabled | boolean | true | [s-plan] |
| plan.defaultOnStartup | boolean | false | [s-plan] |
| plan.autosave | boolean | false | [s-plan] |
| plan.autosaveDir | string | undefined | [s-plan] |

The brief's bare names **autoContinue, contextPromotion, advisor, autolearn, memory, plan** are not registered scalar off-switch spellings. Use exact nested keys. Continuation relevant to compaction is `compaction.autoContinue`; learning has separate `autolearn.autoContinue`. `mcp.enabled` is not a registered MCP master. `PI_NO_THINKING_LOOP_GUARD=1` also disables stream loop guard, but the registered model.loopGuard.enabled boolean is passed by the settings wrapper. [s-compaction][s-mcp][s-loopguards][c-streamsettings]

Additional advisor tuning registrations: `advisor.syncBacklog` enum off/1/3/5/strict default off; `advisor.immuneTurns` number 3; `advisor.reviewMode` enum turn/agent-end default turn; `advisor.reviewInterval` number 1; `advisor.maxNotesPerUpdate` number 4; `advisor.evictStaleResults` boolean true. These are not alternatives to advisor.enabled:false. [s-advisor][s-advisorvalues][s-advisorbudget]

### Complete `compaction.*` inventory

Prefix every suffix below with `compaction.`. Sources: context-settings registrations and method constant. [s-compaction][s-compactionmethods]

| Suffix | Type | Default |
|---|---|---|
| enabled | boolean | true |
| experimentalContextManagement | boolean | false |
| midTurnEnabled | boolean | true |
| methodOrder | array | [remote, snapcompact, handoff, shake, soft] |
| thresholdPercent | number | -1 |
| thresholdTokens | number | -1 |
| modelThresholds | record | {} |
| modelThresholdsEnabled | boolean | true |
| handoffSaveToDisk | boolean | false |
| remoteStreamingV2Enabled | boolean | true |
| asyncEnabled | boolean | true |
| reserveTokens | number | undefined |
| keepRecentTokens | number | 20000 |
| autoContinue | boolean | true |
| remoteEndpoint | string | undefined |
| v2RetainedMessageBudget | number | 64000 |
| idleEnabled | boolean | false |
| idleThresholdTokens | number | 200000 |
| idleTimeoutSeconds | number | 300 |
| supersedeReads | boolean | true |
| dropUseless | boolean | true |

For strict assessment explicitly false enabled/midTurnEnabled/asyncEnabled/idleEnabled/autoContinue/experimentalContextManagement/handoffSaveToDisk; supersedeReads/dropUseless are separate historical tool-context pruning. `compaction:false` is not this typed leaf control. [s-compaction]

### `--config` overlay: unknown and invalid values

Explicit files load in order after global/project, below runtime overrides. Missing/unreadable/malformed YAML or nonmapping root is a hard error; null/empty document becomes `{}`. **Unknown overlay keys are not automatically rejected**: validateAll walks registered settings only. Ordinary wrong type/invalid enum warns on effective read and falls back to **schema default**, not lower layer. Example `retry.enabled: "false"` can leave effective default true. Null is unset. Setting-specific validators may throw during load; configured arrays can warn about unknown items. Runtime/programmatic constructor overrides have separate strict known-path/type validation. Therefore startup success does not prove every intended off-switch took effect. [c-overlay][s-validation][c-settingsvalidation]

## 5. Print-mode JSON: terminal outcomes, deadline and usage

`--mode json` emits **JSONL session events**, not a schema-constrained model answer. Session header precedes event subscription. message_update drops message/partial snapshots and retains terminal stream update only as `{type:done/error, reason}`. Complete `message_end` is authoritative; message_start/end, turn_end, agent_end strip opaque providerPayload but retain message usage/cost/errors/stopReason. Tool streaming updates reduce to IDs/name. Other events forward normally. Writes are serialized/awaited before shutdown. [c-printformat]

| Outcome | Source behavior / ordinary exit |
|---|---|
| assistant stopReason error | Terminal failure → 1; JSON terminal message carries error. Text mode emits stderr error. |
| aborted | Same → 1, except recognized silent-abort transitions or signal-owned teardown. |
| SIGINT / SIGTERM / SIGHUP | Signal lifecycle owns 130 / 143 / 129; ordinary print failure must not overwrite it. |
| length | Not itself print failure → can be 0 with truncated/incomplete answer. Session may compact/recover/continue first. |
| toolUse | Not itself print failure. Normal tool loop continues; terminal toolUse-only is not sufficient assessment success. |
| strict MCP unavailable (OMP_MCP_REQUIRE_READY) | Prompts skipped, stderr and 1. |
| latched durability failure | Diagnosed at dispose and 1. |
| no terminal assistant record | Absence alone does not set terminalFailure; can escape as 0. |

Sources: print predicates/lifecycle and length session recovery. [c-printterminal][c-printsignals][c-lengthrecovery][c-compactioncontinue]

`--max-time` seconds becomes absolute `Date.now()+seconds*1000` at buildSessionOptions. Agent-loop composes `TimeoutError` **Deadline exceeded** abort signal. Mid-run expiry normally synthesizes aborted assistant with that error → print 1. **Already expired on loop entry:** emits input messages plus agent_end and returns without synthetic terminal assistant; absence can escape as 0. It is not a hard total subprocess lifetime: startup/disposal/drain exist outside model/tool-loop deadline, and strict advisor catch-up can exceed drain budget. Use parent supervision and require a complete final assistant message. [c-deadline][a-deadline][a-abortmessage][c-printterminal]

**Final message_end usage/cost is not a complete logical-run spend receipt.** Auth attempts discarded before replay-safe output never reach caller. Anthropic transient retry clears usage before reissue. Empty-completion replay buffers/discards prior attempts and forwards only terminal attempt. Thus final usage usually describes final surviving provider attempt, not cumulative hidden retries. Other assistant turns/side requests may have separate accounting; agent_end/turn_end/message_end can duplicate the same message. Provider-native fallback/compaction can also aggregate iterations within a surviving response, so one final message is not necessarily one wire request. [a-streamretry][a-providerloop][a-emptyretry][a-serverusage]

[INFERENCE] Accept only process success **and** expected provider/model metadata, complete final assistant text, suitable stop state and strict assessment schema. Reject errors, abort, length, toolUse-only and missing final assistant, even if code 0. Do not silently repair with another model.

## 6. Print prompt/context contamination and auxiliary network

### Files/discovery sources

- Standalone **AGENTS.md / CLAUDE.md** walk cwd/ancestors to repository/home/root boundary with nonempty/depth/shadow rules. Native global `<agentDir>/AGENTS.md`, nearest project `.omp/AGENTS.md` also participate. [c-agentsmd][c-claudemd][c-contextwalk][c-nativecontext]
- Default system-prompt candidates include nearest `.omp/SYSTEM.md` or SYSTEM_TEMPLATE.md and global agent equivalents; APPEND_SYSTEM.md is separate append material. Explicit system prompt replaces the selected default prompt, not all context discovery. [c-nativeprompt][c-systemload][c-cli-prompt]
- Native rules directories plus global/nearest project RULES.md; ancestor `.omp/skills`, global agent skills, managed skills. Rules and skills have independent gates. [c-nativerules][c-nativeskills]
- Foreign Claude/Codex/Gemini/Cursor/GitHub/OpenCode/Windsurf/Cline/VSCode discovery providers register their supported formats/roots. `.claude/CLAUDE.md` and configured user Claude context are among these. `contextFiles.extra` additional filename array defaults []; workspace.additionalDirectories can add their context. [c-discoveryproviders][c-claudecontext][s-workspace][c-extra-context]

### Flags — and the important MCP correction

- `--no-rules` passes rules []; `--no-skills` passes skills []; **neither disables AGENTS/CLAUDE/context-file discovery**. [c-cli-gates]
- `--no-extensions` disables discovery, not permission to add explicit extension/hook paths. Exclude those argv inputs too. [c-cli-extensions]
- **v18.9.2 `--no-tools` engages the SDK restrictive tool-name gate** (unless explicit `--tools` overrides it). It passes toolNames=[]; SDK sets enableMCP=false and excludes MCP/extension tools. Thus the old brief's narrower “builtins only” warning does not describe this stock gate. Ordinary print otherwise defaults MCP on. `mcp.enableProjectConfig:false` only excludes project config, not all user MCP. [c-cli-gates][c-mcpgate][s-mcp]
- `--system-prompt` selects custom prompt content; a one-line value naming a readable file is treated as file content, multiline input is literal. It does **not** make the complete wire system prompt raw/custom-only. [c-systemload]
- `--no-title` and `--no-pty` set PI_NO_TITLE/PI_NO_PTY; --no-prewalk explicitly suppresses prewalk and conflicts with positive prewalk flags; --no-lsp passes enableLsp=false. [c-auxgates][c-cli-gates]

### Generated material still present with custom prompt

Custom wrapper can append skills/rules/redaction guidance if enabled. Then generated **project-context** includes workstation OS/arch, optional model, context files, optional tree/roots/repo, and a **stock critical instruction footer**, followed by append prompt. This is not only harmless environment metadata. Eval prelude guidance can also be inserted. A separate first-user **date/cwd system reminder** is wired into SDK transformProviderContext and is not disabled by a system-prompt override. [c-customtemplate][c-projecttemplate][c-promptrender][c-dateinject][c-datewire][c-datetemplate]

[INFERENCE] Use a physically clean actual launch cwd plus clean ancestors/private home/profile. The supplied flags are not universal context-discovery suppression. The stock prompt/footer remains a residual under the no-fork/no-patch constraint.

### Network besides inference

| Surface | Source behavior / control |
|---|---|
| Version checks | `startup.checkUpdate` boolean default true. **Inspected main call is interactive-only**, not an unconditional print request. False is a defensive control, not proof print normally checks updates. [c-update][s-updates] |
| Marketplace | Auto-update scheduling independent of transcript mode; `marketplace.autoUpdate` enum off/notify/auto default notify; off prevents scheduling. [c-marketplace][s-updates] |
| OTLP | `telemetry.otlpExportEnabled` boolean default true; exporter also requires endpoint env. Set false and exclude OTLP endpoint variables. [s-telemetry][c-telemetry] |
| MCP | Ordinary print can discover/connect configured servers; restrictive --no-tools gate suppresses this manager path. [c-mcpgate] |
| Model catalogs | **Print/noninteractive starts refreshInBackground**, default online-if-uncached; SDK also starts runtime discovery without UI. Unauthenticated shared catalogs can be queried even without unrelated provider credentials. Endpoint **https://catalog.stencil.so/models.json.zstd**, conditional GET/ETag; fresh empty cache is not suppression. [c-catalogstart][c-sdkcatalog][c-catalogrefresh][c-catalogeligibility][p-catalogfetch] |
| OAuth auxiliaries | Parent token command can refresh/bootstrap identity; env-only child's stored selector has no row to refresh/rank/probe. [a-oauthresolve][a-select] |
| Side work/cache warming | Use providers.cacheWarming=off/retention=none; disable actual side-model masters and listed CLI gates. No-session does not disable these. [s-cache][s-all][c-auxgates] |

The catalog API supports programmatic `offline`, but stock print starts online-eligible refresh. **No verified stock top-level setting/flag universally forces every catalog refresh offline.** Disabling providers excludes their managers, not a universal offline switch for the selected provider/shared fetch. `providers.fetch` is a web-content fetch backend selector, not catalog/offline control. [p-catalogpolicy][c-catalogeligibility][s-fetch]

[INFERENCE] If the approved run may contact only inference endpoint, enforce an independent egress policy; the flags/settings above do not establish that network boundary.

## 7. Disk writes in `--print --no-session`, exact roots

No-session selects SessionManager.inMemory / MemorySessionStorage persist=false; ordinary session JSONL is suppressed. **It is not no-disk mode.** SessionManager still has BlobStore; blob puts can write even with memory session, but constructing BlobStore alone is not a content write. [c-nosession][c-memorysession][c-blobs]

| Store / write path | Trigger and relocation |
|---|---|
| agent.db | Broker unset opens local SQLite at startup even with only env bearer; mkdir, schema and WAL work can create/write fresh DB. Auth/cache/usage/client tables are separate from transcript. Agent data category. [a-brokeropen][a-sqliteopen][u-datadirs] |
| Logs | File transport defaults on. First emitted local log initializes directory/sink; batches open file, warn/error flush promptly. OMP_LOG_LEVEL is severity, not a verified off switch. Programmatic file:false not a stock CLI flag. State/log category. [u-logger][u-logdir] |
| models.db | Default model-cache DB; runtime/catalog refresh can persist snapshots after successful fetch and cache-derived state after failed refresh. Explicit models config can place cache neighboring that config. Agent data category. [p-modelcache][p-modelpersist][c-cachepath][u-datadirs] |
| history.db | HistoryStorage.open mkdir/open SQLite when history/picker loader used; inspected ordinary print does not invoke that picker loader. Not asserted inevitable. Agent data category. [c-history][c-historycall][u-datadirs] |
| Blobs/artifacts | BlobStore.put writes when blob-bearing paths reached, independent of memory transcript. Plain text/no-tools need not put blobs. Agent data category. [c-blobs][u-datadirs] |
| Skill/MCP feature caches | Skill-description DB agent data; MCP settings cache when manager created. Feature/discovery gates avoid corresponding paths, not global writes. [u-datadirs][c-mcpgate] |
| Settings/migration/markers | Startup can migrate old config/write markers; no-session does not make Settings in-memory. Fresh clean roots avoid old-state migration inputs, not a filesystem write barrier. [c-settingswrites] |
| Temporary helpers | TempDir uses os.tmpdir for default/@ prefixes; bare prefix may use cwd. Private application roots are not a universal tmp relocation. Exact runtime os.tmpdir env precedence is outside this repository source. [u-temp] |

### Root/env semantics (important correction to the premise)

- **HOME:** basis for os.homedir/native root/foreign user ecosystems. Private HOME needed even when agent dir overridden. [u-roots]
- **PI_CONFIG_DIR:** directory name/path **joined under HOME** by `path.join(os.homedir(), getConfigDirName())`, not simply an arbitrary absolute-root API. Use a safe home-relative name; do not assume path.resolve semantics. [u-roots]
- **PI_CODING_AGENT_DIR:** default-profile agent-dir override. Named profiles derive config-root/profiles/name/agent; OMP_PROFILE takes precedence over PI_PROFILE. Profile selection is another launch input. This does not relocate all root-level logs/foreign files. [u-profiles][u-xdg]
- **XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME:** Linux category relocation is conditional on existing app-root/migration state. Merely setting **empty** XDG roots does not guarantee they are selected; paths can fall back to private config/agent roots. Data contains auth/history/models/sessions/blobs/skill DB; state logs; category caches under cache. Agent prefix is flattened in XDG mode. [u-xdg][u-datadirs][u-logdir]
- **PI_CODING_AGENT_SESSION_DIR / --session-dir:** session-file destination only, not logs/auth/models/blob relocation. [c-sessionenv]

[INFERENCE] Private HOME plus private config/default-profile/XDG roots still keeps fallback destinations private, but purge the entire private root set, not just sessions. [UNKNOWN] No universal zero-write claim or all-prompts runtime inventory is made; above are source-established startup/write-capable paths and conditions.

## 8. Session account pools versus env-only token

### Strict session restriction is real — but not top-level CLI-wired

`task.agentAccountPools` is registered record/default `{}` with validator. Shape: **agent name → provider ID → canonical identity-key array**. Structured task dispatch selects the exact agent-name entry, executor forwards `oauthAccountPools` to createAgentSession, SDK installs SessionAccountPoolScope. SDK option shape itself is **provider ID → identity-key array**. [s-taskpool][c-taskpoolselect][c-taskpoolforward][c-sdkpool]

For a **listed/restricted provider**, cascade checks session restriction before key tiers: runtime key skipped; models.yml apiKey rejected; only allowed stored OAuth account(s) serve; none available fails **No API key for provider … restricted to its OAuth account pool** before login/API/env fallback. Selector filters before rank/preflight/pin/fallback. An unlisted provider is not globally forbidden, so model/provider fallback controls still matter, particularly if a profile holds credentials for other providers. [a-cascade][a-select][c-sdkpool]

**No equivalent pool is wired into stock top-level print:** main's buildSessionOptions does not populate oauthAccountPools, and print consumes the already-created session. A task-agent setting is not a root-session restriction. Programmatic SDK support is not a permitted stock-CLI route under no fork/patch. An unknown guessed overlay key such as session.accountPool is not a control. [c-mainoptions][c-printlaunch][s-all][s-validation]

**Process broker pools are weaker:** `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` parses provider → identity list, used only on broker-store branch. Remote-store consumer immediately allows non-OAuth rows, exact-filters OAuth identities, and applies that filter to snapshots/stream updates. API keys remain visible; this is not the session fail-closed guarantee. Without broker URL, that env file is not a local session pool. [a-brokerpool][a-brokeropen][a-remote-filter]

### Listing identity keys without secrets

`omp usage accounts --provider anthropic --json` has a dedicated OAuth-only projection: **`{accounts:[{provider,identityKey,orgName?}]}`**, identityKey may be null. Text groups provider/key/optional organization display name. It does not print access or refresh tokens; `--redact` is rejected because canonical config keys must be verbatim. Broker snapshot may be revalidated. No command was executed here. [c-usageaccounts]

Anthropic identity is org-scoped: normalized email preferred, then account/project; append `|org:<id>` when available, org-only possible. Example **`email:owner@example.com|org:<organization-id>`**, not actual owner's value. API keys return null. Use exact listed keys, not reconstructed display labels from token --list. [a-identity][a-authpolicy]

### A/B comparison

| | A: env access bearer | B: strict session OAuth pool over profile |
|---|---|---|
| Stock top-level print | Supported | SDK/task support, **not root CLI-wired** |
| Owner-store exposure | Not needed; private empty local DB created | Needs readable stored OAuth rows or broker access; conflicts with empty roots |
| Refresh capability | No env-only refresh | Refresher can rotate/persist tokens in selected store |
| API-key exclusion | By actual absence of alternate tiers | Restricted provider fails closed before key tiers |
| Identity binding | Trusted parent's exact-row acquisition; env string lacks guaranteed account metadata | Canonical stored identity keys constrain selection |
| Other providers | Pin primary and disable fallback/side paths | Pool is per provider, not global provider allowlist |
| Authority exposure | One access bearer with OAuth scopes | Readable store/broker can expose more than routed account; restriction is routing, not OS/store authorization |

Sources: cascade, SDK/task wiring, broker/local-store branches and refresh persistence above. [a-cascade][c-sdkpool][a-brokeropen][a-refreshpersist] [INFERENCE] Design A is preferable for the required stock-print runner; design B must not be presented as available simply by adding task.agentAccountPools to --config. Copying a narrowly scoped credential row would still give child refresh token/store mutation capability; exposing owner's whole DB is broader, and neither is empty-root isolation.

## Residual risks and acceptance boundary

1. Expiry/revocation, owner-store races/ordinal changes: env child fails rather than self-refreshes; parent acquisition can mutate owner's selected row. [a-oauthresolve][a-refreshpersist]
2. Launch/ancestor dotenv, configs, argv, model/header/extension contamination: private roots alone insufficient. [u-dotenv][a-cascade][c-discoveryproviders]
3. Hidden retries and final-attempt-only usage: no one-request or total-cost guarantee from last message_end. [a-streamretry][a-providerloop][a-emptyretry]
4. Zero exit with truncated/toolUse-only/missing assistant: require independent strict acceptance and parent timeout. [c-printterminal][a-deadline]
5. Stock critical/date/cwd prompt wrappers survive custom prompt. [c-projecttemplate][c-datewire]
6. Catalog egress and logger/SQLite/cache/blob writes remain under no-session. [c-catalogstart][p-catalogfetch][u-logger][a-sqliteopen][c-blobs]
7. **OAuth is not a zero-overage proof.** Slow-mode controller represents `overageAllowed/overageInUse` and extra usage after wrap-up. Account-side billing/entitlement is not established by bearer headers or request usage cost. [c-overage] [UNKNOWN] Actual owner's extra-usage setting/subscription is not inspected.
8. [INFERENCE] Credential-only isolation is not a complete security sandbox: child's bearer has the policy's inference/account/session/MCP/file scopes. Keep parent acquisition/stdout/logging trusted and token-free; restrict filesystem/process/egress separately. [a-authpolicy]

**No runtime certification:** this report does not establish installed-binary/source-digest correspondence, actual token identity/tier, account entitlement, network trace, purge behavior or a completed isolated execution. Those are outside the read-only task.

## Tagged source references

[a-env]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/env-api-key.ts#L24-L61
[a-envhook]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/registry/hooks/env.ts#L23-L28
[u-pickenv]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/env.ts#L330-L338
[a-tokenclass]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/catalog/src/utils.ts#L43-L45
[a-headers]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/providers/anthropic.ts#L377-L501
[a-betas]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/providers/anthropic.ts#L229-L256
[a-clientopts]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/providers/anthropic.ts#L4272-L4300
[a-authpolicy]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/catalog/src/compat/rules/auth/anthropic.kdl#L1-L54
[a-select]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth/select.ts#L525-L777
[a-cascade]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth/cascade.ts#L359-L458
[a-configkeys]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth/cascade.ts#L30-L120
[c-keyresolver]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/api-key-resolver.ts#L53-L105
[a-authretry]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth-retry.ts#L133-L253
[a-refresh]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth/refresh.ts#L450-L548
[c-modelkeys]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/model-registry.ts#L3230-L3345
[c-modelconfig]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/model-registry.ts#L499-L550
[a-streamretry]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/stream.ts#L1285-L1430
[a-brokerconfig]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth-broker/discover.ts#L330-L373
[a-brokeropen]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth-broker/discover.ts#L394-L463
[c-brokersettings]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/model-settings.ts#L36-L56
[u-dotenv]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/env.ts#L110-L314
[p-anthropic]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/catalog/src/compat/rules/providers/anthropic.kdl#L3-L42
[c-startmodel]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/sdk.ts#L3122-L3178
[c-fallback]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/retry-fallback-chains.ts#L154-L172
[c-turnretry]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/turn-recovery.ts#L2488-L2535
[c-streamsettings]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/settings-stream-fn.ts#L107-L179
[a-serverfallback]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/providers/anthropic.ts#L2574-L2595
[a-native]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/stream.ts#L1438-L1465
[c-tokenflags]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/commands/token.ts#L37-L94
[c-tokenaccount]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/commands/token.ts#L106-L157
[c-tokenbare]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/commands/token.ts#L159-L228
[a-oauthaccounts]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth/oauth.ts#L249-L278
[a-oauthexact]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth/oauth.ts#L299-L327
[a-oauthresolve]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth/oauth.ts#L174-L220
[a-refreshpersist]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth/refresh.ts#L300-L380
[u-clierrors]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/cli.ts#L483-L505
[c-cli-fatal]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/cli.ts#L588-L595
[u-fatal]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/postmortem.ts#L522-L560
[a-providerretry]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/providers/anthropic.ts#L1754-L1756
[a-providerloop]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/providers/anthropic.ts#L3550-L3933
[a-retryclass]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/error/retryable.ts#L20-L64
[a-httpclient]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/providers/anthropic-client.ts#L105-L301
[a-emptyretry]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/utils/empty-completion-retry.ts#L21-L217
[s-registry]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/registry.ts#L36-L120
[s-all]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/all-settings.ts#L7-L76
[s-modes]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/modes/settings.ts#L30-L40
[s-extensions]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/extensibility/settings.ts#L10-L13
[s-workspace]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/context-settings.ts#L12-L69
[s-retry]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/settings.ts#L679-L779
[s-fallback]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/settings.ts#L833-L852
[s-serverfallback]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/settings.ts#L884-L908
[s-cache]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/settings.ts#L1145-L1185
[s-contextpromotion]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/context-settings.ts#L76-L86
[s-prewalk]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/settings.ts#L75-L86
[s-advisor]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/advisor/settings.ts#L11-L145
[s-advisorvalues]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/tui/src/overlays/advisor-config.ts#L47-L51
[s-advisorbudget]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/advisor/emission-guard.ts#L107-L108
[s-autolearn]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/autolearn/settings.ts#L11-L47
[s-loopguards]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/settings.ts#L273-L339
[s-memory]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/memory-backend/settings.ts#L13-L19
[s-unexpected]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/settings.ts#L1052-L1075
[s-mcp]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/mcp/settings.ts#L10-L19
[s-plan]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/plan-mode/settings.ts#L13-L58
[s-compaction]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/context-settings.ts#L105-L378
[s-compactionmethods]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/compaction-methods.ts#L42-L50
[c-overlay]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/settings.ts#L2485-L2530
[s-validation]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/registry.ts#L615-L695
[c-settingsvalidation]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/settings.ts#L3911-L3917
[c-printformat]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/modes/print-mode.ts#L60-L245
[c-printterminal]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/modes/print-mode.ts#L265-L395
[c-printsignals]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/modes/print-mode.ts#L126-L139
[c-lengthrecovery]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/agent-session.ts#L7885-L7900
[c-compactioncontinue]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/agent-session.ts#L4785-L4835
[c-deadline]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L1333-L1354
[a-deadline]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/agent/src/agent-loop.ts#L1183-L1222
[a-abortmessage]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/agent/src/agent-loop.ts#L2708-L2755
[a-serverusage]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/providers/anthropic.ts#L3108-L3125
[c-agentsmd]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/discovery/agents-md.ts#L1-L31
[c-claudemd]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/discovery/claude-md.ts#L1-L31
[c-contextwalk]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/discovery/helpers.ts#L700-L785
[c-nativecontext]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/discovery/builtin.ts#L925-L964
[c-nativeprompt]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/discovery/builtin.ts#L258-L282
[c-nativerules]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/discovery/builtin.ts#L391-L438
[c-nativeskills]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/discovery/builtin.ts#L295-L354
[c-discoveryproviders]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/discovery/index.ts#L1-L39
[c-claudecontext]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/discovery/claude.ts#L156-L190
[c-extra-context]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/system-prompt.ts#L769-L780
[c-cli-prompt]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L1352-L1381
[c-cli-gates]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L1641-L1663
[c-cli-extensions]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L1689-L1803
[c-auxgates]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L1529-L1578
[c-mcpgate]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/sdk.ts#L2474-L2514
[c-systemload]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/system-prompt.ts#L275-L300
[c-customtemplate]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/prompts/system/custom-system-prompt.md#L1-L43
[c-projecttemplate]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/prompts/system/project-prompt.md#L1-L73
[c-promptrender]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/system-prompt.ts#L1018-L1049
[c-dateinject]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/date-cwd-reminder.ts#L1-L80
[c-datewire]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/sdk.ts#L4207-L4216
[c-datetemplate]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/prompts/system/date-cwd-reminder.md#L1-L3
[c-update]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L2568-L2573
[s-updates]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/modes/settings.ts#L1097-L1130
[c-marketplace]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/extensibility/plugins/marketplace-auto-update.ts#L11-L43
[s-telemetry]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/telemetry-settings.ts#L7-L13
[c-telemetry]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L2223-L2245
[c-catalogstart]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L2259-L2270
[c-sdkcatalog]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/sdk.ts#L2742-L2761
[c-catalogrefresh]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/model-registry.ts#L621-L630
[c-catalogeligibility]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/model-registry.ts#L2393-L2452
[p-catalogfetch]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/catalog/src/provider-models/openai-compat.ts#L193-L250
[p-catalogpolicy]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/catalog/src/model-manager.ts#L521-L550
[s-fetch]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/settings.ts#L1271-L1290
[c-nosession]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L1219-L1225
[c-memorysession]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/session-manager.ts#L4316-L4324
[c-blobs]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/blob-store.ts#L180-L244
[a-sqliteopen]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth/sqlite-credential-store.ts#L580-L680
[u-logger]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/logger.ts#L294-L400
[u-logdir]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/dirs.ts#L619-L637
[p-modelcache]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/catalog/src/model-cache.ts#L321-L330
[p-modelpersist]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/catalog/src/model-manager.ts#L400-L455
[c-cachepath]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/model-registry.ts#L530-L547
[c-history]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/history-storage.ts#L156-L165
[c-historycall]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L197-L220
[c-settingswrites]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/config/settings.ts#L2533-L2597
[u-temp]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/temp.ts#L7-L85
[u-roots]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/dirs.ts#L115-L143
[u-profiles]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/dirs.ts#L83-L95
[u-xdg]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/dirs.ts#L306-L424
[u-datadirs]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/utils/src/dirs.ts#L921-L973
[c-sessionenv]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/cli/args.ts#L207-L215
[s-taskpool]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/task/settings.ts#L459-L465
[c-taskpoolselect]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/task/structured-subagent.ts#L387-L419
[c-taskpoolforward]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/task/executor.ts#L4308-L4316
[c-sdkpool]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/sdk.ts#L1884-L1890
[c-mainoptions]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L1333-L1695
[c-printlaunch]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/main.ts#L2628-L2640
[a-brokerpool]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth-broker/discover.ts#L258-L307
[a-remote-filter]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth-broker/remote-store.ts#L46-L54
[c-usageaccounts]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/cli/usage-cli.ts#L1204-L1250
[a-identity]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/ai/src/auth/sqlite-credential-store.ts#L192-L228
[c-overage]: https://github.com/can1357/oh-my-pi/blob/v18.9.2/packages/coding-agent/src/session/anthropic-slow-mode.ts#L329-L375
