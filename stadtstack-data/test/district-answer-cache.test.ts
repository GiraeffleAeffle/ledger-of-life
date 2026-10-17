import test from 'node:test';
import type {TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import fsPromises, { mkdir, readFile, writeFile, readdir, rm, stat, symlink, unlink } from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { cachedModelAnswer, modelAnswerCacheBinding } from '../src/district-answer-cache.ts';
import type { CachedAnswer } from '../src/district-answer-cache.ts';
import { sha256 } from '../src/district-schema.ts';
import {recordHostOptOut,initializeManagedAcquisitionLane,withManagedSourceWrite,CivicPolicyStateError} from '../src/civic-opt-out.ts';
import {prepareDocument,preparedSourceBindings,preparedCacheContext,type PreparedSourceReference,type PreparedCacheContext} from '../src/district-prepared-document.ts';
import {extractionCacheKey} from '../src/district-claims.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';

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

async function cacheFixture(t:TestContext,initialize=true) {
  const fixture=await createCivicPolicyTestContext(t),root=fixture.managedRoot;
  const bytes=Buffer.from('Synthetic cache source; no civic facts or provider execution.');
  const reference:PreparedSourceReference={id:'synthetic-source',url:'https://stadt.de/source',sha256:sha256(bytes),retrievedAt:'2026-10-11T12:00:00.000Z',locator:'synthetic fixture',mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://stadt.de/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
  const prepared=await prepareDocument({bytes,municipalityId:'strausberg',references:[reference],mimeType:'text/plain',extractorSha256:sha256('synthetic cache extractor'),toolVersions:{node:process.versions.node}},async()=>{throw Error('Synthetic text must not launch a parser');});
  const sourceContext={decisionId:fixture.decisionId,references:prepared.references,receiptSha256:prepared.receiptSha256,policy:fixture.policy};
  const options={cacheRoot:root,binding,modelIdentitySha256,sourceContext};
  if(initialize)await initializeManagedAcquisitionLane(root,{decisionId:fixture.decisionId,kind:'artifacts',...fixture.policy});
  const enroll=async(bytes:string)=>{
    const relativePath=binding+'.answer.json';
    await withManagedSourceWrite(root,preparedSourceBindings(sourceContext.references,sourceContext.receiptSha256).map(binding=>({...binding,relativePath,contentSha256:sha256(bytes)})),()=>writeFile(join(root,relativePath),bytes,{mode:0o600}),fixture.policy);
  };
  return {root,baseRoot:fixture.root,policy:fixture.policy,sourceContext,options,enroll};
}
test('current answer and record keys bind exact prepared receipt and canonical source inventory',async t=>{
 const fixture=await cacheFixture(t),first=fixture.sourceContext.references[0],second={...first,id:'synthetic-copy',url:'https://example.org/copy'};
 const context=preparedCacheContext(fixture.sourceContext.receiptSha256,[first,second]);
 assert.deepEqual(preparedCacheContext(fixture.sourceContext.receiptSha256,[second,first,first]),context);
 const request={provider:'openai-subscription' as const,modelIdentitySha256,system:'Synthetic cache-key contract',input:{source:{text:'identical synthetic body'}},schema:{type:'object'}};
 const answerKey=(sourceContext:PreparedCacheContext)=>modelAnswerCacheBinding({...request,sourceContext});
 const recordKey=(sourceContext:PreparedCacheContext)=>extractionCacheKey({provider:request.provider,modelIdentitySha256,documentHash:first.sha256,textHash:sha256('identical synthetic body'),extractorHash:sha256('synthetic extractor'),chunk:{index:0,start:0,end:24},municipalityId:'synthetic-town',sourceBinding:JSON.stringify({municipality:{id:'synthetic-town'},sourceContext})});
 assert.equal(answerKey(context),answerKey(preparedCacheContext(fixture.sourceContext.receiptSha256,[second,first])));
 assert.equal(recordKey(context),recordKey(preparedCacheContext(fixture.sourceContext.receiptSha256,[second,first])));
 const changed=[preparedCacheContext(sha256('another actual prepared receipt'),[first,second]),...([{id:'different-source'},{url:'https://another.example.org/source'},{sha256:sha256('different source bytes')}] as const).map(change=>preparedCacheContext(fixture.sourceContext.receiptSha256,[{...first,...change},second]))];
 for(const different of changed){assert.notEqual(answerKey(context),answerKey(different));assert.notEqual(recordKey(context),recordKey(different));}
});
test('a cache hit cannot relabel original prepared provenance even when a caller reuses its key',async t=>{
 const fixture=await cacheFixture(t),path=join(fixture.root,binding+'.answer.json');
 await cachedModelAnswer(fixture.options,async()=>answer());
 const original=await readFile(path);let generated=0;
 const foreign={...fixture.options,sourceContext:{...fixture.sourceContext,receiptSha256:sha256('different prepared proof')}};
 await assert.rejects(cachedModelAnswer(foreign,async()=>{generated++;return answer();}),CivicPolicyStateError);
 assert.equal(generated,0);assert.deepEqual(await readFile(path),original);
 const retained=await cachedModelAnswer(fixture.options,async()=>{generated++;return answer();});
 assert.equal(retained.responseSha256,answer().responseSha256);assert.equal(generated,0);
});
async function cacheFiles(root:string){
  const files=await readdir(root);
  assert.ok(files.includes('.civic-acquisition-lane.json'));
  if(files.includes('scratch'))assert.deepEqual(await readdir(join(root,'scratch')),[],'all source-bound scratch leases must be cleaned');
  return files.filter(file=>file!=='.civic-acquisition-lane.json'&&file!=='scratch');
}

test('existing envelopes reuse exact original metadata and bytes without generation', async t => {
  const {root,options,enroll}=await cacheFixture(t);
  try {
    const path = join(root, binding + '.answer.json'), bytes = envelope(answer());
    await enroll(bytes);
    const result = await cachedModelAnswer(options, async () => { assert.fail('must reuse genuine cached response'); });
    assert.deepEqual(result, answer());
    assert.equal(result.receivedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(result.responseSha256, sha256('synthetic native response bytes'));
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.deepEqual(await cacheFiles(root), [binding + '.answer.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('four processes sharing one binding generate once and readers only see complete JSON', { timeout: 15_000 }, async t => {
  const {root,baseRoot,sourceContext}=await cacheFixture(t);
  const helper = new URL('../src/district-answer-cache.ts', import.meta.url).href;
  const code = `
    import { appendFile } from 'node:fs/promises';
    import { once } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    import { cachedModelAnswer } from ${JSON.stringify(helper)};
    const [root, binding, modelIdentitySha256, responseSha256, sourceContextJson, callsPath] = process.argv.slice(1);
    const sourceContext=JSON.parse(sourceContextJson);
    const go = once(process.stdin, 'data');
    process.stdout.write('ready\\n');
    await go;
    const result = await cachedModelAnswer({ cacheRoot: root, binding, modelIdentitySha256, sourceContext }, async () => {
      await appendFile(callsPath, process.pid + '\\n', { mode: 0o600 });
      await delay(100);
      return { binding, modelIdentitySha256, receivedAt: '2026-10-01T00:00:00.000Z', value: { producer: process.pid, text: 'x'.repeat(40_000) }, responseSha256, returnedModel: null, runtimeWarnings: [] };
    });
    await delay(100); // Keep publication observable while the parent reader is active.
    process.stdout.write(JSON.stringify(result) + '\\n');
  `;
  const workers = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, root, binding, modelIdentitySha256, sha256('synthetic process response'), JSON.stringify(sourceContext), join(baseRoot,'calls')], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: baseRoot } });
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
    assert.equal((await readFile(join(baseRoot, 'calls'), 'utf8')).trim().split('\n').length, 1);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await cacheFiles(root), [binding + '.answer.json']);
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
    await Promise.allSettled(workers.map(worker => worker.result));
    await rm(root, { recursive: true, force: true });
  }
});

