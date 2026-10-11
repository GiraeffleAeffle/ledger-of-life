import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {publishDataRelease,verifyDataRelease,readReleaseFile} from '../src/data-release.ts';

const paths=['catalogue.json','quality-report.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json','regions/brandenburg-mol/topics.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json','knowledge/graph.json','knowledge/changes.json','knowledge/publication-inputs.json','knowledge/assessment-admissions.json'];
const quality={publishedRecords:0,quarantinedRecords:0,cities:1},at='2026-10-10T12:00:00.000Z';

test('structured publication dependencies and pinned graph clock are manifest members, not sidecars',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-structured-release-'));
 try{
  // Integrity-only synthetic bytes, not a factual release or valid graph fixture.
  for(const path of paths){await mkdir(dirname(join(directory,path)),{recursive:true});await writeFile(join(directory,path),JSON.stringify({fixture:path}));}
  const original=await publishDataRelease(directory,paths,quality,at);
  assert.equal((await verifyDataRelease(directory)).id,original.id);
  const dependencyBytes=await readReleaseFile(directory,original,'knowledge/publication-inputs.json');
  await writeFile(join(directory,'knowledge/publication-inputs.json'),JSON.stringify({fixture:'different authentic predecessor inputs'}));
  await assert.rejects(verifyDataRelease(directory),/Release file mismatch/);
  const predecessorChanged=await publishDataRelease(directory,paths,quality,at);
  assert.notEqual(predecessorChanged.id,original.id);
  await writeFile(join(directory,'knowledge/publication-inputs.json'),dependencyBytes);
  const replayed=await publishDataRelease(directory,[...paths].reverse(),quality,at);
  assert.equal(replayed.id,original.id);
  await writeFile(join(directory,'knowledge/graph.json'),JSON.stringify({fixture:'different pinned graph asOf'}));
  const timeChanged=await publishDataRelease(directory,paths,quality,at);
  assert.notEqual(timeChanged.id,original.id);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('live release verification rejects an unbound publication dependency artifact',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-unbound-publication-'));
 try{
  for(const path of paths){await mkdir(dirname(join(directory,path)),{recursive:true});await writeFile(join(directory,path),JSON.stringify({fixture:path}));}
  await publishDataRelease(directory,paths.filter(path=>path!=='knowledge/publication-inputs.json'),quality,at);
  await assert.rejects(verifyDataRelease(directory),/required file.*publication-inputs/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('live release verification requires manifest-bound critical admissions',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-unbound-assessment-'));
 try{
  for(const path of paths){await mkdir(dirname(join(directory,path)),{recursive:true});await writeFile(join(directory,path),JSON.stringify({fixture:path}));}
  await publishDataRelease(directory,paths.filter(path=>path!=='knowledge/assessment-admissions.json'),quality,at);
  await assert.rejects(verifyDataRelease(directory),/required file.*assessment-admissions/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
