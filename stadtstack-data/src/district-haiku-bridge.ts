import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { Readable, Writable } from 'node:stream';
import { HAIKU_LIFETIME_VERSION, HaikuLifetimeAckSchema, type HaikuLifetimeAck } from './district-haiku-lifetime.ts';
import { z } from 'zod';
import { canonicalJson, digest, HashSchema } from './district-adapter-contract.ts';
import { PROMPTS, assessmentOutputSchema } from './district-assessment.ts';
import { claudeExecutionArgs, inspectClaudeEvents } from './district-claude.ts';
import { sourceFreeModelReadiness, type ReadinessExecutor } from './district-model-readiness.ts';
import { PROVIDER_CONFIGS, type ModelEvidence } from './district-model-contract.ts';
import { ASSESSMENT_BRIDGE_VERSION, ASSESSMENT_BRIDGE_REMOTE_COMMAND, ASSESSMENT_BRIDGE_SSH_HOST, BRIDGE_LIMITS, BridgeAnswerSchema, BridgeLeaseSchema, BridgeRequestSchema, BridgeStatusSchema, type BridgeLease, type BridgeRequest, type BridgeStatus } from './district-assessment-bridge-contract.ts';

// Fixed source-free profile: inherited by every model descendant. No writable
// exception, temp directory, answer file or fallback to an unsandboxed process.
export const HAIKU_SANDBOX_PROFILE = '(version 1)\n(allow default)\n(deny file-write*)\n(deny process-fork)\n';
const MODEL_STDOUT_BYTES = 96 * 1024;
const MODEL_SCHEMA = z.toJSONSchema(assessmentOutputSchema);
// Explicitly approved privacy exception: this repository-public, code-defined
// prompt and static schema retain their original trusted CLI role/strict adapter.
// No lease-derived string enters argv; equality is checked before evidence send.
const MODEL_ARGS = Object.freeze(claudeExecutionArgs(PROMPTS.B, MODEL_SCHEMA));
export const HAIKU_BRIDGE_CLIENT_CONTRACT_SHA256 = digest(canonicalJson({
  version: ASSESSMENT_BRIDGE_VERSION, role: 'B', sandbox: HAIKU_SANDBOX_PROFILE,
  executable: PROVIDER_CONFIGS['anthropic-subscription'].binary, args: MODEL_ARGS,
  remoteCommand: ASSESSMENT_BRIDGE_REMOTE_COMMAND, persistence: 'stdin-stdout-ram-only', lifetime: HAIKU_LIFETIME_VERSION,
}));
export function haikuBridgeSshArgs(): string[] {
  return ['-T', '-q', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'PermitLocalCommand=no',
    '-o', 'RemoteCommand=none', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'ControlPersist=no', '-o', 'EscapeChar=none', '-o', 'LogLevel=ERROR',
    '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=1', ASSESSMENT_BRIDGE_SSH_HOST, ASSESSMENT_BRIDGE_REMOTE_COMMAND];
}
export type BridgeHoldReason = 'isolation_unavailable' | 'client_disconnected' | 'lease_expired' | 'authority_changed' | 'provider_failed' | 'submission_unacknowledged' | 'invalid_contract';
export class HaikuBridgeHold extends Error {
  constructor(readonly reason: BridgeHoldReason, readonly teardownConfirmed = true) { super('Haiku bridge held'); this.name = 'HaikuBridgeHold'; }
}
export interface BridgeProcessSpec {
  executable: string; args: readonly string[]; env: NodeJS.ProcessEnv;
  input: Buffer; timeoutMs: number; stdoutLimit: number; signal?: AbortSignal;
  inspectOutput?: (chunk: Buffer) => void;
  beforeSend?: () => Promise<void>;
  lifetime?: { leaseMs: number; freshnessMs: number; attach(update: ((leaseMs: number) => void) | null): void };
}
export interface BridgeProcessResult { stdout: Buffer; code: number | null }
export type BridgeProcessRunner = (spec: BridgeProcessSpec) => Promise<BridgeProcessResult>;
export type BridgeSpawn = (executable: string, args: string[], options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] }) => ChildProcess;

