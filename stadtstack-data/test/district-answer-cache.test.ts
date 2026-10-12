import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { cachedModelAnswer } from '../src/district-answer-cache.ts';
import type { CachedAnswer } from '../src/district-answer-cache.ts';
import { sha256 } from '../src/district-schema.ts';
import { randomUUID } from 'node:crypto';
import { provisionCivicPolicyAuthority, initializeManagedAcquisitionLane, withManagedSourceWrite, CIVIC_ACQUISITION_DECISION_ID } from '../src/civic-opt-out.ts';
import { prepareDocument, preparedSourceBindings, type PreparedSourceReference } from '../src/district-prepared-document.ts';

type CacheSourceContext = Parameters<typeof cachedModelAnswer>[0]['sourceContext'];
async function cacheSource(t: TestContext, root: string): Promise<CacheSourceContext> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'district-answer-policy-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const stateDir = join(stateRoot, 'authority');
  const authority = await provisionCivicPolicyAuthority({ stateDir, authorityId: 'fixture:' + randomUUID() });
  const policy = { stateDir, authorityId: authority.authorityId, authoritySha256: authority.authoritySha256 };
  const bytes = Buffer.from('Synthetic cache source; no civic facts or provider execution.');
  const reference: PreparedSourceReference = { id: 'synthetic-cache-source', url: 'https://example.org/cache-fixture', sha256: sha256(bytes), retrievedAt: '2026-10-01T00:00:00.000Z', locator: 'document-sha256:' + sha256(bytes), mimeType: 'text/plain', sourceType: 'website', policy: { robots: { state: 'allowed', url: 'https://example.org/robots.txt' }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' } };
  const prepared = await prepareDocument({ bytes, municipalityId: 'strausberg', references: [reference], mimeType: 'text/plain', extractorSha256: sha256('synthetic cache extractor'), toolVersions: { node: process.versions.node } }, async () => { throw Error('Synthetic text must not launch a parser'); });
  await initializeManagedAcquisitionLane(root, { ...policy, decisionId: CIVIC_ACQUISITION_DECISION_ID, kind: 'artifacts' });
  return { decisionId: CIVIC_ACQUISITION_DECISION_ID, references: prepared.references, receiptSha256: prepared.receiptSha256, policy };
}
async function writeCache(path: string, bytes: string, context: CacheSourceContext): Promise<void> {
  await withManagedSourceWrite(dirname(path), preparedSourceBindings(context.references, context.receiptSha256).map(binding => ({ ...binding, relativePath: basename(path), contentSha256: sha256(bytes), independentAllowed: false })), () => writeFile(path, bytes, { mode: 0o600 }), context.policy);
}
async function cacheFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter(name => name !== '.civic-acquisition-lane.json');
}

const binding = sha256('synthetic exact provider/model/system/input/schema binding');
const modelIdentitySha256 = sha256('synthetic model identity');
function answer(extra: Partial<CachedAnswer> = {}): CachedAnswer {
  return { binding, modelIdentitySha256, receivedAt: '2026-10-01T00:00:00.000Z', value: { record: null, reason: 'Synthetic no-case response' }, responseSha256: sha256('synthetic native response bytes'), returnedModel: null, runtimeWarnings: [], ...extra };
}
function envelope(body: CachedAnswer): string {
  return JSON.stringify({ ...body, cacheSha256: sha256(JSON.stringify(body)) }) + '\n';
}
async function absent(path: string) {
  await assert.rejects(stat(path), { code: 'ENOENT' });
}

