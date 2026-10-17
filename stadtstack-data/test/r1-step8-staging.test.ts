import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {root} from '../src/common.ts';
import {digest} from '../src/district-adapter-contract.ts';
import {readCommittedReleaseFile} from '../src/district-publication-predecessor.ts';
import {RetainedPublicationImportPlanSchema,retainedPublicationSources,RETAINED_PUBLICATION_ROOT} from '../src/district-retained-import.ts';
import {STEP8_PRIOR_RELEASE} from '../src/r1-step8-current-policy.ts';
import {requiredReplayStaging} from '../src/replay-pipeline.ts';

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
test('real retained 0.3.2 members collect and assemble through offline Step8 plan and read-only audit',{skip:!process.env.DISTRICT_TEST_DATABASE_URL,timeout:910000},async()=>{
 const {NODE_TEST_CONTEXT:_parent,...env}=process.env;
 const result=await execute(process.execPath,['--experimental-strip-types','--experimental-test-module-mocks','--test','--test-reporter=tap',fileURLToPath(new URL('./fixtures/residual-production-topology.ts',import.meta.url))],{env:{...env,R1_TEST_STEP8_STAGING:'1'},timeout:900000,maxBuffer:8*1024*1024}).catch((error:unknown)=>{
  if(error instanceof Error&&'stdout' in error)throw new Error(error.message+'\n'+String(error.stdout),{cause:error});throw error;
 });
 assert.match(result.stdout,/# fail 0/);
 assert.match(result.stdout,/REAL_RETAINED_STEP8_PLAN_AUDIT .*"members":19,"cities":8,"audit":"compatible","inventoryUnchanged":true,"dbUnchanged":true,"network":false,"providers":false/);
});