// stderr is bounded and discarded, never returned, logged or attached to errors.
// Buffer ownership transfers to the caller, which must dispose it in finally.
export function createBridgeProcessRunner(spawnProcess: BridgeSpawn = spawn): BridgeProcessRunner {
  return async spec => {
    if (spec.signal?.aborted) throw new HaikuBridgeHold('client_disconnected');
    let child: ChildProcess;
    try {
      // Independent session survives termination of the bridge's whole process
      // group; its private lifeline still receives EOF and kills the model group.
      child = spawnProcess(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./district-haiku-lifetime.ts', import.meta.url))],
        { cwd: '/', env: spec.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    } catch { throw new HaikuBridgeHold('client_disconnected'); }
    const streams = child.stdio as readonly (Readable | Writable | null)[];
    const lifeline = streams[3], control = streams[4], acknowledgements = streams[5];
    if (!child.stdin || !child.stdout || !child.stderr || !(lifeline instanceof Writable) || !(control instanceof Writable) || !(acknowledgements instanceof Readable)) {
      child.kill('SIGTERM');
      throw new HaikuBridgeHold('isolation_unavailable');
    }
    const { promise, resolve, reject } = Promise.withResolvers<BridgeProcessResult>();
    const chunks: Buffer[] = [];
    let bytes = 0, failure: BridgeHoldReason | null = null, closed = false, ready = false, ackText = '';
    let teardown: Extract<HaikuLifetimeAck, { state: 'closed' }> | null = null;
    const stop = (reason: BridgeHoldReason) => {
      if (closed || failure) return;
      failure = reason;
      // Never SIGKILL the source-free supervisor: EOF on this separate pipe
      // instructs it to kill/prove absence of the source-bearing process group.
      lifeline.end();
    };
    const abort = () => stop('client_disconnected');
    const deadline = setTimeout(() => stop('client_disconnected'), spec.timeoutMs);
    const cleanup = () => {
      closed = true; clearTimeout(deadline); spec.signal?.removeEventListener('abort', abort);
      spec.lifetime?.attach(null); lifeline.destroy(); control.destroy(); acknowledgements.destroy();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (closed || failure || bytes > spec.stdoutLimit) { chunk.fill(0); stop('provider_failed'); return; }
      chunks.push(chunk);
      try { spec.inspectOutput?.(chunk); } catch { stop('provider_failed'); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length; chunk.fill(0);
      if (bytes > spec.stdoutLimit) stop('provider_failed');
    });
    acknowledgements.on('data', (chunk: Buffer) => {
      ackText += chunk.toString('utf8'); chunk.fill(0);
      if (ackText.length > 4096) { stop('provider_failed'); return; }
      let newline: number;
      while ((newline = ackText.indexOf('\n')) >= 0) {
        const line = ackText.slice(0, newline); ackText = ackText.slice(newline + 1);
        try {
          const ack = HaikuLifetimeAckSchema.parse(JSON.parse(line));
          if (ack.state === 'ready') {
            if (ready || teardown) { stop('provider_failed'); continue; }
            ready = true;
            // Supervisor startup can take time: recheck VM authority at the
            // actual stdin handoff, not merely before launching the supervisor.
            void (async () => {
              try {
                await spec.beforeSend?.();
                if (!closed && !failure && !teardown) child.stdin!.end(spec.input);
              } catch (error) { stop(error instanceof HaikuBridgeHold ? error.reason : 'client_disconnected'); }
            })();
          } else {
            if (teardown) { stop('provider_failed'); continue; }
            teardown = ack;
            spec.lifetime?.attach(null);
            if (!ack.treeGone) stop('provider_failed');
          }
        } catch { stop('provider_failed'); }
      }
    });
    for (const stream of [child.stdin, lifeline, control, acknowledgements]) stream.on('error', () => stop('client_disconnected'));
    child.on('error', () => {
      if (closed) return;
      cleanup(); for (const chunk of chunks) chunk.fill(0);
      reject(new HaikuBridgeHold('client_disconnected', false));
    });
    child.on('close', supervisorCode => {
      if (closed) return;
      cleanup();
      const treeGone = teardown?.treeGone === true;
      if (failure || supervisorCode !== 0 || !ready || !treeGone) {
        for (const chunk of chunks) chunk.fill(0);
        reject(new HaikuBridgeHold(failure ?? 'provider_failed', treeGone)); return;
      }
      const stdout = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      resolve({ stdout, code: teardown!.code });
    });
    spec.lifetime?.attach(leaseMs => {
      if (closed || failure || teardown) return;
      control.write(JSON.stringify({ operation: 'renew', leaseMs }) + '\n');
    });
    control.write(JSON.stringify({ operation: 'launch', executable: spec.executable, args: spec.args, env: spec.env,
      timeoutMs: spec.timeoutMs, leaseMs: spec.lifetime?.leaseMs ?? spec.timeoutMs, freshnessMs: spec.lifetime?.freshnessMs ?? 0 }) + '\n');
    spec.signal?.addEventListener('abort', abort, { once: true });
    if (spec.signal?.aborted) abort();
    return await promise;
  };
}
function nativeEnvironment(): NodeJS.ProcessEnv {
  const username = userInfo().username;
  return { HOME: homedir(), USER: username, LOGNAME: username,
    PATH: `${homedir()}/.local/share/mise/installs/node/24.21.0/bin:${homedir()}/.local/bin:/usr/bin:/bin`,
    LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: '/private/tmp',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
export function haikuSandboxSpec(args: readonly string[], input: Buffer, signal?: AbortSignal): BridgeProcessSpec {
  return { executable: '/usr/bin/sandbox-exec', args: ['-p', HAIKU_SANDBOX_PROFILE, PROVIDER_CONFIGS['anthropic-subscription'].binary, ...args],
    env: nativeEnvironment(), input, signal, timeoutMs: 240_000, stdoutLimit: MODEL_STDOUT_BYTES };
}
export type BridgeTransport = (request: BridgeRequest, signal?: AbortSignal) => Promise<unknown>;
export function createSshBridgeTransport(run: BridgeProcessRunner): BridgeTransport {
  return async (request, signal) => {
    let input: Buffer | null = null, result: BridgeProcessResult | null = null;
    try {
      BridgeRequestSchema.parse(request);
      input = Buffer.from(JSON.stringify(request));
      if (input.length > BRIDGE_LIMITS.requestBytes) throw new HaikuBridgeHold('invalid_contract');
      const env = nativeEnvironment();
      // Existing authentication only; an inherited SSH agent socket is not forwarded.
      if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
      result = await run({ executable: '/usr/bin/ssh', args: haikuBridgeSshArgs(), env, input, signal,
        timeoutMs: 20_000, stdoutLimit: BRIDGE_LIMITS.responseBytes });
      if (result.code !== 0 || result.stdout.length > BRIDGE_LIMITS.responseBytes) throw new HaikuBridgeHold('client_disconnected');
      return JSON.parse(result.stdout.toString('utf8'));
    } catch (error) { throw error instanceof HaikuBridgeHold ? error : new HaikuBridgeHold('client_disconnected'); }
    finally { input?.fill(0); result?.stdout.fill(0); }
  };
}
export interface BridgeTimers {
  timeout(callback: () => void, ms: number): unknown; interval(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void; clearInterval(handle: unknown): void;
}
const timers: BridgeTimers = {
  timeout: (fn, ms) => setTimeout(fn, ms), interval: (fn, ms) => setInterval(fn, ms),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
  clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
};
export interface HaikuBridgeDependencies {
  platform: string; run: BridgeProcessRunner; transport: BridgeTransport;
  isolation(signal: AbortSignal): Promise<void>; readiness(signal: AbortSignal): Promise<ModelEvidence>;
  now(): number; timers: BridgeTimers;
}
export function macHaikuBridgeDependencies(run: BridgeProcessRunner = createBridgeProcessRunner()): HaikuBridgeDependencies {
  const readinessExecute: ReadinessExecutor = async (_provider, args, timeout, signal) => {
    const input = Buffer.alloc(0);
    let result: BridgeProcessResult | null = null;
    try {
      result = await run({ ...haikuSandboxSpec(args, input, signal), timeoutMs: timeout });
      return { stdout: result.stdout.toString('utf8'), stderr: '', code: result.code, failure: null };
    } finally { input.fill(0); result?.stdout.fill(0); }
  };
  return { platform: process.platform, run, transport: createSshBridgeTransport(run), now: Date.now, timers,
    readiness: signal => sourceFreeModelReadiness('anthropic-subscription', readinessExecute, signal),
    isolation: async signal => {
      if (process.platform !== 'darwin') throw new HaikuBridgeHold('isolation_unavailable');
      // Source-free enforcement probe, not a model call. A supported but ineffective
      // profile is a hold too. Any allowed creation fails; cleanup of that empty
      // sentinel is attempted before failing. No source/response is present yet.
      const probe = "const fs=require('node:fs');const p='/private/tmp/.stadtstack-haiku-write-probe-'+process.pid;try{fs.writeFileSync(p,'',{flag:'wx'})}catch(e){process.exit(e.code==='EPERM'||e.code==='EACCES'?0:2)}try{fs.unlinkSync(p)}catch{}process.exit(1)";
      let result: BridgeProcessResult | null = null;
      const input = Buffer.alloc(0);
      try {
        result = await run({ executable: '/usr/bin/sandbox-exec', args: ['-p', HAIKU_SANDBOX_PROFILE, process.execPath, '-e', probe],
          env: nativeEnvironment(), input, signal, timeoutMs: 10_000, stdoutLimit: 4096 });
        if (result.code !== 0 || result.stdout.length) throw new HaikuBridgeHold('isolation_unavailable');
      } catch { throw new HaikuBridgeHold('isolation_unavailable'); }
      finally { input.fill(0); result?.stdout.fill(0); }
    },
  };
}
export function validateHaikuBridgeResponse(stdout: string): void {
  const inspected = inspectClaudeEvents(stdout);
  if (!inspected.completed || inspected.toolAttempted || inspected.failureCategory || !inspected.responseSha256) throw new HaikuBridgeHold('provider_failed');
  assessmentOutputSchema.parse(inspected.value);
}
export interface HaikuBridgeOutcome { state: 'submitted' | 'held'; receiptSha256: string | null; reason: BridgeHoldReason | null }
export async function runHaikuBridge(jobKey: string, clientId: string, deps: HaikuBridgeDependencies = macHaikuBridgeDependencies(), signal?: AbortSignal): Promise<HaikuBridgeOutcome> {
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  signal?.addEventListener('abort', externalAbort, { once: true });
  if (signal?.aborted) externalAbort();
  let lease: BridgeLease | null = null, input: Buffer | null = null, response: BridgeProcessResult | null = null;
  let heartbeat: unknown, expiry: unknown, checking = false, submitted = false;
  let failure: BridgeHoldReason | null = null, events = '';
  let leaseRemainingMs = 0, updateChildDeadline: ((leaseMs: number) => void) | null = null;
  const held = (reason: BridgeHoldReason) => { failure ??= reason; controller.abort(); };
  const releaseEvidence = () => {
    input?.fill(0); input = null; response?.stdout.fill(0); response = null; events = '';
    if (lease) lease.data = null;
  };
  const purge = () => ({ sourceFiles: 0 as const, responseFiles: 0 as const, modelFileWritesDenied: true as const, completedAt: new Date(deps.now()).toISOString() });
  const claimedAt = deps.now();
  const armExpiry = (expiresAt: string) => {
    const remaining = Math.min(Date.parse(expiresAt) - deps.now(), claimedAt + BRIDGE_LIMITS.maxLeaseMs - deps.now());
    if (remaining <= 0) throw new HaikuBridgeHold('lease_expired');
    deps.timers.clearTimeout(expiry);
    expiry = deps.timers.timeout(() => held('lease_expired'), remaining);
    leaseRemainingMs = remaining;
    updateChildDeadline?.(remaining);
  };
  const statusBinding = (raw: unknown): BridgeStatus => {
    const status = BridgeStatusSchema.parse(raw);
    if (!lease || status.leaseId !== lease.leaseId || status.inputSha256 !== lease.inputSha256
      || status.authoritySha256 !== lease.authoritySha256 || status.policySnapshotSha256 !== lease.policySnapshotSha256) throw new HaikuBridgeHold('authority_changed');
    return status;
  };
  const check = async () => {
    if (!lease || controller.signal.aborted) throw new HaikuBridgeHold(failure ?? 'client_disconnected');
    const status = statusBinding(await deps.transport({ operation: 'check', leaseId: lease.leaseId, inputSha256: lease.inputSha256 }, controller.signal));
    if (controller.signal.aborted) throw new HaikuBridgeHold(failure ?? 'client_disconnected');
    if (status.state !== 'active') throw new HaikuBridgeHold(status.state === 'expired' ? 'lease_expired' : 'authority_changed');
    armExpiry(status.expiresAt);
  };
  try {
    if (deps.platform !== 'darwin') throw new HaikuBridgeHold('isolation_unavailable');
    HashSchema.parse(jobKey);
    if (controller.signal.aborted) throw new HaikuBridgeHold('client_disconnected');
    const claim = BridgeRequestSchema.parse({ operation: 'claim', jobKey, clientId, clientContractSha256: HAIKU_BRIDGE_CLIENT_CONTRACT_SHA256 });
    await deps.isolation(controller.signal);
    const evidence = await deps.readiness(controller.signal);
    lease = BridgeLeaseSchema.parse(await deps.transport(claim, controller.signal));
    if (lease.jobKey !== jobKey || lease.clientContractSha256 !== HAIKU_BRIDGE_CLIENT_CONTRACT_SHA256
      || lease.system !== PROMPTS.B || canonicalJson(lease.outputSchema) !== canonicalJson(MODEL_SCHEMA)) throw new HaikuBridgeHold('invalid_contract');
    armExpiry(lease.expiresAt);
    heartbeat = deps.timers.interval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void check().catch(error => held(error instanceof HaikuBridgeHold ? error.reason : 'client_disconnected')).finally(() => { checking = false; });
    }, BRIDGE_LIMITS.heartbeatMs);
    input = Buffer.from(JSON.stringify(lease.data));
    if (input.length > BRIDGE_LIMITS.evidenceContextBytes) throw new HaikuBridgeHold('invalid_contract');
    const decoder = new StringDecoder('utf8');
    const inspectOutput = (chunk: Buffer) => {
      events += decoder.write(chunk);
      const end = events.lastIndexOf('\n');
      if (end < 0) return;
      const inspected = inspectClaudeEvents(events.slice(0, end));
      if (inspected.toolAttempted || inspected.failureCategory) throw new HaikuBridgeHold('provider_failed');
    };
    // Last awaited operation before actual model spawn/stdin send is VM authority check.
    await check();
    const startedAt = new Date(deps.now()).toISOString();
    response = await deps.run({ ...haikuSandboxSpec(MODEL_ARGS, input, controller.signal), inspectOutput, beforeSend: check,
      lifetime: { leaseMs: leaseRemainingMs, freshnessMs: BRIDGE_LIMITS.heartbeatMs + 21_000, attach: update => { updateChildDeadline = update; } } });
    if (controller.signal.aborted) throw new HaikuBridgeHold(failure ?? 'client_disconnected');
    if (response.code !== 0 || response.stdout.length > MODEL_STDOUT_BYTES) throw new HaikuBridgeHold('provider_failed');
    let stdout: string | null = response.stdout.toString('utf8');
    validateHaikuBridgeResponse(stdout);
    const finishedAt = new Date(deps.now()).toISOString();
    await check();
    deps.timers.clearInterval(heartbeat);
    releaseEvidence();
    const purgeAck = purge();
    let request: Extract<BridgeRequest, { operation: 'submit' }> | null = { operation: 'submit', leaseId: lease.leaseId, inputSha256: lease.inputSha256,
      purgeAck, answer: BridgeAnswerSchema.parse({ stdout, evidence, startedAt, finishedAt }) };
    stdout = null;
    let ack: unknown;
    submitted = true;
    try { ack = await deps.transport(request, controller.signal); }
    catch { throw new HaikuBridgeHold('submission_unacknowledged'); }
    finally { request = null; }
    // Response references and wire buffers have been released before ACK validation.
    const status = statusBinding(ack);
    if (controller.signal.aborted || status.state !== 'submitted' || !status.receiptSha256
      || status.purgeAckSha256 !== digest(canonicalJson(purgeAck))) throw new HaikuBridgeHold('submission_unacknowledged');
    return { state: 'submitted', receiptSha256: status.receiptSha256, reason: null };
  } catch (error) {
    controller.abort(); deps.timers.clearInterval(heartbeat); deps.timers.clearTimeout(expiry);
    releaseEvidence();
    const reason = failure ?? (error instanceof HaikuBridgeHold ? error.reason : 'provider_failed');
    // Without the independent teardown acknowledgement, never attest a purge.
    // The VM intent stays held/ambiguous for explicit reconciliation.
    if (lease && !submitted && !(error instanceof HaikuBridgeHold && !error.teardownConfirmed)) {
      // One best-effort disposition, never a provider retry. Offline VM/ambiguous
      // submissions are fenced and reconciled on the VM; do not re-claim here.
      const purgeAck = purge();
      try {
        const abandonReason = reason === 'lease_expired' || reason === 'authority_changed' || reason === 'client_disconnected' ? reason : 'provider_failed';
        const ack = statusBinding(await deps.transport({ operation: 'abandon', leaseId: lease.leaseId, inputSha256: lease.inputSha256, purgeAck, reason: abandonReason }));
        if (ack.state === 'active' || ack.purgeAckSha256 !== digest(canonicalJson(purgeAck))) throw new HaikuBridgeHold('submission_unacknowledged');
      } catch { /* VM lease expiry remains authoritative when acknowledgement is unavailable. */ }
    }
    return { state: 'held', receiptSha256: null, reason };
  } finally {
    controller.abort(); releaseEvidence(); deps.timers.clearInterval(heartbeat); deps.timers.clearTimeout(expiry);
    signal?.removeEventListener('abort', externalAbort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const [jobKey, clientId, ...extra] = process.argv.slice(2);
    if (!jobKey || !clientId || extra.length) throw new HaikuBridgeHold('invalid_contract');
    const outcome = await runHaikuBridge(jobKey, clientId, undefined, controller.signal);
    // This is the entire public CLI surface. Never print a lease, response,
    // exception, remote stderr, prompt, source, path or authentication detail.
    process.stdout.write(JSON.stringify({ state: outcome.state, receiptSha256: outcome.receiptSha256 }) + '\n');
    if (outcome.state !== 'submitted') process.exitCode = 1;
  } catch { process.stdout.write('{"state":"held","receiptSha256":null}\n'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
