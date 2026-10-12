import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,createPublicKey} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,symlink,unlink,rm,chmod,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {signRevocations,revocationKeyId,isRecordRevoked,type RevocationPayload} from '../src/civic-revocations.ts';
import {loadGovernedRevocations as loadProductionRevocations,loadGovernedRevocationsForTesting,requireGovernedRevocationSignerPins,GOVERNED_REVOCATION_SIGNER_PINS,GovernedRevocationConfigError} from '../src/mcp-revocation-config.ts';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const {publicKey,privateKey}=generateKeyPairSync('ed25519'),keyId=revocationKeyId(publicKey);
const syntheticPins=[{keyId,publicKeySpki:publicKey.export({format:'der',type:'spki'}).toString('base64')}];
const loadGovernedRevocations=(releaseId:string,env:NodeJS.ProcessEnv,mountInfoSource?:()=>Promise<string>)=>loadGovernedRevocationsForTesting(releaseId,env,syntheticPins,mountInfoSource);
async function fixture(projected=false){
 const base=await mkdtemp(join(tmpdir(),'mcp-revocation-config-')),root=join(base,'cohort');await mkdir(root,{mode:projected?0o755:0o700});if(projected)await chmod(root,0o3777);
 const directory=projected?join(root,'..2026_10_12_00_00_00.123456789'):root;if(projected){await mkdir(directory,{mode:0o755});await chmod(directory,0o2755);}
 const releaseId=hash('synthetic sealed release');
 const payload:RevocationPayload={schemaVersion:'stadtstack-revocations-v1',releaseId,issuedAt:'2026-10-11T00:00:00Z',sequence:1,targets:[{type:'record',recordId:'knowledge:synthetic'}]};
 const bytes=signRevocations(payload,keyId,privateKey),trust={schemaVersion:'stadtstack-revocation-trust-v1',releaseId,expectedArtifactSha256:hash(bytes),keys:[{keyId,publicKeySpki:publicKey.export({format:'der',type:'spki'}).toString('base64')}]};
 await writeFile(join(directory,'trust.json'),JSON.stringify(trust)+'\n',{mode:projected?0o444:0o600});await writeFile(join(directory,'revocations.json'),bytes,{mode:projected?0o444:0o600});
 if(projected){await symlink('..2026_10_12_00_00_00.123456789',join(root,'..data'),'dir');await symlink('..data/trust.json',join(root,'trust.json'));await symlink('..data/revocations.json',join(root,'revocations.json'));}
 const env={STADTSTACK_MCP_REVOCATION_TRUST_FILE:join(root,'trust.json'),STADTSTACK_MCP_REVOCATIONS_FILE:join(root,'revocations.json')};
 return {base,root,directory,env,bytes,trust,releaseId};
}
for(const projected of [false,true])test(`governed startup authenticates one ${projected?'projected':'regular'} config cohort into memory`,async()=>{
 const f=await fixture(projected);
 try{
  const state=await loadGovernedRevocations(f.releaseId,f.env);
  assert.equal(state.artifactSha256,hash(f.bytes));assert.equal(state.releaseId,f.releaseId);assert.equal(state.sequence,1);
  await rm(f.root,{recursive:true,force:true});
  assert.equal(isRecordRevoked(state,{recordId:'knowledge:synthetic',sources:[]}),true);
  assert.equal(isRecordRevoked(state,{recordId:'knowledge:other',sources:[]}),false);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('missing, relative or separate configuration paths never become an empty mask',async()=>{
 await assert.rejects(loadGovernedRevocations(hash('release'),{}),GovernedRevocationConfigError);
 await assert.rejects(loadGovernedRevocations(hash('release'),{STADTSTACK_MCP_REVOCATION_TRUST_FILE:'trust.json',STADTSTACK_MCP_REVOCATIONS_FILE:'revocations.json'}),GovernedRevocationConfigError);
 const f=await fixture();try{await assert.rejects(loadGovernedRevocations(f.releaseId,{...f.env,STADTSTACK_MCP_REVOCATIONS_FILE:join(f.base,'other','revocations.json')}),GovernedRevocationConfigError);}finally{await rm(f.base,{recursive:true,force:true});}
});
test('mixed projected revisions reject even when both contain matching signed bytes',async()=>{
 const f=await fixture(true);
 try{
  const other=join(f.root,'..revision-b');await mkdir(other,{mode:0o700});await writeFile(join(other,'revocations.json'),f.bytes,{mode:0o600});
  await unlink(f.env.STADTSTACK_MCP_REVOCATIONS_FILE);await symlink('..revision-b/revocations.json',f.env.STADTSTACK_MCP_REVOCATIONS_FILE);
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('projected configuration cannot escape its governed cohort root',async()=>{
 const f=await fixture(true);
 try{
  const outside=join(f.base,'outside');await mkdir(outside,{mode:0o700});await writeFile(join(outside,'revocations.json'),f.bytes,{mode:0o600});
  await unlink(f.env.STADTSTACK_MCP_REVOCATIONS_FILE);await symlink(join(outside,'revocations.json'),f.env.STADTSTACK_MCP_REVOCATIONS_FILE);
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),error=>error instanceof GovernedRevocationConfigError&&!error.message.includes(f.base));
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('writable trust files and non-sticky writable governed roots fail closed',async()=>{
 const f=await fixture();
 try{
  await chmod(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE,0o660);await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
  await chmod(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE,0o600);await chmod(f.root,0o777);
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('projected revision directories and files remain strictly protected',async()=>{
 const f=await fixture(true);
 try{
  await chmod(f.directory,0o2775);await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
  await chmod(f.directory,0o2755);await chmod(join(f.directory,'trust.json'),0o464);
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('sticky writable projected root with kubelet mode 01777 is accepted',async()=>{
 const f=await fixture(true);
 try{
  await chmod(f.root,0o1777);
  const state=await loadGovernedRevocations(f.releaseId,f.env);
  assert.equal(state.artifactSha256,hash(f.bytes));assert.equal(state.releaseId,f.releaseId);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('non-sticky writable projected root requires an exact read-only mountinfo entry',async()=>{
 const f=await fixture(true);
 try{
  const entry=(mountPoint:string,options:string,superOptions='rw')=>`42 1 0:1 / ${mountPoint.replace(/\\/g,'\\134').replace(/ /g,'\\040')} ${options} - tmpfs tmpfs ${superOptions}\n`;
  const spacedRoot=join(f.base,'cohort with space');await rename(f.root,spacedRoot);f.root=spacedRoot;
  f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE=join(spacedRoot,'trust.json');f.env.STADTSTACK_MCP_REVOCATIONS_FILE=join(spacedRoot,'revocations.json');
  await chmod(f.root,0o2777);
  const load=(source:()=>Promise<string>)=>loadGovernedRevocations(f.releaseId,f.env,source);
  const state=await load(async()=>entry(f.root,'ro,relatime'));
  assert.equal(state.artifactSha256,hash(f.bytes));assert.equal(state.releaseId,f.releaseId);
  await assert.rejects(load(async()=>entry(f.root,'ro')+entry(f.root,'rw')),GovernedRevocationConfigError);
  const lastReadOnly=await load(async()=>entry(f.root,'rw')+entry(f.root,'ro'));
  assert.equal(lastReadOnly.releaseId,f.releaseId);
  await assert.rejects(load(async()=>entry(f.root,'rw','ro')),GovernedRevocationConfigError);
  await assert.rejects(load(async()=>entry(f.root,'rw,relatime')),GovernedRevocationConfigError);
  await assert.rejects(load(async()=>entry(join(f.base,'other'),'ro,relatime')),GovernedRevocationConfigError);
  await assert.rejects(load(async()=>{throw new Error('mountinfo unavailable');}),GovernedRevocationConfigError);
  await assert.rejects(load(async()=> 'not mountinfo\n'),GovernedRevocationConfigError);
 }finally{await rm(f.base,{recursive:true,force:true});}
});

test('projected configuration rejects symlink chains longer than four hops',async()=>{
 const f=await fixture(true);
 try{
  await unlink(join(f.root,'..data'));await symlink('..hop1',join(f.root,'..data'));
  for(let hop=1;hop<5;hop++)await symlink(`..hop${hop+1}`,join(f.root,`..hop${hop}`));
  await symlink('..2026_10_12_00_00_00.123456789',join(f.root,'..hop5'));
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('wrong release, artifact mutation, noncanonical envelope and invalid trust prevent startup',async()=>{
 const f=await fixture();
 try{
  await assert.rejects(loadGovernedRevocations(hash('another release'),f.env),GovernedRevocationConfigError);
  const appended=Buffer.concat([f.bytes,Buffer.from('\n')]);await writeFile(f.env.STADTSTACK_MCP_REVOCATIONS_FILE,appended);
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
  await writeFile(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE,JSON.stringify({...f.trust,expectedArtifactSha256:hash(appended)}));
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
  await writeFile(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE,'not a trust document');
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('oversized and nonregular configuration files are rejected without fallback',async()=>{
 const f=await fixture();
 try{
  await writeFile(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE,Buffer.alloc(64*1024+1,0x20));
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
  await unlink(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE);await mkdir(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE,{mode:0o700});
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
 }finally{await rm(f.base,{recursive:true,force:true});}
});

test('reviewed public SPKIs identify both pinned production signers',()=>{
 for(const pin of GOVERNED_REVOCATION_SIGNER_PINS)assert.equal(revocationKeyId(createPublicKey({key:Buffer.from(pin.publicKeySpki,'base64'),format:'der',type:'spki'})),pin.keyId);
});
test('production signer pin check accepts only the exact pair in either order',async()=>{
 const f=await fixture();
 try{
  for(const keys of [GOVERNED_REVOCATION_SIGNER_PINS,[...GOVERNED_REVOCATION_SIGNER_PINS].reverse()]){
   const trust={...f.trust,keys};
   assert.deepEqual(requireGovernedRevocationSignerPins(trust),trust);
   await writeFile(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE,JSON.stringify(trust));
   // Correct pins pass the independent check, but cannot authorize this synthetic signature.
   await assert.rejects(loadProductionRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
  }
 }finally{await rm(f.base,{recursive:true,force:true});}
});
for(const variant of ['missing pin','extra key','substituted key','swapped SPKI'] as const)test(`production startup rejects ${variant}`,async()=>{
 const f=await fixture();
 try{
  const [mac,vm]=GOVERNED_REVOCATION_SIGNER_PINS;
  const keys=variant==='missing pin'?[mac]:variant==='extra key'?[mac,vm,...syntheticPins]:variant==='substituted key'?[mac,...syntheticPins]:[{...mac,publicKeySpki:vm.publicKeySpki},{...vm,publicKeySpki:mac.publicKeySpki}];
  const trust={...f.trust,keys};
  assert.throws(()=>requireGovernedRevocationSignerPins(trust));
  await writeFile(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE,JSON.stringify(trust));
  await assert.rejects(loadProductionRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('production startup cannot select a synthetic signer cohort through environment',async()=>{
 const f=await fixture();
 try{
  await assert.rejects(loadProductionRevocations(f.releaseId,{...f.env,NODE_ENV:'test',STADTSTACK_MCP_REVOCATION_SIGNER_PINS:JSON.stringify(syntheticPins)}),GovernedRevocationConfigError);
  assert.equal((await loadGovernedRevocations(f.releaseId,f.env)).keyId,keyId);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
