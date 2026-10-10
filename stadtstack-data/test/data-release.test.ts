import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {dataReleaseId,publishDataRelease,verifyDataRelease,readReleaseFile,releasePathSchema,requireReleaseFiles} from '../src/data-release.ts';

test('whole-data identity changes beyond the unchanged three core facts',()=>{
 const files=[{path:'catalogue.json',sha256:'a'.repeat(64),bytes:10},{path:'regions/brandenburg-mol/topics.json',sha256:'b'.repeat(64),bytes:20}];
 assert.equal(dataReleaseId(files),dataReleaseId([...files].reverse()));
 assert.notEqual(dataReleaseId(files),dataReleaseId([{...files[0],sha256:'c'.repeat(64)},files[1]]));
 for(const path of ['../catalogue.json','/etc/passwd','cities/../../private.json','core/secrets.json'])assert.equal(releasePathSchema.safeParse(path).success,false);
});

test('manifest validates bytes and inventory, not merely core bundle identity',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-release-fixture-'));
 const paths=['catalogue.json','quality-report.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json','regions/brandenburg-mol/topics.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json'];
 try{
  // Explicit integrity fixtures, not civic evidence or a real publication.
  for(const path of paths){await mkdir(dirname(join(directory,path)),{recursive:true});await writeFile(join(directory,path),JSON.stringify({fixture:path}));}
  const manifest=await publishDataRelease(directory,paths,{publishedRecords:0,quarantinedRecords:0,cities:1},'2026-10-10T00:00:00.000Z');
  assert.equal((await verifyDataRelease(directory)).id,manifest.id);
  const captured=await verifyDataRelease(directory);
  assert.equal((await readReleaseFile(directory,captured,'catalogue.json')).toString('utf8'),JSON.stringify({fixture:'catalogue.json'}));
  // Simulate publication after the earlier verification, retaining identical byte length.
  await writeFile(join(directory,'catalogue.json'),JSON.stringify({fixture:'CATALOGUE.JSON'}));
  await assert.rejects(readReleaseFile(directory,captured,'catalogue.json'),/Release file mismatch/);
  assert.throws(()=>requireReleaseFiles(manifest,['cities/strausberg/signals.geojson']),/required file/);
  await writeFile(join(directory,'catalogue.json'),'changed');
  await assert.rejects(verifyDataRelease(directory),/Release file mismatch/);
  const encoded=JSON.parse(await readFile(join(directory,'release-manifest.json'),'utf8'));encoded.files.push(encoded.files[0]);encoded.id=dataReleaseId(encoded.files);
  await writeFile(join(directory,'release-manifest.json'),JSON.stringify(encoded));
  await assert.rejects(verifyDataRelease(directory),/Duplicate release file/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