test('existing envelopes reuse exact original metadata and bytes without generation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'district-answer-existing-'));
  const sourceContext = await cacheSource(t, root);
  try {
    const path = join(root, binding + '.answer.json'), bytes = envelope(answer());
    await writeCache(path, bytes, sourceContext);
    const result = await cachedModelAnswer({ cacheRoot: root, binding, modelIdentitySha256, sourceContext }, async () => { assert.fail('must reuse genuine cached response'); });
    assert.deepEqual(result, answer());
    assert.equal(result.receivedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(result.responseSha256, sha256('synthetic native response bytes'));
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.deepEqual(await cacheFiles(root), [binding + '.answer.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('four processes sharing one binding generate once and readers only see complete JSON', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'district-answer-processes-'));
  const sourceContext = await cacheSource(t, root);
  t.after(() => rm(root + '.calls', { force: true }));
  const helper = new URL('../src/district-answer-cache.ts', import.meta.url).href;
  const code = `
    import { appendFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { once } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    import { cachedModelAnswer } from ${JSON.stringify(helper)};
    const [root, binding, modelIdentitySha256, responseSha256, context] = process.argv.slice(1);
    const sourceContext = JSON.parse(context);
    const go = once(process.stdin, 'data');
    process.stdout.write('ready\\n');
    await go;
    const result = await cachedModelAnswer({ cacheRoot: root, binding, modelIdentitySha256, sourceContext }, async () => {
      await appendFile(root + '.calls', process.pid + '\\n', { mode: 0o600 });
      await delay(100);
      return { binding, modelIdentitySha256, receivedAt: '2026-10-01T00:00:00.000Z', value: { producer: process.pid, text: 'x'.repeat(40_000) }, responseSha256, returnedModel: null, runtimeWarnings: [] };
    });
    await delay(100); // Keep publication observable while the parent reader is active.
    process.stdout.write(JSON.stringify(result) + '\\n');
  `;
  const workers = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, root, binding, modelIdentitySha256, sha256('synthetic process response'), JSON.stringify(sourceContext)], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: root } });
    let stdout = '', stderr = '';
    const ready = Promise.withResolvers<void>(), result = Promise.withResolvers<CachedAnswer>();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; if (stdout.startsWith('ready\n')) ready.resolve(); });
    child.stderr.on('data', (text: string) => { stderr += text; });
    child.once('error', error => { ready.reject(error); result.reject(error); });
    child.once('close', status => {
      if (status !== 0) { const error = Error(`Synthetic cache child failed: ${status}: ${stderr}`); ready.reject(error); result.reject(error); return; }
      try { result.resolve(JSON.parse(stdout.slice('ready\n'.length))); }
      catch (error) { ready.reject(error); result.reject(error); }
    });
    return { child, ready: ready.promise, result: result.promise };
  });
  // Attach completion handling before waiting for startup, including failure paths.
  let completed = false, observed = 0;
  const results = Promise.all(workers.map(worker => worker.result));
  void results.then(() => { completed = true; }, () => { completed = true; });
  try {
    await Promise.all(workers.map(worker => worker.ready));
    for (const worker of workers) worker.child.stdin.end('go\n');
    const path = join(root, binding + '.answer.json');
    while (!completed) {
      let bytes: string | undefined;
      try { bytes = await readFile(path, 'utf8'); }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); }
      if (bytes !== undefined) {
        const { cacheSha256, ...body } = JSON.parse(bytes);
        assert.equal(cacheSha256, sha256(JSON.stringify(body))); observed++;
      }
      await delay(1);
    }
    const answers = await results;
    for (const result of answers) assert.deepEqual(result, answers[0]);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    const { cacheSha256, ...body } = stored;
    assert.equal(cacheSha256, sha256(JSON.stringify(body)));
    assert.deepEqual(body, answers[0]);
    assert.ok(observed > 0);
    assert.equal((await readFile(root + '.calls', 'utf8')).trim().split('\n').length, 1);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(root)).sort(), [binding + '.answer.json', 'calls'].sort());
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
    await Promise.allSettled(workers.map(worker => worker.result));
    await rm(root, { recursive: true, force: true });
  }
});

