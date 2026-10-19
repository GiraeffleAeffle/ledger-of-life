import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {TestContext} from 'node:test';
import type {Pool} from 'pg';
import {root,cacheDir} from '../../src/common.ts';
import {writePrivateJson} from '../../src/district-private-io.ts';
import {runRetainedPublicationImportPlan} from '../../src/district-retained-import.ts';
import {readCommittedReleaseFile} from '../../src/district-publication-predecessor.ts';
import {STEP8_PRIOR_RELEASE} from '../../src/r1-step8-current-policy.ts';
import {buildStep8RetainedPlan,assembleStep8Staging,prepareStep8Staging,commitStep8Staging} from '../../src/r1-step8-staging.ts';
import {Step8InputSchema,Step8OperatorInputSchema,step8ReadPlan,auditStep8Operator,runStep8,type Step8Input} from '../../src/r1-step8.ts';
import {auditStep8,recheckStep8Audit,relocateStep8AuditCampaign} from '../../src/r1-step8-audit.ts';
import {createWitnessedProvenanceContext} from '../../src/r1-step8-provenance.ts';
import {digest} from '../../src/district-adapter-contract.ts';
import {loadStep8ExceptionBundle} from '../../src/r1-release-acceptance.ts';
import {privatePublicationProvenanceSchema,authenticatePublicationProvenance} from '../../src/district-publication-provenance.ts';
import {readCivicPolicyInventory} from '../../src/civic-opt-out.ts';
import {ReplayEvidenceInputPinsSchema,replayEvidenceCasRoot} from '../../src/replay-evidence-contract.ts';

/** Real immutable 0.3.2 staging bytes, isolated authority/PG and synthetic native
 * assessment evidence from the existing topology fixture; no live claims. */
