import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {dataReleaseId} from '../src/data-release.ts';
import {promisify} from 'node:util';
import {hash} from '../src/common.ts';

// Synthetic committed bytes only; the mocked Git reader never executes a process.
test('predecessor authenticates its actual knowledge change member without inventing absent history',async t=>{
 const commit='a'.repeat(40),at='2026-10-10T12:00:00.000Z',target='2026-10-11T12:00:00.000Z',quality=Buffer.from('{"cities":[{"cityId":"castrop-rauxel","retainedQuarantines":[{"id":"council:meeting-1","reason":"end_before_start"}]}]}\n'),changes=Buffer.from('{"synthetic":"authentic-change-history"}\n');
 let members=new Map<string,Buffer>(),paths:string[]=[];
 const manifest=(withChanges:boolean)=>{
  const files=[...members].filter(([path])=>withChanges||path!=='knowledge/changes.json').map(([path,bytes])=>({path,sha256:hash(bytes),bytes:bytes.length}));
  return Buffer.from(JSON.stringify({schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt:at,files,quality:{publishedRecords:1,quarantinedRecords:0,cities:1}})+'\n');
 };
 let manifestBytes=manifest(true);
 const originalExecFile=childProcess.execFile;
 const spy=(...args:unknown[])=>{
  const commandArgs=args[1] as string[],callback=args.at(-1) as (error:Error|null,stdout:Buffer,stderr:Buffer)=>void;
  assert.equal(args[0],'git');
  const path=commandArgs[2].split(':./out/')[1],bytes=path==='release-manifest.json'?manifestBytes:members.get(path);
  callback(bytes?null:Error('Synthetic missing committed object'),bytes??Buffer.alloc(0),Buffer.alloc(0));
  return new childProcess.ChildProcess();
 };
 childProcess.execFile=spy as typeof childProcess.execFile;
 syncBuiltinESMExports();t.after(()=>{childProcess.execFile=originalExecFile;syncBuiltinESMExports();});
 Object.defineProperty(spy,promisify.custom,{value:(...args:unknown[])=>{
  const {promise,resolve,reject}=Promise.withResolvers<{stdout:Buffer;stderr:Buffer}>();
  Reflect.apply(spy,childProcess,[...args,(error:Error|null,stdout:Buffer,stderr:Buffer)=>error?reject(error):resolve({stdout,stderr})]);
  return promise;
 }});
 // This intentionally exercises module initialization: a static import would
 // capture the real promisified Git reader before the process mock is installed.
 const module=await import(new URL('../src/district-publication-predecessor.ts?synthetic-predecessor-test',import.meta.url).href) as typeof import('../src/district-publication-predecessor.ts');
 paths=module.publicationPredecessorPaths(['castrop-rauxel']);
 members=new Map(paths.map(path=>[path,path==='quality-report.json'?quality:Buffer.from(`{"synthetic":"${path}"}\n`)]));
 manifestBytes=manifest(true);
 const prior=()=>({gitCommit:commit,manifestSha256:hash(manifestBytes),releaseId:JSON.parse(manifestBytes.toString('utf8')).id as string});
 assert.ok(paths.includes('quality-report.json'));
 const loaded=await module.loadPriorPublicationRelease(prior(),paths,target);
 assert.deepEqual([...loaded.files.keys()],['cities/castrop-rauxel/changes.json','cities/castrop-rauxel/signals.geojson','core/handover-draft.json','core/release-manifest.json','core/strausberg-facts.json','knowledge/records.json','quality-report.json']);
 assert.deepEqual(loaded.files.get('quality-report.json'),quality);
 const cache=await module.preloadPriorPublicationReleases([{prior:prior(),paths,targetGeneratedAt:target}]);
 assert.deepEqual((await module.loadPriorPublicationRelease(prior(),paths,target,undefined,cache)).files.get('quality-report.json'),quality);
 members.set('quality-report.json',Buffer.from('tampered\n'));
 await assert.rejects(module.loadPriorPublicationRelease(prior(),paths,target),/member binding mismatch/);
 members.set('quality-report.json',quality);manifestBytes=manifest(false);
 const historical=await module.loadPriorPublicationRelease(prior(),['knowledge/records.json'],target);
 assert.deepEqual([...historical.files.keys()],['knowledge/records.json']);
 assert.equal(historical.files.has('knowledge/changes.json'),false);
 await assert.rejects(module.loadPriorPublicationRelease(prior(),['knowledge/records.json','knowledge/changes.json'],target),/baseline member missing/);
});
