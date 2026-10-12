import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,symlink,unlink,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {signRevocations,revocationKeyId,isRecordRevoked,type RevocationPayload} from '../src/civic-revocations.ts';
import {loadGovernedRevocations,GovernedRevocationConfigError} from '../src/mcp-revocation-config.ts';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
async function fixture(projected=false){
 const base=await mkdtemp(join(tmpdir(),'mcp-revocation-config-')),root=join(base,'cohort');await mkdir(root,{mode:projected?0o755:0o700});
 const directory=projected?join(root,'..2026_10_12_00_00_00.123456789'):root;if(projected)await mkdir(directory,{mode:0o755});
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),keyId=revocationKeyId(publicKey),releaseId=hash('synthetic sealed release');
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
  await unlink(f.env.STADTSTACK_MCP_REVOCATIONS_FILE);await symlink('../outside/revocations.json',f.env.STADTSTACK_MCP_REVOCATIONS_FILE);
  await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),error=>error instanceof GovernedRevocationConfigError&&!error.message.includes(f.base));
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('writable trust files and writable governed roots fail closed',async()=>{
 const f=await fixture();
 try{
  await chmod(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE,0o660);await assert.rejects(loadGovernedRevocations(f.releaseId,f.env),GovernedRevocationConfigError);
  await chmod(f.env.STADTSTACK_MCP_REVOCATION_TRUST_FILE,0o600);await chmod(f.root,0o1777);
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
