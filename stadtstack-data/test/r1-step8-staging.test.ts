import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {root,cacheDir} from '../src/common.ts';
import {digest} from '../src/district-adapter-contract.ts';
import {readCommittedReleaseFile} from '../src/district-publication-predecessor.ts';
import {RetainedPublicationImportPlanSchema,retainedPublicationSources,RETAINED_PUBLICATION_ROOT} from '../src/district-retained-import.ts';
import {STEP8_PRIOR_RELEASE} from '../src/r1-step8-current-policy.ts';
import {requiredReplayStaging} from '../src/replay-pipeline.ts';
import {readFile,mkdir,lstat,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {initializeManagedAcquisitionLane,readCivicPolicyInventory,markManagedCacheInventoryComplete,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
import {assembleStep8Staging} from '../src/r1-step8-staging.ts';
import {PROVENANCE_LIMIT_BYTES,PROVENANCE_SAFETY_MARGIN_BYTES} from '../src/publication-provenance-partition.ts';

const execute=promisify(execFile);
test('offline retained-plan CLI derives every authentic 0.3.2 non-knowledge member and embedded declaration',async()=>{
 const {stdout}=await execute(fileURLToPath(new URL('../scripts/r1-step8.sh',import.meta.url)),['retained-plan',join(root,'release')],{env:{...process.env,DATABASE_URL:''},timeout:120000,maxBuffer:16*1024*1024});
 const plan=RetainedPublicationImportPlanSchema.parse(JSON.parse(stdout));
 assert.equal(plan.managedRoot,RETAINED_PUBLICATION_ROOT);assert.equal(plan.imports.length,19);
 const manifest=JSON.parse((await readCommittedReleaseFile(STEP8_PRIOR_RELEASE.gitCommit,'release-manifest.json',undefined,'release')).toString('utf8'));
 const catalogue=JSON.parse((await readCommittedReleaseFile(STEP8_PRIOR_RELEASE.gitCommit,'catalogue.json',undefined,'release')).toString('utf8'));
 assert.deepEqual(plan.imports.map(member=>member.memberPath).sort(),requiredReplayStaging(catalogue.cities.map((city:{id:string})=>city.id)).sort());
 for(const member of plan.imports){
  const body=await readCommittedReleaseFile(STEP8_PRIOR_RELEASE.gitCommit,member.memberPath,undefined,'release'),expected=manifest.files.find((entry:{path:string})=>entry.path===member.memberPath);
  assert.equal(digest(body),expected.sha256);assert.equal(body.length,expected.bytes);
  assert.deepEqual(member.declaredSources,retainedPublicationSources(JSON.parse(body.toString('utf8'))));
  assert.equal(member.manifestSha256,STEP8_PRIOR_RELEASE.manifestSha256);assert.equal(member.releaseId,STEP8_PRIOR_RELEASE.releaseId);
 }
});
test('staging rejects enrolled-root overlap before creating directory or claim debris',async t=>{
 const fixture=await createCivicPolicyTestContext(t),ancestor=join(cacheDir,'step8-overlap-fixture-'+randomUUID()),output=join(ancestor,'blocked');
 await mkdir(cacheDir,{recursive:true});
 t.after(async()=>{await rm(ancestor,{recursive:true,force:true});});
 await initializeManagedAcquisitionLane(ancestor,{...fixture.policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const before=await readCivicPolicyInventory(fixture.policy),inventoryBytes=await readFile(join(fixture.policy.stateDir!,'inventory.json'));
 assert.equal(before.roots.find(root=>root.path===ancestor)?.complete,true);
 // These controls are deliberately unreachable: overlap refusal must precede
 // even plan reads, not merely fail later when its first managed write enrolls.
 const pin={path:join(fixture.root,'unreachable.json'),sha256:'a'.repeat(64)};
 await assert.rejects(assembleStep8Staging({schemaVersion:'stadtstack-r1-step8-staging-assembly-v1',retainedPlan:pin,provenances:[pin],campaign:pin,registry:pin,managedRoot:output,policy:fixture.policy}),/overlaps enrolled managed root/);
 await assert.rejects(lstat(output),{code:'ENOENT'});
 await assert.rejects(lstat(output+'.claim'),{code:'ENOENT'});
 assert.deepEqual(await readFile(join(fixture.policy.stateDir!,'inventory.json')),inventoryBytes);
 assert.deepEqual(await readCivicPolicyInventory(fixture.policy),before);
 await markManagedCacheInventoryComplete(ancestor,fixture.policy);
 assert.equal((await readCivicPolicyInventory(fixture.policy)).roots.find(root=>root.path===ancestor)?.complete,true,'ancestor remains complete after canonical reconciliation');
});
test('real retained 0.3.2 staging executes through exact replay, passed gate and exception handoff',{skip:!process.env.DISTRICT_TEST_DATABASE_URL,timeout:3310000},async()=>{
 const {NODE_TEST_CONTEXT:_parent,...env}=process.env;
 const result=await execute(process.execPath,['--experimental-strip-types','--experimental-test-module-mocks','--test','--test-isolation=none','--test-reporter=tap',fileURLToPath(new URL('./fixtures/residual-production-topology.ts',import.meta.url))],{env:{...env,R1_TEST_STEP8_STAGING:'1',R1_TEST_DUPLICATE_CONTENT:'1'},timeout:3300000,maxBuffer:8*1024*1024}).catch((error:unknown)=>{
  if(error instanceof Error&&'stdout' in error)throw new Error(error.message+'\n'+String(error.stdout),{cause:error});throw error;
 });
 assert.match(result.stdout,/# fail 0/);
 assert.match(result.stdout,/REAL_RETAINED_STEP8_PLAN_AUDIT .*"members":19,"cities":8,"audit":"compatible","inventoryUnchanged":true,"dbUnchanged":true,"network":false,"providers":false/);
 assert.match(result.stdout,/REAL_RETAINED_STEP8_EXECUTION_HANDOFF .*"members":19,"gate":"passed","bundleAccepted":true,"tamperRejected":true,"canonicalPasses":1/);
 const size=/^REAL_RETAINED_STEP8_PROVENANCE_SIZE (.+)$/m.exec(result.stdout);assert.ok(size);
 const evidence=JSON.parse(size[1]);assert.equal(evidence.retainedMembers,19);for(const bytes of [evidence.primaryBytes,evidence.stagingBytes])assert.ok(bytes<PROVENANCE_LIMIT_BYTES-PROVENANCE_SAFETY_MARGIN_BYTES);
 console.log('REAL_RETAINED_STEP8_PROVENANCE_SIZE '+JSON.stringify(evidence));
 const phases=/^REAL_RETAINED_STEP8_PHASE_TIMINGS (.+)$/m.exec(result.stdout);assert.ok(phases);console.log('REAL_RETAINED_STEP8_PHASE_TIMINGS '+phases[1]);
 const bound=/^REAL_RETAINED_STEP8_PREPASS_BOUND (.+)$/m.exec(result.stdout);assert.ok(bound);const projected=JSON.parse(bound[1]);assert.equal(projected.pass,true);assert.ok(evidence.primaryBytes<=projected.primaryUpperBoundBytes);assert.equal(evidence.stagingBytes,projected.stagingExactBytes);console.log('REAL_RETAINED_STEP8_PREPASS_BOUND '+bound[1]);
});
