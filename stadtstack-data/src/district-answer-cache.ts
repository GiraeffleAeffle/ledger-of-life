import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { hashSchema, sha256 } from './district-schema.ts';
import { assertPreparedSourcesActive, type PreparedSourceReference } from './district-prepared-document.ts';
import { initializeManagedAcquisitionLane, recordManagedSourceContent, markManagedCacheInventoryComplete, withManagedSourceWrite } from './civic-opt-out.ts';

// This is the existing response envelope, not a request log. Its field order and
// digest intentionally remain compatible with answers from earlier extractors.
const answerBodySchema = z.object({ binding: hashSchema, modelIdentitySha256: hashSchema, receivedAt: z.iso.datetime(), value: z.unknown(), responseSha256: hashSchema, returnedModel: z.string().nullable(), runtimeWarnings: z.array(z.string()) }).strict();
const answerCacheSchema = answerBodySchema.extend({ cacheSha256: hashSchema }).strict();
export type CachedAnswer = z.infer<typeof answerBodySchema>;
type CacheOptions = { cacheRoot: string; binding: string; modelIdentitySha256: string; signal?: AbortSignal; waitMs?: number; sourceContext?: { decisionId: 'owner-2026-10-11-public-civic-sources'; references: PreparedSourceReference[]; receiptSha256: string; policyStateDir?: string } };
type FileIdentity = { dev: number; ino: number };
const WAIT_MS = 360_000; // Longer than the native call's readiness + 240-second generation deadline.
const POLL_MS = 50;

