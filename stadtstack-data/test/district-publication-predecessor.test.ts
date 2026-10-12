import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {dataReleaseId} from '../src/data-release.ts';
import {promisify} from 'node:util';
import {hash} from '../src/common.ts';

// Synthetic committed bytes only; the mocked Git reader never executes a process.
test('predecessor authenticates its actual knowledge change member without inventing absent history',async t=>{
 const commit='a'.repeat(40),at='2026-10-10T12:00:00.000Z',target='2026-10-11T12:00:00.000Z';
 const records=Buffer.from('{"synthetic":"records"}\n'),changes=Buffer.from('{"synthetic":"authentic-change-history"}\n');
 const members=new Map<string,Buffer>([['knowledge/records.json',records],['knowledge/changes.json',changes]]);
 const manifest=(withChanges:boolean)=>{
  const files=[...members].filter(([path])=>withChanges||path!=='knowledge/changes.json').map(([path,bytes])=>({path,sha256:hash(bytes),bytes:bytes.length}));
  return Buffer.from(JSON.stringify({schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt:at,files,quality:{publishedRecords:1,quarantinedRecords:0,cities:1}})+'\n');
 };
 let manifestBytes=manifest(true);
 const spy=t.mock.method(childProcess,'execFile',(...args:unknown[])=>{
  const commandArgs=args[1] as string[],callback=args.at(-1) as (error:Error|null,stdout:Buffer,stderr:Buffer)=>void;
  assert.equal(args[0],'git');
  const path=commandArgs[2].split(':./out/')[1],bytes=path==='release-manifest.json'?manifestBytes:members.get(path);
  callback(bytes?null:Error('Synthetic missing committed object'),bytes??Buffer.alloc(0),Buffer.alloc(0));
  return new childProcess.ChildProcess();
 });
 syncBuiltinESMExports();t.after(()=>{spy.mock.restore();syncBuiltinESMExports();});
 Object.defineProperty(spy,promisify.custom,{value:(...args:unknown[])=>{
  const {promise,resolve,reject}=Promise.withResolvers<{stdout:Buffer;stderr:Buffer}>();
  Reflect.apply(spy,childProcess,[...args,(error:Error|null,stdout:Buffer,stderr:Buffer)=>error?reject(error):resolve({stdout,stderr})]);
  return promise;
 }});
 // This intentionally exercises module initialization: a static import would
 // capture the real promisified Git reader before the process mock is installed.
 const module=await import(new URL('../src/district-publication-predecessor.ts?synthetic-predecessor-test',import.meta.url).href) as typeof import('../src/district-publication-predecessor.ts');
 const prior=()=>({gitCommit:commit,manifestSha256:hash(manifestBytes),releaseId:JSON.parse(manifestBytes.toString('utf8')).id as string});
 const loaded=await module.loadPriorPublicationRelease(prior(),['knowledge/records.json'],target);
 assert.deepEqual([...loaded.files.keys()],['knowledge/changes.json','knowledge/records.json']);
 assert.deepEqual(loaded.files.get('knowledge/changes.json'),changes);
 assert.equal(loaded.priorRelease.members.find(member=>member.path==='knowledge/changes.json')!.sha256,hash(changes));
 const cache=await module.preloadPriorPublicationReleases([{prior:prior(),paths:['knowledge/records.json'],targetGeneratedAt:target}]);
 assert.deepEqual((await module.loadPriorPublicationRelease(prior(),['knowledge/records.json'],target,undefined,cache)).files.get('knowledge/changes.json'),changes);
 members.set('knowledge/changes.json',Buffer.from('tampered\n'));
 await assert.rejects(module.loadPriorPublicationRelease(prior(),['knowledge/records.json'],target),/member binding mismatch/);
 members.set('knowledge/changes.json',changes);manifestBytes=manifest(false);
 const historical=await module.loadPriorPublicationRelease(prior(),['knowledge/records.json'],target);
 assert.deepEqual([...historical.files.keys()],['knowledge/records.json']);
 assert.equal(historical.files.has('knowledge/changes.json'),false);
 await assert.rejects(module.loadPriorPublicationRelease(prior(),['knowledge/records.json','knowledge/changes.json'],target),/baseline member missing/);
});