test('aborted waiter never releases its producer lock; owner still publishes once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'district-answer-abort-waiter-'));
  const sourceContext = await cacheSource(t, root);
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const options = { cacheRoot: root, binding, modelIdentitySha256, sourceContext };
  const producer = cachedModelAnswer(options, async () => { entered.resolve(); await finish.promise; return answer(); });
  try {
    await entered.promise;
    const lockPath = join(root, binding + '.answer.lock'), original = await readFile(lockPath, 'utf8');
    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
    const controller = new AbortController(), reason = Error('synthetic caller cancellation');
    const waiter = cachedModelAnswer({ ...options, signal: controller.signal }, async () => { assert.fail('waiter must not generate'); });
    const rejected = assert.rejects(waiter, error => error === reason);
    await delay(20); controller.abort(reason); await rejected;
    assert.equal(await readFile(lockPath, 'utf8'), original);
    finish.resolve(); assert.deepEqual(await producer, answer());
    await absent(lockPath);
  } finally { finish.resolve(); await producer.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test('pre-aborted and mid-generation cancellation publish nothing and release only owned state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'district-answer-abort-owner-'));
  const sourceContext = await cacheSource(t, root);
  try {
    const options = { cacheRoot: root, binding, modelIdentitySha256, sourceContext }, controller = new AbortController(), reason = Error('synthetic abort');
    controller.abort(reason);
    await assert.rejects(cachedModelAnswer({ ...options, signal: controller.signal }, async () => { assert.fail('pre-aborted producer must not run'); }), error => error === reason);
    const during = new AbortController(); let calls = 0;
    await assert.rejects(cachedModelAnswer({ ...options, signal: during.signal }, async () => { calls++; during.abort(reason); return answer(); }), error => error === reason);
    assert.equal(calls, 1); assert.deepEqual(await cacheFiles(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('orphan lock wait is bounded and never stolen; a failed producer is not retried', async t => {
  const root = await mkdtemp(join(tmpdir(), 'district-answer-orphan-'));
  const sourceContext = await cacheSource(t, root);
  try {
    const options = { cacheRoot: root, binding, modelIdentitySha256, sourceContext }, lockPath = join(root, binding + '.answer.lock');
    const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() }) + '\n';
    await writeFile(lockPath, owner, { mode: 0o600 });
    await assert.rejects(cachedModelAnswer({ ...options, waitMs: 5 }, async () => { assert.fail('orphan is not permission to retry'); }), /wait timed out/);
    assert.equal(await readFile(lockPath, 'utf8'), owner);
    const waiter = cachedModelAnswer({ ...options, waitMs: 500 }, async () => { assert.fail('failed producer must not be retried'); });
    const rejected = assert.rejects(waiter, /producer ended without a completed answer/);
    await delay(30); await unlink(lockPath); await rejected;
    await assert.rejects(cachedModelAnswer(options, async () => { throw Error('synthetic native failure'); }), /synthetic native failure/);
    assert.deepEqual(await cacheFiles(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a valid winner appearing during production is reused verbatim, never overwritten', async t => {
  const root = await mkdtemp(join(tmpdir(), 'district-answer-winner-'));
  const sourceContext = await cacheSource(t, root);
  try {
    const path = join(root, binding + '.answer.json'), winner = answer(), bytes = envelope(winner);
    let calls = 0;
    const result = await cachedModelAnswer({ cacheRoot: root, binding, modelIdentitySha256, sourceContext }, async () => {
      calls++; await writeCache(path, bytes, sourceContext);
      return answer({ receivedAt: '2026-10-02T00:00:00.000Z', responseSha256: sha256('later synthetic response') });
    });
    assert.equal(calls, 1); assert.deepEqual(result, winner);
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.deepEqual(await cacheFiles(root), [binding + '.answer.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt or misbound caches fail closed without regeneration or mutation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'district-answer-corruption-'));
  const sourceContext = await cacheSource(t, root);
  try {
    const path = join(root, binding + '.answer.json');
    const corruptions = [
      '{"binding":',
      JSON.stringify({ ...answer(), cacheSha256: sha256('wrong envelope') }),
      envelope(answer({ binding: sha256('different binding') })),
      envelope(answer({ modelIdentitySha256: sha256('different model') })),
      JSON.stringify({ ...JSON.parse(envelope(answer())), request: 'must not be accepted' }),
    ];
    let calls = 0;
    for (const bytes of corruptions) {
      await writeCache(path, bytes, sourceContext);
      await assert.rejects(cachedModelAnswer({ cacheRoot: root, binding, modelIdentitySha256, sourceContext }, async () => { calls++; return answer(); }));
      assert.equal(calls, 0);
      assert.equal(await readFile(path, 'utf8'), bytes);
      await absent(join(root, binding + '.answer.lock'));
    }
    await unlink(path);
    await assert.rejects(cachedModelAnswer({ cacheRoot: root, binding, modelIdentitySha256, sourceContext }, async () => {
      await writeCache(path, corruptions[0], sourceContext); return answer();
    }));
    assert.equal(await readFile(path, 'utf8'), corruptions[0]);
    assert.deepEqual(await cacheFiles(root), [binding + '.answer.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cache paths reject symlinks, directory entries and non-digest names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'district-answer-paths-'));
  try {
    const cache = join(root, 'cache'), target = join(root, 'target');
    await mkdir(cache, { mode: 0o700 }); await writeFile(target, envelope(answer()), { mode: 0o600 });
    const sourceContext = await cacheSource(t, cache);
    const path = join(cache, binding + '.answer.json'), options = { cacheRoot: cache, binding, modelIdentitySha256, sourceContext };
    let calls = 0;
    const generate = async () => { calls++; return answer(); };
    await symlink(target, path);
    await assert.rejects(cachedModelAnswer(options, generate));
    assert.equal(await readFile(target, 'utf8'), envelope(answer()));
    await unlink(path); await mkdir(path);
    await assert.rejects(cachedModelAnswer(options, generate), /MANAGED_INVENTORY_INCOMPLETE/);
    await rm(path, { recursive: true });
    const lockPath = join(cache, binding + '.answer.lock');
    await symlink(target, lockPath);
    await assert.rejects(cachedModelAnswer(options, generate), /MANAGED_INVENTORY_INCOMPLETE/);
    await unlink(lockPath);
    await symlink(cache, join(root, 'alias'));
    await assert.rejects(cachedModelAnswer({ ...options, cacheRoot: join(root, 'alias') }, generate));
    await assert.rejects(cachedModelAnswer({ ...options, binding: '../escape' }, generate));
    assert.equal(calls, 0);
    assert.equal(await readFile(target, 'utf8'), envelope(answer()));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a replaced producer lock is never released or used to authorize publication', async t => {
  const root = await mkdtemp(join(tmpdir(), 'district-answer-ownership-'));
  const sourceContext = await cacheSource(t, root);
  try {
    const lockPath = join(root, binding + '.answer.lock');
    await assert.rejects(cachedModelAnswer({ cacheRoot: root, binding, modelIdentitySha256, sourceContext }, async () => {
      await unlink(lockPath); await writeFile(lockPath, 'replacement owner\n', { mode: 0o600 }); return answer();
    }), /owner changed/);
    assert.equal(await readFile(lockPath, 'utf8'), 'replacement owner\n');
    await absent(join(root, binding + '.answer.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
