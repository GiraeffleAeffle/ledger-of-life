import type { Readable, Writable } from 'node:stream';
import type { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WORKER_HEARTBEAT = 'heartbeat\n';
export const WORKER_HEARTBEAT_MS = 10_000;
export const WORKER_LEASE_MS = 45_000;
export const WORKER_CONTROL_BYTES = 32_768;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const HEARTBEAT_FRAME = Buffer.from(WORKER_HEARTBEAT.slice(0, -1));
export type WorkerLease<T> = { control: Promise<T>; signal: AbortSignal; dispose: () => void };

// SSH authenticates the channel. Only one bounded JSON control frame is accepted;
// subsequent frames are fixed heartbeats, never further commands or source text.
export function startWorkerLease<T>(input: Readable, parse: (raw: unknown) => T, options: { leaseMs?: number; signals?: EventEmitter } = {}): WorkerLease<T> {
  const controller = new AbortController();
  const ready = Promise.withResolvers<T>();
  const signals = options.signals ?? process;
  let controlled = false, disposed = false, inputStopped = false;
  let pending: Buffer = Buffer.alloc(0);
  let deadline: NodeJS.Timeout;
  const stopInput = () => {
    if (inputStopped) return;
    inputStopped = true;
    clearTimeout(deadline);
    input.off('data', data); input.off('end', eof); input.off('close', eof); input.off('error', streamError);
    input.pause(); pending = Buffer.alloc(0);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopInput();
    for (const signal of SIGNALS) signals.off(signal, interrupted);
  };
  const abort = (message: string) => {
    if (disposed || controller.signal.aborted) return;
    const error = Object.assign(Error(message), { failureCategory: 'transport' });
    // EOF can precede SIGTERM. Keep idempotent signal handlers through async cleanup.
    stopInput(); controller.abort(error); ready.reject(error);
  };
  const renew = () => { clearTimeout(deadline); deadline = setTimeout(() => abort('Worker connection lease expired'), options.leaseMs ?? WORKER_LEASE_MS); };
  const eof = () => abort('Worker connection lease ended');
  const streamError = () => abort('Worker connection lease stream failed');
  const interrupted = () => abort('Worker connection lease interrupted');
  const data = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && !inputStopped) {
      const newline = bytes.indexOf(10, offset), end = newline === -1 ? bytes.length : newline;
      const length = pending.length + end - offset;
      if (length > (controlled ? WORKER_HEARTBEAT.length - 1 : WORKER_CONTROL_BYTES)) { abort('Worker connection lease frame exceeds bound'); return; }
      pending = Buffer.concat([pending, bytes.subarray(offset, end)], length);
      if (newline === -1) return;
      const frame = pending; pending = Buffer.alloc(0); offset = newline + 1;
      if (!controlled) {
        let value: T;
        try { value = parse(JSON.parse(frame.toString('utf8'))); }
        catch { abort('Worker connection lease control invalid'); return; }
        controlled = true; renew(); ready.resolve(value);
      } else {
        if (!frame.equals(HEARTBEAT_FRAME)) { abort('Worker connection lease heartbeat invalid'); return; }
        renew();
      }
    }
  };
  input.on('data', data); input.once('end', eof); input.once('close', eof); input.once('error', streamError);
  for (const signal of SIGNALS) signals.on(signal, interrupted);
  renew();
  if (input.readableEnded || input.destroyed) eof();
  return { control: ready.promise, signal: controller.signal, dispose };
}

// Call only after inference has settled, including its native process close/cleanup.
// Attempt every acquired lock release before restoring default signal termination.
export async function finishWorkerLease(lease: WorkerLease<unknown>, locks: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  try {
    for (let index = locks.length - 1; index >= 0; index--) {
      try { await locks[index](); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Worker lock cleanup failed');
  } finally { lease.dispose(); }
}

export function startWorkerHeartbeat(output: Writable, control: unknown, failed: () => void) {
  const frame = JSON.stringify(control) + '\n';
  if (Buffer.byteLength(frame) - 1 > WORKER_CONTROL_BYTES) throw Error('Worker control frame exceeds bound');
  let timer: NodeJS.Timeout | undefined, disposed = false;
  const dispose = () => { disposed = true; clearInterval(timer); output.off('error', error); };
  const error = () => { if (!disposed) { dispose(); failed(); } };
  output.on('error', error);
  try { if (!output.write(frame)) error(); } catch { error(); }
  if (!disposed) timer = setInterval(() => {
    try { if (!output.write(WORKER_HEARTBEAT)) error(); } catch { error(); }
  }, WORKER_HEARTBEAT_MS);
  return dispose;
}

// A separate process preserves the native subscription client's one-call guard.
// The pipe lease also cancels inference if the coordinator dies without cleanup.
export async function captureLocalDocumentWorker(control: unknown, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./district-extract.ts', import.meta.url)), 'local-worker'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const result = Promise.withResolvers<string>(), chunks: Buffer[] = [];
  let bytes = 0, failure: unknown, killTimer: NodeJS.Timeout | undefined;
  const stop = (error: unknown) => {
    if (failure) return;
    failure = error; child.stdin.destroy(); child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000); killTimer.unref();
  };
  const abort = () => stop(signal.reason ?? Error('Local document worker cancelled'));
  const unavailable = () => stop(Object.assign(Error('Local document worker unavailable'), { failureCategory: 'transport' }));
  child.on('error', unavailable); child.stdin.on('error', unavailable);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > WORKER_CONTROL_BYTES) stop(Error('Local document worker receipt exceeds bound'));
    else if (!failure) chunks.push(chunk);
  });
  child.stderr.resume(); // Never forward private provider/source diagnostics.
  child.once('close', code => {
    if (failure) result.reject(failure);
    else if (code !== 0) result.reject(Error('Local document worker failed'));
    else result.resolve(Buffer.concat(chunks).toString('utf8'));
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => stop(Error('Local document worker timed out')), 3_600_000);
  let stopHeartbeat: (() => void) | undefined;
  try {
    try { stopHeartbeat = startWorkerHeartbeat(child.stdin, control, unavailable); }
    catch (error) { stop(error); }
    return await result.promise;
  } finally {
    clearTimeout(timer); clearTimeout(killTimer); stopHeartbeat?.();
    signal.removeEventListener('abort', abort);
  }
}