test('aborted waiter never releases its producer lock; owner still publishes once', async t => {
  const {root,options}=await cacheFixture(t);
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
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
  const {root,options}=await cacheFixture(t);
  try {
    const controller = new AbortController(), reason = Error('synthetic abort');
    controller.abort(reason);
    await assert.rejects(cachedModelAnswer({ ...options, signal: controller.signal }, async () => { assert.fail('pre-aborted producer must not run'); }), error => error === reason);
    const during = new AbortController(); let calls = 0;
    await assert.rejects(cachedModelAnswer({ ...options, signal: during.signal }, async () => { calls++; during.abort(reason); return answer(); }), error => error === reason);
    assert.equal(calls, 1); assert.deepEqual(await cacheFiles(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('orphan lock wait is bounded and never stolen; a failed producer is not retried', async t => {
  const {root,options}=await cacheFixture(t);
  try {
    const lockPath = join(root, binding + '.answer.lock'),lockBytes=JSON.stringify({pid:process.pid,nonce:randomUUID()})+'\n';
    await writeFile(lockPath, lockBytes, { mode: 0o600 });
    await assert.rejects(cachedModelAnswer({ ...options, waitMs: 5 }, async () => { assert.fail('orphan is not permission to retry'); }), /wait timed out/);
    assert.equal(await readFile(lockPath, 'utf8'), lockBytes);
    const observed = Promise.withResolvers<void>(), releaseObservation = Promise.withResolvers<void>();
    const originalLstat = fsPromises.lstat;
    let held = false, generationCalls = 0;
    // Observe the genuine inode metadata; hold only its delivery, never fabricate a stat or mock an admission gate.
    const observation = t.mock.method(fsPromises, 'lstat', async (...args: unknown[]) => {
      const metadata = await Reflect.apply(originalLstat, fsPromises, args);
      if (!held && String(args[0]) === lockPath) {
        held = true; observed.resolve(); await releaseObservation.promise;
      }
      return metadata;
    });
    syncBuiltinESMExports();
    try {
      const waiter = cachedModelAnswer({ ...options, waitMs: 500 }, async () => { generationCalls++; assert.fail('failed producer must not be retried'); });
      const rejected = assert.rejects(waiter, /producer ended without a completed answer/);
      void waiter.then(() => observed.reject(Error('Waiter completed without observing the producer')), error => observed.reject(error));
      await Promise.all([rejected, (async () => {
        await observed.promise;
        await unlink(lockPath); // Producer disappears after its real stat, before source/lane preflight may finish.
        releaseObservation.resolve();
      })()]);
      assert.equal(generationCalls, 0);
    } finally {
      releaseObservation.resolve(); observation.mock.restore(); syncBuiltinESMExports();
    }
    await assert.rejects(cachedModelAnswer(options, async () => { throw Error('synthetic native failure'); }), /synthetic native failure/);
    assert.deepEqual(await cacheFiles(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a valid winner appearing during production is reused verbatim, never overwritten', async t => {
  const {root,options,enroll}=await cacheFixture(t);
  try {
    const path = join(root, binding + '.answer.json'), winner = answer(), bytes = envelope(winner);
    let calls = 0;
    const result = await cachedModelAnswer(options, async () => {
      calls++; await enroll(bytes);
      return answer({ receivedAt: '2026-10-02T00:00:00.000Z', responseSha256: sha256('later synthetic response') });
    });
    assert.equal(calls, 1); assert.deepEqual(result, winner);
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.deepEqual(await cacheFiles(root), [binding + '.answer.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt or misbound caches fail closed without regeneration or mutation', async t => {
  const {root,options,enroll}=await cacheFixture(t);
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
      await enroll(bytes);
      await assert.rejects(cachedModelAnswer(options, async () => { calls++; return answer(); }));
      assert.equal(calls, 0);
      assert.equal(await readFile(path, 'utf8'), bytes);
      await absent(join(root, binding + '.answer.lock'));
    }
    await unlink(path);
    await assert.rejects(cachedModelAnswer(options, async () => {
      await enroll(corruptions[0]); return answer();
    }));
    assert.equal(await readFile(path, 'utf8'), corruptions[0]);
    assert.deepEqual(await cacheFiles(root), [binding + '.answer.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cache paths reject symlinks, directory entries and non-digest names', async t => {
  const {root,baseRoot,options}=await cacheFixture(t);
  try {
    const cache = root, target = join(baseRoot, 'target');
    await writeFile(target, envelope(answer()), { mode: 0o600 });
    const path = join(cache, binding + '.answer.json');
    let calls = 0;
    const generate = async () => { calls++; return answer(); };
    await symlink(target, path);
    await assert.rejects(cachedModelAnswer(options, generate));
    assert.equal(await readFile(target, 'utf8'), envelope(answer()));
    await unlink(path); await mkdir(path);
    await assert.rejects(cachedModelAnswer(options, generate));
    await rm(path, { recursive: true });
    const lockPath = join(cache, binding + '.answer.lock');
    await symlink(target, lockPath);
    await assert.rejects(cachedModelAnswer(options, generate));
    await unlink(lockPath);
    await symlink(cache, join(baseRoot, 'alias'));
    await assert.rejects(cachedModelAnswer({ ...options, cacheRoot: join(baseRoot, 'alias') }, generate));
    await assert.rejects(cachedModelAnswer({ ...options, binding: '../escape' }, generate));
    assert.equal(calls, 0);
    assert.equal(await readFile(target, 'utf8'), envelope(answer()));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a replaced producer lock is never released or used to authorize publication', async t => {
  const {root,options}=await cacheFixture(t);
  try {
    const lockPath = join(root, binding + '.answer.lock');
    await assert.rejects(cachedModelAnswer(options, async () => {
      await unlink(lockPath); await writeFile(lockPath, 'replacement owner\n', { mode: 0o600 }); return answer();
    }), /owner changed/);
    assert.equal(await readFile(lockPath, 'utf8'), 'replacement owner\n');
    await absent(join(root, binding + '.answer.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source-bound model answers enroll for purge and objections block hits and generation', async t => {
  const {root,policy,options}=await cacheFixture(t),cacheRoot=root;
  let calls = 0;
  try {
    assert.deepEqual(await cachedModelAnswer(options, async () => { calls++; return answer(); }), answer());
    assert.deepEqual(await cachedModelAnswer(options, async () => { assert.fail('must reuse managed answer'); }), answer());
    const objection = await recordHostOptOut({ host: 'stadt.de', reason: 'rights_holder_objection', reference: 'synthetic-answer-test' }, policy);
    assert.equal(objection.purge.status, 'purged');
    await absent(join(cacheRoot, binding + '.answer.json'));
    await assert.rejects(cachedModelAnswer(options, async () => { calls++; return answer(); }), /objection/);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source-bound answer generation refuses an incomplete legacy artifact inventory before model work', async t => {
  const {root,options}=await cacheFixture(t,false),cacheRoot=root;
  let calls = 0;
  try {
    await mkdir(cacheRoot, { mode: 0o700 }); await writeFile(join(cacheRoot, 'unbound-legacy.txt'), 'synthetic unbound raw artifact', { mode: 0o600 });
    await assert.rejects(cachedModelAnswer(options, async () => { calls++; return answer(); }));
    assert.equal(calls, 0);
    assert.equal(await readFile(join(cacheRoot, 'unbound-legacy.txt'), 'utf8'), 'synthetic unbound raw artifact');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an objection before first generation refuses native work and publishes no answer',async t=>{
  const {root,options,policy}=await cacheFixture(t);
  await recordHostOptOut({host:'stadt.de',reason:'municipality_objection',reference:'synthetic-before-generation'},policy);
  let calls=0;
  await assert.rejects(cachedModelAnswer(options,async()=>{calls++;return answer();}),/objection/);
  assert.equal(calls,0);await absent(join(root,binding+'.answer.json'));
  assert.deepEqual(await cacheFiles(root),[]);
});

test('an objection raised during generation prevents response publication',async t=>{
  const {root,options,policy}=await cacheFixture(t);
  let calls=0;
  await assert.rejects(cachedModelAnswer(options,async()=>{
    calls++;
    await recordHostOptOut({host:'stadt.de',reason:'rights_holder_objection',reference:'synthetic-during-generation'},policy);
    return answer();
  }),/objection/);
  assert.equal(calls,1);await absent(join(root,binding+'.answer.json'));await absent(join(root,binding+'.answer.lock'));
});

test('unmarked and unenrolled legacy envelopes never authorize cached response reuse',async t=>{
  for(const initialized of [false,true]){
    const {root,options}=await cacheFixture(t,initialized);
    if(!initialized)await mkdir(root,{mode:0o700});
    const path=join(root,binding+'.answer.json'),bytes=envelope(answer());
    await writeFile(path,bytes,{mode:0o600});
    let calls=0;
    await assert.rejects(cachedModelAnswer(options,async()=>{calls++;return answer();}));
    assert.equal(calls,0);assert.equal(await readFile(path,'utf8'),bytes);
    await absent(join(root,binding+'.answer.lock'));
  }
});

test('authority mismatch is rejected before an otherwise valid managed cache hit',async t=>{
  const {root,options,enroll}=await cacheFixture(t),bytes=envelope(answer());
  await enroll(bytes);
  const wrongAuthority={...options,sourceContext:{...options.sourceContext,policy:{...options.sourceContext.policy,authoritySha256:sha256('different authority marker')}}};
  let calls=0;
  await assert.rejects(cachedModelAnswer(wrongAuthority,async()=>{calls++;return answer();}));
  assert.equal(calls,0);assert.equal(await readFile(join(root,binding+'.answer.json'),'utf8'),bytes);
  await absent(join(root,binding+'.answer.lock'));
});