async function assertOwned(path: string, owner: FileIdentity): Promise<void> {
  const current = await lstat(path);
  if (!current.isFile() || current.dev !== owner.dev || current.ino !== owner.ino) throw Error('Source model-response cache lock/file owner changed');
}
async function removeOwned(path: string, owner: FileIdentity): Promise<void> {
  await assertOwned(path, owner);
  await unlink(path);
}
async function readAnswer(path: string, options: CacheOptions, insideManagedWrite = false): Promise<CachedAnswer | undefined> {
  options.signal?.throwIfAborted();
  if (options.sourceContext) await assertPreparedSourcesActive(options.sourceContext.references, { stateDir: options.sourceContext.policyStateDir });
  let file: FileHandle;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    if (!(await file.stat()).isFile()) throw Error('Source model-response cache file type rejected');
    const bytes = await file.readFile({ encoding: 'utf8' }), cached = answerCacheSchema.parse(JSON.parse(bytes)), { cacheSha256, ...body } = cached;
    if (body.binding !== options.binding || body.modelIdentitySha256 !== options.modelIdentitySha256 || sha256(JSON.stringify(body)) !== cacheSha256) throw Error('Source model-response cache integrity mismatch');
    options.signal?.throwIfAborted();
    if (options.sourceContext && !insideManagedWrite) {
      const context = options.sourceContext, contentSha256 = sha256(bytes);
      for (const reference of context.references) await recordManagedSourceContent(dirname(path), { relativePath: basename(path), contentSha256, sourceSha256: reference.sha256, url: reference.url, observationId: reference.id, receiptSha256: context.receiptSha256, independentAllowed: true }, { stateDir: context.policyStateDir });
      await markManagedCacheInventoryComplete(dirname(path), { stateDir: context.policyStateDir });
    }
    if (options.sourceContext) await assertPreparedSourcesActive(options.sourceContext.references, { stateDir: options.sourceContext.policyStateDir });
    options.signal?.throwIfAborted();
    return body;
  } finally { await file.close(); }
}
async function waitForAnswer(path: string, lockPath: string, options: CacheOptions): Promise<CachedAnswer> {
  const deadline = performance.now() + (options.waitMs ?? WAIT_MS);
  for (;;) {
    const cached = await readAnswer(path, options);
    if (cached) return cached;
    try {
      if (!(await lstat(lockPath)).isFile()) throw Error('Source model-response cache lock type rejected');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Publication precedes lock release. Never turn a failed/crashed producer
      // into an automatic second model attempt, and never steal an orphan lock.
      const completed = await readAnswer(path, options);
      if (completed) return completed;
      throw Error('Source model-response cache producer ended without a completed answer');
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw Error('Source model-response cache lock wait timed out; operator recovery required');
    try { await delay(Math.min(POLL_MS, remaining), undefined, { signal: options.signal }); }
    catch (error) { options.signal?.throwIfAborted(); throw error; }
  }
}

/** One producer per binding across processes; only complete, validated responses become visible. */
export async function cachedModelAnswer(options: CacheOptions, generate: () => Promise<CachedAnswer>): Promise<CachedAnswer> {
  options.signal?.throwIfAborted();
  hashSchema.parse(options.binding); hashSchema.parse(options.modelIdentitySha256);
  if (options.waitMs !== undefined && (!Number.isFinite(options.waitMs) || options.waitMs < 0 || options.waitMs > WAIT_MS)) throw Error('Source model-response cache wait bound invalid');
  if (options.sourceContext) {
    hashSchema.parse(options.sourceContext.receiptSha256);
    if (!options.sourceContext.references.length) throw Error('Source model-response cache requires source references');
    await assertPreparedSourcesActive(options.sourceContext.references, { stateDir: options.sourceContext.policyStateDir });
  }
  await mkdir(options.cacheRoot, { recursive: true, mode: 0o700 });
  // Refuse a symlink cache leaf, canonicalize parents (including macOS /var),
  // and create only digest-named children in this private directory.
  const directory = await open(options.cacheRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let root: string;
  try {
    root = await realpath(options.cacheRoot);
    if (options.sourceContext) await initializeManagedAcquisitionLane(root, { decisionId: options.sourceContext.decisionId, kind: 'artifacts', stateDir: options.sourceContext.policyStateDir });
    await directory.chmod(0o700);
  } finally { await directory.close(); }
  const path = join(root, options.binding + '.answer.json'), lockPath = join(root, options.binding + '.answer.lock');
  const cached = await readAnswer(path, options);
  if (cached) return cached;
  options.signal?.throwIfAborted();
  let lock: FileHandle;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return waitForAnswer(path, lockPath, options);
  }
  // Keep the descriptor open: its inode cannot be recycled before ownership is checked.
  const owner = await lock.stat();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }) + '\n');
    const winner = await readAnswer(path, options);
    if (winner) return winner;
    await assertOwned(lockPath, owner);
    options.signal?.throwIfAborted();
    if (options.sourceContext) await markManagedCacheInventoryComplete(root, { stateDir: options.sourceContext.policyStateDir });
    const body = answerBodySchema.parse(await generate());
    options.signal?.throwIfAborted();
    if (body.binding !== options.binding || body.modelIdentitySha256 !== options.modelIdentitySha256) throw Error('Source model-response cache binding mismatch');
    await assertOwned(lockPath, owner);
    const bytes = JSON.stringify({ ...body, cacheSha256: sha256(JSON.stringify(body)) }) + '\n', contentSha256 = sha256(bytes);
    const publish = async () => {
      const temporary = path + '.' + randomUUID() + '.tmp';
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const temporaryOwner = await file.stat();
      try {
        await file.writeFile(bytes); await file.sync();
        options.signal?.throwIfAborted();
        await assertOwned(lockPath, owner); await assertOwned(temporary, temporaryOwner);
        try {
          // Hard-link publication is atomic and no-replace, unlike rename. Readers
          // see either ENOENT or all bytes; an existing valid winner is never replaced.
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const published = await readAnswer(path, options, true);
          if (!published) throw Error('Source model-response cache winner disappeared');
          return published;
        }
        options.signal?.throwIfAborted();
        return body;
      } finally {
        try { await removeOwned(temporary, temporaryOwner); }
        finally { await file.close(); }
      }
    };
    if (!options.sourceContext) return await publish();
    const context = options.sourceContext, entries = context.references.map(reference => ({ relativePath: options.binding + '.answer.json', contentSha256, sourceSha256: reference.sha256, url: reference.url, observationId: reference.id, receiptSha256: context.receiptSha256, independentAllowed: true }));
    return await withManagedSourceWrite(root, entries, publish, { stateDir: context.policyStateDir });
  } finally {
    try { await removeOwned(lockPath, owner); }
    finally { await lock.close(); }
  }
}
