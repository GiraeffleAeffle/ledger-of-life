import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,lstat,mkdir,writeFile,symlink,rm,readdir,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DistrictCas} from '../src/district-cas.ts';
import {digest} from '../src/district-adapter-contract.ts';

test('CAS writes exact byte hashes atomically with private directory/file modes and no public path metadata',async t=>{
  const root=await mkdtemp(join(tmpdir(),'district-cas-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const cas=new DistrictCas(join(root,'private','cas')),bytes=Buffer.from([0,255,1,13,10,0]);
  const artifact=await cas.put(bytes,{kind:'derived',mimeType:'application/octet-stream'});
  assert.equal(artifact.sha256,digest(bytes));assert.equal(artifact.byteLength,bytes.length);
  assert.equal(artifact.storageKey,'sha256/'+artifact.sha256.slice(0,2)+'/'+artifact.sha256);
  assert.deepEqual(await cas.read(artifact.sha256),bytes);
  const object=join(cas.root,artifact.storageKey);
  assert.equal((await lstat(object)).mode&0o777,0o600);assert.equal((await lstat(cas.root)).mode&0o777,0o700);
  assert.equal((await lstat(join(cas.root,'sha256',artifact.sha256.slice(0,2)))).mode&0o777,0o700);
  assert.deepEqual(await readdir(join(cas.root,'sha256',artifact.sha256.slice(0,2))),[artifact.sha256]);
  assert.deepEqual(await cas.put(bytes,{kind:'derived',mimeType:'application/octet-stream'}),artifact);
  assert.doesNotMatch(JSON.stringify(artifact),new RegExp(root));
  assert.deepEqual(await readFile(object),bytes);
});

test('original admission binds current exact bytes and remains required on a CAS hit',async t=>{
  const root=await mkdtemp(join(tmpdir(),'district-cas-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const cas=new DistrictCas(join(root,'cas')),bytes=Buffer.from('Synthetic source original');
  const admission={state:'allowed' as const,sourceSha256:digest(bytes),policyProofSha256:digest('policy'),checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
  await assert.rejects(cas.put(bytes,{kind:'source_original',mimeType:'text/plain'}),/admission/);
  await assert.rejects(cas.put(bytes,{kind:'source_original',mimeType:'text/plain',admission:{...admission,sourceSha256:digest('different')}}),/admission/);
  const artifact=await cas.put(bytes,{kind:'source_original',mimeType:'text/plain',admission});
  assert.equal(artifact.sha256,digest(bytes));
  await assert.rejects(cas.put(bytes,{kind:'source_original',mimeType:'text/plain',admission:{...admission,expiresAt:new Date(Date.now()-1).toISOString()}}),/admission/);
  await assert.rejects(cas.put(bytes,{kind:'source_original',mimeType:'text/plain',admission:{...admission,checkedAt:new Date(Date.now()+10000).toISOString()}}),/admission/);
});

test('public locations, symlink escapes, permissive objects, corrupt bytes and oversized inputs fail closed',async t=>{
  const root=await mkdtemp(join(tmpdir(),'district-cas-'));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.throws(()=>new DistrictCas(join(root,'out','cas')),/public/);
  assert.throws(()=>new DistrictCas(join(root,'published','cas'),{publicRoots:[join(root,'published')]}),/public/);
  await mkdir(join(root,'out'),{mode:0o700});await symlink(join(root,'out'),join(root,'alias'));
  const aliased=new DistrictCas(join(root,'alias','cas'));
  await assert.rejects(aliased.put(Buffer.from('x'),{kind:'derived',mimeType:'text/plain'}),/public/);
  const cas=new DistrictCas(join(root,'cas'),{maxBytes:16});
  await assert.rejects(cas.put(Buffer.alloc(17),{kind:'derived',mimeType:'application/octet-stream'}),/bound/);
  const artifact=await cas.put(Buffer.from('private'),{kind:'derived',mimeType:'text/plain'}),path=join(cas.root,artifact.storageKey);
  await chmod(path,0o644);await assert.rejects(cas.read(artifact.sha256),/permissions/);await chmod(path,0o600);
  await writeFile(path,'corrupt',{mode:0o600});await assert.rejects(cas.read(artifact.sha256),/binding/);
  await assert.rejects(cas.put(Buffer.from('private'),{kind:'derived',mimeType:'text/plain'}),/binding/);
  await rm(path);await symlink(join(root,'unrelated'),path);await assert.rejects(cas.read(artifact.sha256));
  await assert.rejects(cas.read('../escape'));
});

test('orphaned interrupted temporary writes never satisfy a canonical object reference',async t=>{
  const root=await mkdtemp(join(tmpdir(),'district-cas-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const cas=new DistrictCas(join(root,'cas')),bytes=Buffer.from('complete object'),hash=digest(bytes);
  await assert.rejects(cas.read(hash));
  const shard=join(cas.root,'sha256',hash.slice(0,2));await writeFile(join(shard,'.interrupted.tmp'),bytes.subarray(0,2),{mode:0o600});
  await assert.rejects(cas.read(hash));
  const artifact=await cas.put(bytes,{kind:'derived',mimeType:'text/plain'});
  assert.deepEqual(await cas.read(artifact.sha256),bytes);
});
test('CAS rejects a FIFO before reading, without blocking for a writer', {timeout:2000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'district-cas-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const cas=new DistrictCas(join(root,'cas')),hash=digest('fifo-object');
  await assert.rejects(cas.read(hash));
  const path=join(cas.root,'sha256',hash.slice(0,2),hash);
  await promisify(execFile)('mkfifo',['-m','600',path],{env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'}});
  await assert.rejects(cas.read(hash),/CAS object.*rejected/);
});