export async function exerciseRealRetainedStaging(t:TestContext,manifest:Step8Input,pool:Pool,fixtureRoot:string,sourceProvenance:{path:string;sha256:string},canonicalBuildCount:()=>number){
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
 const counts=async()=> (await pool.query('SELECT (SELECT count(*) FROM district_pipeline.jobs) AS jobs,(SELECT count(*) FROM district_pipeline.step_receipts) AS receipts,(SELECT count(*) FROM district_pipeline.artifacts) AS artifacts')).rows;
 const beforeAudit=await readFile(join(manifest.policy.stateDir,'inventory.json')),beforeCounts=await counts(),assemblyPath=join(fixtureRoot,'operator-controls','assembly.json'),assemblySha256=await writePrivateJson(assemblyPath,request);
 const {campaign:_,registry:__,privateProvenance:___,staging:____,...base}=manifest,operator=Step8OperatorInputSchema.parse({...base,stagingAssembly:{path:assemblyPath,sha256:assemblySha256}});
 assert.deepEqual(step8ReadPlan(operator).writes,[]);
 const beforeStandalone=canonicalBuildCount(),operatorAudit=await auditStep8Operator(operator,pool);
 assert.equal(operatorAudit.status,'compatible',JSON.stringify(operatorAudit.blockers));assert.equal(canonicalBuildCount()-beforeStandalone,1,'standalone operator audit owns one canonical pass');
 await assert.rejects(readFile(join(managedRoot,'staging-component.json')),{code:'ENOENT'});
 assert.deepEqual(await readFile(join(manifest.policy.stateDir,'inventory.json')),beforeAudit);assert.deepEqual(await counts(),beforeCounts);
 const beforeShared=canonicalBuildCount(),context=await createWitnessedProvenanceContext(manifest.nativeSealSelection,manifest.policy,{pool,casRoot:manifest.casRoot,catalogue:manifest.currentGeneration.catalogue,mode:'step8',workers:1,timing:manifest.reconstructionTiming});
 const prepared=await prepareStep8Staging(request,pool,context);let finished=false,audit:Awaited<ReturnType<typeof auditStep8>>;
 try{
  await assert.rejects(commitStep8Staging(prepared),/successfully finished canonical source epoch/);
  assert.deepEqual(await readFile(join(manifest.policy.stateDir,'inventory.json')),beforeAudit);
  audit=await auditStep8(Step8InputSchema.parse({...manifest,...prepared.inputs}),pool,context,prepared);
  assert.equal(audit.status,'compatible',JSON.stringify(audit.blockers));assert.equal(canonicalBuildCount()-beforeShared,1,'staging preparation and embedded audit reuse one source reconstruction');
  assert.deepEqual(await readFile(join(manifest.policy.stateDir,'inventory.json')),beforeAudit);assert.deepEqual(await counts(),beforeCounts);
  await recheckStep8Audit(audit);
  const reviewBytes=await readFile(manifest.currentGeneration.processingReview.path);
  try{await writeFile(manifest.currentGeneration.processingReview.path,Buffer.from('{}'));await assert.rejects(recheckStep8Audit(audit),/operator control changed/);}
  finally{await writeFile(manifest.currentGeneration.processingReview.path,reviewBytes);}
  await recheckStep8Audit(audit);
  await assert.rejects(relocateStep8AuditCampaign(audit,{path:join(managedRoot,'campaign.json'),sha256:manifest.campaign.sha256},manifest.privateProvenance,manifest.policy),/successfully finished canonical source epoch/);
  finished=true;await context.finish();
 }finally{try{if(!finished)await context.finish();}finally{await prepared.dispose();}}
 console.log('REAL_RETAINED_STEP8_PLAN_AUDIT '+JSON.stringify({members:19,cities:8,audit:audit.status,inventoryUnchanged:true,dbUnchanged:true,network:false,providers:false}));
 const target={path:join(managedRoot+'-execution','campaign.json'),sha256:manifest.campaign.sha256};
 await assert.rejects(relocateStep8AuditCampaign({...audit},target,manifest.privateProvenance,manifest.policy),/trusted staging audit/);
 await assert.rejects(relocateStep8AuditCampaign(audit,{...target,sha256:'0'.repeat(64)},manifest.privateProvenance,manifest.policy),/preserve the exact authenticated bytes/);
 // Execute the actual operator union, not a manually substituted ready input:
 // the committed campaign pin must survive the complete step9 exception loader.
 const executionRoot=managedRoot+'-execution';
 t.after(async()=>{await rm(executionRoot,{recursive:true,force:true});await rm(executionRoot+'.claim',{force:true});});
 const executionRequest={...request,managedRoot:executionRoot},executionPath=join(fixtureRoot,'operator-controls','execution-assembly.json'),executionSha256=await writePrivateJson(executionPath,executionRequest);
 const sealed=JSON.parse((await readFile(manifest.seals[0].sealResult.path)).toString('utf8')),sharedPins=[sealed.criticalInventory,sealed.criticalAdmissions] as Array<{path:string;sha256:string}>;
 const sharedSnapshot=async()=>{
  const inventory=await readCivicPolicyInventory(manifest.policy),cas=inventory.roots.find(root=>root.path===manifest.casRoot);assert.ok(cas);
  return Promise.all(sharedPins.map(async pin=>{const bytes=await readFile(pin.path),entries=inventory.entries.filter(entry=>entry.rootId===cas.id&&entry.relativePath===relative(cas.path,pin.path)).sort((a,b)=>a.id.localeCompare(b.id));assert.equal(digest(bytes),pin.sha256);assert.ok(entries.length>=2,'genuine empty control is shared by both duplicate-URL producers');return {path:pin.path,bytes,entries};}));
 };
 const sharedBefore=await sharedSnapshot();
 const execution=Step8OperatorInputSchema.parse({...base,stagingAssembly:{path:executionPath,sha256:executionSha256}}),beforeExecute=canonicalBuildCount(),gate=await runStep8(execution,pool);
 assert.equal(gate.status,'passed');assert.equal(canonicalBuildCount()-beforeExecute,1,'operator execute reuses one canonical source pass');
 assert.deepEqual(await sharedSnapshot(),sharedBefore,'source CAS shared blob bytes and complete binding sets are unchanged by replay persistence');
 console.log('REAL_RETAINED_STEP8_PHASE_TIMINGS '+JSON.stringify(gate.phaseTimings));
 assert.notEqual(gate.campaign.path,manifest.campaign.path);assert.equal(gate.campaign.sha256,manifest.campaign.sha256);
 assert.ok(gate.stagingAssembly);
 const component=await readFile(gate.stagingAssembly.path);assert.equal(digest(component),gate.stagingAssembly.sha256);
 const actual=Step8InputSchema.parse({...manifest,...JSON.parse(component.toString('utf8'))});
 assert.equal(actual.staging.length,19);assert.deepEqual(await counts(),beforeCounts);
 for(const staged of actual.staging)assert.deepEqual(await readFile(staged.path),await readCommittedReleaseFile(STEP8_PRIOR_RELEASE.gitCommit,staged.destination,undefined,'release'));
 assert.equal(actual.staging.filter(pin=>pin.destination.endsWith('/feed.json')).length,8);
 assert.equal(actual.staging.filter(pin=>pin.destination.endsWith('/signals.geojson')).length,8);
 await assert.rejects(assembleStep8Staging(executionRequest),/already exists/);
 const gatePath=join(manifest.outputRoot,'release-gate.json'),gatePin={path:gatePath,sha256:digest(await readFile(gatePath))},handoffPins={gate:gatePin,exceptions:gate.exceptionInventory,handoff:gate.step9Handoff};
 const accepted=await loadStep8ExceptionBundle(handoffPins,gate.releaseId);assert.equal(accepted.gate.status,'passed');
 const replay=JSON.parse((await readFile(gate.replayReceipt.path)).toString('utf8')),provenanceBytes=await readFile(replay.privateProvenance.path),publication=privatePublicationProvenanceSchema.parse(JSON.parse(provenanceBytes.toString('utf8')));
 const proof=JSON.parse((await readFile(join(manifest.outputRoot,'replay-proof.json'))).toString('utf8')),inputPins=ReplayEvidenceInputPinsSchema.parse(proof.inputs);
 assert.equal(proof.persistence.artifactCasRoot,replayEvidenceCasRoot(replay.workspace,manifest.outputRoot));assert.notEqual(proof.persistence.artifactCasRoot,manifest.casRoot);
 assert.equal(proof.persistence.artifacts.length,proof.comparison.files.length+2);
 assert.ok(proof.persistence.artifacts.every((artifact:{path:string})=>artifact.path==='proof.json'||artifact.path.startsWith('release/')),'predecessor/staging trees are pinned, not re-archived');
 assert.deepEqual(inputPins.dependencies.map(pin=>[pin.path,pin.sha256,pin.bytes]).sort(),publication.inputs.map(pin=>[pin.path,pin.sha256,pin.bytes]).sort());
 assert.deepEqual(inputPins.staging.map(pin=>[pin.destination,pin.path,pin.sha256]).sort(),replay.staging.map((pin:{destination:string;path:string;sha256:string})=>[pin.destination,pin.path,pin.sha256]).sort());
 assert.equal(inputPins.priorReleases[0].gitCommit,STEP8_PRIOR_RELEASE.gitCommit);assert.equal(inputPins.priorReleases[0].manifest.sha256,STEP8_PRIOR_RELEASE.manifestSha256);assert.ok(inputPins.priorReleases[0].members.length>=20);
 assert.equal(inputPins.runtime.sourceFiles.length,replay.runtime.sourceFiles.length);assert.equal(inputPins.receipt.sha256,gate.replayReceipt.sha256);
 assert.equal(digest(provenanceBytes),replay.privateProvenance.sha256);assert.ok(provenanceBytes.length<=16*1024*1024,'unchanged Core provenance size guard');
 const composition=JSON.parse((await readFile(replay.textComposition.path)).toString('utf8')),artifactPaths=new Set<string>(composition.contributions.flatMap((entry:{artifacts:Record<string,{path:string}>})=>Object.values(entry.artifacts).map(pin=>pin.path)));
 const required=new Set<string>([...['registry','candidateRecords','candidateQuarantine','identityState','publicationInputs','policyReceipts','criticalAssessments','textComposition','structuredRun','identityAssessments','regionalPolicyReceipts'].flatMap(role=>replay[role]?[replay[role].path]:[]),...replay.staging.map((pin:{path:string})=>pin.path),...artifactPaths]);
 assert.deepEqual(publication.inputs.map(pin=>pin.path).sort(),[...required].sort(),'complete and only actual publication/replay direct and lineage inputs');
 const stagingPaths=new Set<string>(actual.staging.map(pin=>pin.path)),stagingProvenance=privatePublicationProvenanceSchema.parse(JSON.parse((await readFile(actual.privateProvenance.path)).toString('utf8')));
 for(const pin of publication.inputs.filter(pin=>stagingPaths.has(pin.path)))assert.deepEqual(pin,stagingProvenance.inputs.find(source=>source.path===pin.path),'retained input keeps its complete exact binding set');
 for(const role of ['candidateRecords','candidateQuarantine','identityState','policyReceipts','criticalAssessments','textComposition','structuredRun','publicationInputs']){
  const pin=publication.inputs.find(pin=>pin.path===replay[role].path);assert.ok(pin);assert.ok(pin.bindings.every(binding=>binding.kind!=='retained_publication'),'unrelated retained rows do not fan out into native/control input '+role);
 }
 const records=publication.inputs.find(pin=>pin.path===replay.candidateRecords.path);assert.ok(records);
 const requiredBinding=records.bindings.findIndex(binding=>binding.kind==='http_observation');assert.ok(requiredBinding>=0&&records.bindings.length>1);
 const missing={...publication,inputs:publication.inputs.map(pin=>pin===records?{...pin,bindings:pin.bindings.filter((_,index)=>index!==requiredBinding)}:pin)},missingPath=join(fixtureRoot,'operator-controls','missing-producer-provenance.json'),missingSha256=await writePrivateJson(missingPath,missing);
 await assert.rejects(authenticatePublicationProvenance(missingPath,missingSha256,manifest.policy),error=>error instanceof Error&&'code' in error&&error.code==='CONTENT_PROVENANCE_MISMATCH');
 // Size projection only: retain the measured19 rows, repeat the source artifact
 // row shape27 times with at most24 HTTP originals per source, and allow208
 // document plus5 structured HTTP producers on each aggregate row. No projected
 // pin or binding is issued, authenticated, persisted or used as evidence.
 assert.equal(provenanceBytes.length,Buffer.byteLength(JSON.stringify(publication,null,2)+'\n'),'model uses the actual pretty-JSON wire encoding');
 const indentedBytes=(value:unknown,indent:number)=>Buffer.byteLength(JSON.stringify(value,null,2).split('\n').map(line=>' '.repeat(indent)+line).join('\n'));
 const rowBytes=(pin:(typeof publication.inputs)[number],httpTarget:number)=>{const http=pin.bindings.filter(binding=>binding.kind==='http_observation'),largest=http.reduce((max,binding)=>Math.max(max,indentedBytes(binding,8)+2),0);return indentedBytes(pin,4)+Math.max(0,httpTarget-http.length)*largest;};
 const retainedRows=publication.inputs.filter(pin=>stagingPaths.has(pin.path)),sourceRows=publication.inputs.filter(pin=>artifactPaths.has(pin.path)),aggregateRows=publication.inputs.filter(pin=>!stagingPaths.has(pin.path)&&!artifactPaths.has(pin.path));
 const envelopeBytes=provenanceBytes.length-publication.inputs.reduce((sum,pin)=>sum+rowBytes(pin,1),0)-2*Math.max(0,publication.inputs.length-1);
 const projectedRows=retainedRows.length+sourceRows.length*27+aggregateRows.length,projectedBytes=envelopeBytes+2*Math.max(0,projectedRows-1)+retainedRows.reduce((sum,pin)=>sum+rowBytes(pin,1),0)+27*sourceRows.reduce((sum,pin)=>sum+rowBytes(pin,24),0)+aggregateRows.reduce((sum,pin)=>sum+rowBytes(pin,213),0);
 console.log('REAL_RETAINED_STEP8_PROVENANCE_SIZE '+JSON.stringify({actualBytes:provenanceBytes.length,actualInputs:publication.inputs.length,retainedMembers:retainedRows.length,retainedBindings:retainedRows.reduce((sum,pin)=>sum+pin.bindings.length,0),projected27SourceBytes:projectedBytes,projection:'fixture wire-size model;27 sources,19 actual retained members,24 HTTP originals/source row,213 HTTP producers/aggregate row; same URL/proof wire lengths; not a production gate'}));
 const generation=JSON.parse((await readFile(gate.generationAuditEvidence.path)).toString('utf8'));
 assert.deepEqual(generation.campaign,gate.campaign);assert.deepEqual(generation.campaignRelocation.from,manifest.campaign);assert.deepEqual(generation.campaignRelocation.to,gate.campaign);
 const committedBytes=await readFile(gate.campaign.path);
 try{
  await writeFile(gate.campaign.path,Buffer.concat([committedBytes,Buffer.from('\n')]));
  await assert.rejects(loadStep8ExceptionBundle(handoffPins,gate.releaseId),/hash mismatch/);
  await assert.rejects(relocateStep8AuditCampaign(audit,gate.campaign,actual.privateProvenance,manifest.policy));
 }
 finally{await writeFile(gate.campaign.path,committedBytes);}
 await loadStep8ExceptionBundle(handoffPins,gate.releaseId);
 console.log('REAL_RETAINED_STEP8_EXECUTION_HANDOFF '+JSON.stringify({members:19,gate:gate.status,bundleAccepted:true,tamperRejected:true,canonicalPasses:1}));
}
