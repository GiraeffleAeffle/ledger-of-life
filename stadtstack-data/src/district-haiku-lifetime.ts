import { spawn, type ChildProcess } from 'node:child_process';
import { Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const HAIKU_LIFETIME_VERSION = 'haiku-independent-lifetime-v1';
export const HAIKU_LIFETIME_MAX_MS = 300_000;
export const HAIKU_LIFETIME_TEARDOWN_MS = 5_000;
const launchSchema = z.object({ operation: z.literal('launch'), executable: z.string().startsWith('/'), args: z.array(z.string()),
  env: z.record(z.string(), z.string()), timeoutMs: z.number().int().positive().max(HAIKU_LIFETIME_MAX_MS),
  leaseMs: z.number().int().positive().max(HAIKU_LIFETIME_MAX_MS), freshnessMs: z.number().int().nonnegative().max(HAIKU_LIFETIME_MAX_MS) }).strict();
export type HaikuLifetimeLaunch = z.infer<typeof launchSchema>;
export const HaikuLifetimeAckSchema = z.discriminatedUnion('state', [
  z.object({ version: z.literal(HAIKU_LIFETIME_VERSION), state: z.literal('ready') }).strict(),
  z.object({ version: z.literal(HAIKU_LIFETIME_VERSION), state: z.literal('closed'), code: z.number().int().nullable(), treeGone: z.boolean() }).strict(),
]);
export type HaikuLifetimeAck = z.infer<typeof HaikuLifetimeAckSchema>;
export interface HaikuLifetimePorts { lifeline: Readable; control: Readable; acknowledge: Writable }
export interface HaikuLifetimeProcess {
  pid?: number;
  on(event: 'spawn', callback: () => void): unknown;
  on(event: 'exit', callback: (code: number | null) => void): unknown;
  on(event: 'error', callback: () => void): unknown;
}
export interface HaikuLifetimeDependencies {
  spawn(launch: HaikuLifetimeLaunch): HaikuLifetimeProcess;
  killGroup(pid: number): void;
  groupExists(pid: number): boolean;
  now(): number;
  timeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  finished(treeGone: boolean): void;
}

// Source-free supervisor: descriptors 0/1/2 are inherited directly by the child.
// This code never consumes, copies, parses or logs model stdin/stdout/stderr.
// Descriptor 3 is a separate parent-only lifeline (not ordinary model stdin EOF).
// Descriptor 4 carries only launch settings/deadline renewals; no source or lease ID.
// Descriptor 5 carries only readiness/complete-group-teardown acknowledgements.
export function superviseHaikuLifetime(ports: HaikuLifetimePorts, deps: HaikuLifetimeDependencies) {
  let child: HaikuLifetimeProcess | null = null, launched = false, stopping = false, finished = false;
  let modelCode: number | null = null, teardownAt = 0, controlText = '';
  let masterDeadline: unknown, leaseDeadline: unknown, freshnessDeadline: unknown, teardownPoll: unknown;
  let freshnessMs = 0;
  const decoder = new StringDecoder('utf8');
  const acknowledge = (ack: HaikuLifetimeAck) => ports.acknowledge.write(JSON.stringify(ack) + '\n');
  const finish = (treeGone: boolean) => {
    if (finished) return;
    finished = true;
    for (const handle of [masterDeadline, leaseDeadline, freshnessDeadline, teardownPoll]) deps.clearTimeout(handle);
    controlText = '';
    acknowledge({ version: HAIKU_LIFETIME_VERSION, state: 'closed', code: modelCode, treeGone });
    deps.finished(treeGone);
  };
  const confirmTeardown = () => {
    if (finished) return;
    if (!child?.pid) { finish(true); return; }
    let exists = true;
    try { exists = deps.groupExists(child.pid); } catch { /* Cannot claim teardown on an inspection failure. */ }
    if (!exists) { finish(true); return; }
    if (deps.now() >= teardownAt) { finish(false); return; }
    teardownPoll = deps.timeout(confirmTeardown, 20);
  };
  const stop = () => {
    if (finished || stopping) return;
    stopping = true;
    teardownAt = deps.now() + HAIKU_LIFETIME_TEARDOWN_MS;
    // Even a normally exited leader can leave descendants with closed streams.
    // Always kill/check the whole detached group, not merely the immediate PID.
    if (child?.pid) { try { deps.killGroup(child.pid); } catch { /* Group inspection below must prove absence. */ } }
    confirmTeardown();
  };
  const renew = (leaseMs: number) => {
    deps.clearTimeout(leaseDeadline); deps.clearTimeout(freshnessDeadline);
    leaseDeadline = deps.timeout(stop, leaseMs);
    if (freshnessMs) freshnessDeadline = deps.timeout(stop, freshnessMs);
  };
  const consumeControl = (line: string) => {
    if (finished || stopping) return;
    if (!launched) {
      const launch = launchSchema.parse(JSON.parse(line));
      launched = true; freshnessMs = launch.freshnessMs;
      masterDeadline = deps.timeout(stop, launch.timeoutMs);
      renew(launch.leaseMs);
      child = deps.spawn(launch);
      child.on('spawn', () => {
        if (finished) return;
        if (stopping) { try { if (child?.pid) deps.killGroup(child.pid); } catch { /* Teardown poll remains authoritative. */ } return; }
        acknowledge({ version: HAIKU_LIFETIME_VERSION, state: 'ready' });
      });
      child.on('exit', code => { modelCode = code; stop(); });
      child.on('error', stop);
    } else {
      const renewal = z.object({ operation: z.literal('renew'), leaseMs: z.number().int().positive().max(HAIKU_LIFETIME_MAX_MS) }).strict().parse(JSON.parse(line));
      renew(renewal.leaseMs);
    }
  };
  ports.control.on('data', (chunk: Buffer) => {
    if (finished || stopping) { chunk.fill(0); return; }
    controlText += decoder.write(chunk); chunk.fill(0);
    if (Buffer.byteLength(controlText) > 64 * 1024) { stop(); return; }
    let newline: number;
    while ((newline = controlText.indexOf('\n')) >= 0) {
      const line = controlText.slice(0, newline); controlText = controlText.slice(newline + 1);
      try { consumeControl(line); } catch { stop(); }
    }
  });
  ports.control.on('end', stop); ports.control.on('error', stop);
  ports.lifeline.on('end', stop); ports.lifeline.on('error', stop);
  // A lifeline is deliberately payload-free. EOF independently survives bridge
  // crash/SIGKILL, while ordinary model stdin is normally closed after submission.
  ports.lifeline.on('data', (chunk: Buffer) => { chunk.fill(0); stop(); });
  ports.acknowledge.on('error', stop);
  return { stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Pollable existing pipes, not filesystem ReadStreams with potentially blocked
  // thread-pool reads. Shutdown must not wait for the parent to close fd 4.
  const lifeline = new Socket({ fd: 3, readable: true, writable: false });
  const control = new Socket({ fd: 4, readable: true, writable: false });
  const acknowledge = new Socket({ fd: 5, readable: false, writable: true });
  const supervisor = superviseHaikuLifetime({ lifeline, control, acknowledge }, {
    spawn: launch => spawn(launch.executable, launch.args, { cwd: '/', env: launch.env, detached: true, stdio: [0, 1, 2] }) as ChildProcess,
    killGroup: pid => { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } },
    groupExists: pid => { try { process.kill(-pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } },
    now: () => performance.now(), timeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
    finished: treeGone => { lifeline.destroy(); control.destroy(); acknowledge.end(() => acknowledge.destroy()); process.exitCode = treeGone ? 0 : 1; },
  });
  process.on('SIGTERM', supervisor.stop); process.on('SIGINT', supervisor.stop); process.on('SIGHUP', supervisor.stop);
  process.on('uncaughtException', supervisor.stop); process.on('unhandledRejection', supervisor.stop);
}
