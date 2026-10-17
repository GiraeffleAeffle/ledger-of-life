import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {TestContext} from 'node:test';
import type {Pool} from 'pg';
import {root,cacheDir} from '../../src/common.ts';
import {writePrivateJson} from '../../src/district-private-io.ts';
import {runRetainedPublicationImportPlan} from '../../src/district-retained-import.ts';
import {readCommittedReleaseFile} from '../../src/district-publication-predecessor.ts';
import {authenticatePublicationProvenance} from '../../src/district-publication-provenance.ts';
import {STEP8_PRIOR_RELEASE} from '../../src/r1-step8-current-policy.ts';
import {buildStep8RetainedPlan,assembleStep8Staging} from '../../src/r1-step8-staging.ts';
import {Step8InputSchema,step8ReadPlan,type Step8Input} from '../../src/r1-step8.ts';
import {auditStep8} from '../../src/r1-step8-audit.ts';

/** Real immutable 0.3.2 staging bytes, isolated authority/PG and synthetic native
 * assessment evidence from the existing topology fixture; no live claims. */
export async function exerciseRealRetainedStaging(t:TestContext,manifest:Step8Input,pool:Pool,fixtureRoot:string,sourceProvenance:{path:string;sha256:string}){
 const inventoryBefore=await readFile(join(manifest.policy.stateDir,'inventory.json'));
 const plan=await buildStep8RetainedPlan(join(root,'release'),join(fixtureRoot,'real-retained-copies'));
 assert.equal(plan.imports.length,19);
 assert.deepEqual(await readFile(join(manifest.policy.stateDir,'inventory.json')),inventoryBefore,'retained-plan is read-only');
 const planPath=join(fixtureRoot,'operator-controls','retained-plan.json'),planSha256=await writePrivateJson(planPath,plan);
 const collected=await runRetainedPublicationImportPlan(plan,manifest.policy);
 assert.equal(collected.length,19);
 for(const copy of collected){
  assert.deepEqual(await readFile(copy.path),await readCommittedReleaseFile(STEP8_PRIOR_RELEASE.gitCommit,copy.publication.memberPath,undefined,'release'));
  assert.ok(copy.bindings.length);assert.ok(copy.bindings.every(binding=>binding.kind==='retained_publication'&&binding.independentAllowed===false));
 }
 const managedRoot=join(cacheDir,'step8-staging-fixture-'+randomUUID());
 t.after(async()=>{await rm(managedRoot,{recursive:true,force:true});await rm(managedRoot+'.claim',{force:true});});
 const request={schemaVersion:'stadtstack-r1-step8-staging-assembly-v1',retainedPlan:{path:planPath,sha256:planSha256},provenances:[{path:sourceProvenance.path,sha256:sourceProvenance.sha256}],campaign:manifest.campaign,registry:manifest.registry,managedRoot,policy:manifest.policy};
 const incomplete={...plan,imports:plan.imports.slice(1)},badPlanPath=join(fixtureRoot,'operator-controls','incomplete-plan.json'),badPlanSha256=await writePrivateJson(badPlanPath,incomplete);
 await assert.rejects(assembleStep8Staging({...request,retainedPlan:{path:badPlanPath,sha256:badPlanSha256}}),/complete authentic/);
 await assert.rejects(readFile(managedRoot+'.claim'),{code:'ENOENT'});
 await assert.rejects(assembleStep8Staging({...request,registry:{path:join(fixtureRoot,'unbound-registry.json'),sha256:manifest.registry.sha256}}),/lacks authenticated managed provenance/);
 await assert.rejects(readFile(managedRoot+'.claim'),{code:'ENOENT'});
 const badDeclarations={...plan,imports:plan.imports.map((entry,index)=>index===0?{...entry,declaredSources:entry.declaredSources.slice(1)}:entry)},badDeclarationsPath=join(fixtureRoot,'operator-controls','bad-declarations.json'),badDeclarationsSha256=await writePrivateJson(badDeclarationsPath,badDeclarations);
 await assert.rejects(assembleStep8Staging({...request,retainedPlan:{path:badDeclarationsPath,sha256:badDeclarationsSha256}}),/complete authentic/);
 const result=await assembleStep8Staging(request);
 assert.equal(result.importedMembers,19);
 const provenance=await authenticatePublicationProvenance(result.inputs.privateProvenance.path,result.inputs.privateProvenance.sha256,manifest.policy);
 assert.deepEqual(await provenance.read(result.inputs.campaign.path),await readFile(manifest.campaign.path));
 const actual=Step8InputSchema.parse({...manifest,...result.inputs});
 assert.deepEqual(step8ReadPlan(actual).writes,[]);
 const beforeAudit=await readFile(join(manifest.policy.stateDir,'inventory.json'));
 const counts=async()=> (await pool.query('SELECT (SELECT count(*) FROM district_pipeline.jobs) AS jobs,(SELECT count(*) FROM district_pipeline.step_receipts) AS receipts,(SELECT count(*) FROM district_pipeline.artifacts) AS artifacts')).rows;
 const beforeCounts=await counts(),audit=await auditStep8(actual,pool);
 assert.equal(audit.status,'compatible',JSON.stringify(audit.blockers));assert.deepEqual(audit.writes,[]);
 assert.deepEqual(await readFile(join(manifest.policy.stateDir,'inventory.json')),beforeAudit);
 assert.deepEqual(await counts(),beforeCounts);
 for(const staged of actual.staging)assert.deepEqual(await readFile(staged.path),await readCommittedReleaseFile(STEP8_PRIOR_RELEASE.gitCommit,staged.destination,undefined,'release'));
 assert.equal(actual.staging.filter(pin=>pin.destination.endsWith('/feed.json')).length,8);
 assert.equal(actual.staging.filter(pin=>pin.destination.endsWith('/signals.geojson')).length,8);
 await assert.rejects(assembleStep8Staging(request),/already exists/);
 assert.equal(result.valueAccepted,false);assert.equal(result.hostedReleaseAuthorized,false);
 console.log('REAL_RETAINED_STEP8_PLAN_AUDIT '+JSON.stringify({members:19,cities:8,audit:audit.status,inventoryUnchanged:true,dbUnchanged:true,network:false,providers:false}));
}
