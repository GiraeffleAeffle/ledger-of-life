import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

/** Refusal-only preflight. The caller owns a checked-out READ ONLY transaction
 * and supplies its managed, hash-authenticating CAS reader. No latest-proof lookup,
 * writes, receipt export, renewal, builder or network transport is used here. */
export async function precheckStructuredSelection({client,readCas,runIds,requiredThrough,policy,core,expectedScopes=[],selection}) {
  assert.ok(Array.isArray(runIds)&&runIds.length>0&&runIds.length<=1000,'Bounded structured run selection required');
  assert.equal(new Set(runIds).size,runIds.length,'Duplicate structured run selection');
  assert.ok(runIds.every(id=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)),'Invalid run UUID');
  assert.ok(Number.isFinite(requiredThrough)&&requiredThrough>Date.now(),'Future policy horizon required');
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on','Structured precheck requires READ ONLY transaction');
  core??=await loadStructuredPrecheckCore(new URL('../',import.meta.url));
  const {adapter,receipt:receiptCore,structuredJobs,policyReceipt,worker}=core;
  const report={schemaVersion:'stadtstack-r1-step8-structured-precheck-v1',checkedAt:new Date().toISOString(),requiredThrough:new Date(requiredThrough).toISOString(),runIds:[...runIds],receipts:[],policies:[],issues:[],readOnly:true,authorizesExecution:false};
  const issue=(runId,message)=>report.issues.push({runId,message});
  const selected=await client.query(`SELECT r.run_id::text,r.receipt_sha256,r.receipt,j.spec,j.state,j.attempt AS current_attempt
    FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id
    WHERE r.run_id=ANY($1::uuid[]) ORDER BY r.committed_at,r.receipt_sha256`,[runIds]);
  const proofs=new Map(),pages=new Map(),scopes=new Set();
  const json=async hash=>{adapter.HashSchema.parse(hash);const bytes=Buffer.from(await readCas(hash));assert.equal(adapter.digest(bytes),hash,'CAS digest mismatch');return JSON.parse(bytes.toString('utf8'));};
  const checkProof=async(hash,source,scope,runId)=>{
    let proof=proofs.get(hash);
    if(!proof){proof=policyReceipt.PolicyReceiptSchema.parse(await json(hash));assert.equal(adapter.semanticHash(proof),hash,'Policy semantic hash mismatch');proofs.set(hash,proof);report.policies.push({sha256:hash,source:proof.source,scope:proof.scope,checkedAt:proof.checkedAt,expiresAt:proof.expiresAt});}
    assert.equal(proof.source.sha256,source.sha256,'Policy source byte mismatch');
    if(source.url!==undefined)assert.equal(proof.source.url,source.url,'Policy source URL mismatch');
    if(source.mimeType!==undefined)assert.equal(proof.source.mimeType,source.mimeType,'Policy MIME mismatch');
    assert.equal(adapter.semanticHash(proof.scope),typeof scope==='string'?scope:adapter.semanticHash(scope),'Policy source scope mismatch');
    assert.ok(Date.parse(proof.expiresAt)>requiredThrough,`${runId}: policy ${hash} expires ${proof.expiresAt}; required strictly beyond ${report.requiredThrough}`);
    await policyReceipt.recheckPolicyReceipt(proof,{...policy,evaluationAt:new Date().toISOString()});
    await jsonOrBytes(source.sha256);
  };
  const jsonOrBytes=async hash=>{adapter.HashSchema.parse(hash);const bytes=await readCas(hash);assert.equal(adapter.digest(bytes),hash,'Original source CAS digest mismatch');};
  for(const runId of runIds){
    const all=selected.rows.filter(row=>row.run_id===runId),rows=all.filter(row=>['structured_parse','structured_discover'].includes(row.spec.step));
    if(!rows.length){issue(runId,`No committed structured_parse/structured_discover receipt; actual steps: ${[...new Set(all.map(row=>row.spec.step))].join(', ')||'none'}`);continue;}
    for(const row of rows){
      try{
        const receipt=receiptCore.StepReceiptSchema.parse(row.receipt),spec=row.spec;
        assert.equal(adapter.semanticHash(receipt),row.receipt_sha256,'Committed step receipt digest mismatch');
        assert.equal(receipt.runId,runId);assert.equal(receipt.step,spec.step);assert.equal(receipt.outcome,row.state,'Selected receipt is not current job outcome');assert.equal(receipt.attempt,row.current_attempt,'Selected receipt is not current job attempt');
        assert.equal(receipt.provider,null,'Structured receipt must not be a model receipt');
        report.receipts.push({runId,step:receipt.step,outcome:receipt.outcome,sha256:row.receipt_sha256,outputHashes:receipt.outputHashes,policyReceiptSha256:receipt.policyProofSha256,sourceId:receipt.sourceId,municipalityId:receipt.municipalityId});
        const request=worker.StructuredWorkerRequestSchema.parse(spec.selector.worker);
        assert.equal(receipt.step,`structured_${request.operation}`);assert.equal(adapter.semanticHash(spec.sourceScope),adapter.semanticHash(request.scope));
        assert.equal(receipt.policyProofSha256,request.snapshot.policyReceiptSha256);
        assert.ok(receipt.inputHashes.includes(request.snapshot.sourceSha256)&&receipt.inputHashes.includes(request.snapshot.policyReceiptSha256),'Unbound structured source/proof');
        scopes.add(JSON.stringify([request.scope.municipalityId,request.scope.sourceId]));
        await checkProof(request.snapshot.policyReceiptSha256,{sha256:request.snapshot.sourceSha256,url:request.snapshot.url,mimeType:request.snapshot.mimeType},request.scope,runId);
        for(const source of spec.selector.supportingSources??[])await checkProof(source.policyReceiptSha256,source,source.scopeSha256,runId);
        if(!receipt.outputHashes.length){assert.notEqual(receipt.outcome,'succeeded','Succeeded parser requires output');continue;}
        assert.equal(receipt.outputHashes.length,1,'Unexpected structured output count');
        const output=structuredJobs.StructuredJobResultSchema.parse(await json(receipt.outputHashes[0]));
        assert.equal(output.requestSha256,adapter.semanticHash(request),'Output request binding mismatch');
        assert.equal(output.sourceSha256,request.snapshot.sourceSha256);assert.equal(output.policyReceiptSha256,request.snapshot.policyReceiptSha256);assert.equal(adapter.semanticHash(output.scope),adapter.semanticHash(request.scope));
        assert.equal(adapter.canonicalJson(output.supportingSources),adapter.canonicalJson(spec.selector.supportingSources),'Output supporting source set differs');
        assert.equal(receipt.versions.worker,worker.STRUCTURED_WORKER_VERSION);assert.equal(receipt.versions.parser,output.parserContractSha256);assert.equal(receipt.versions.mapping,output.mappingContractSha256);assert.equal(receipt.versions.adapter,output.adapterVersion);
        assert.equal(receipt.counts.rows,output.result.coverage.observedRows);assert.equal(receipt.counts.acceptedFacts,output.records.length);
        if(output.page){const key=adapter.semanticHash({scope:output.scope,source:output.sourceSha256,proof:output.policyReceiptSha256,adapter:output.adapterId,operation:receipt.step});const group=pages.get(key)??[];group.push(output.page);pages.set(key,group);}
      }catch(error){issue(runId,error.message);}
    }
  }
  for(const [key,group] of pages){try{let end=0;const first=group[0];for(const page of group.sort((a,b)=>a.offset-b.offset)){assert.equal(page.offset,end,'Missing or overlapping selected parser pages');assert.equal(page.total,first.total);assert.equal(page.bindingSha256,first.bindingSha256);assert.equal(adapter.canonicalJson(page.sourceCoverage),adapter.canonicalJson(first.sourceCoverage));end=page.end;}assert.equal(end,first.total,'Selected parser page closure incomplete');assert.equal(group.at(-1).nextCursor,null,'Terminal page still has cursor');}catch(error){issue(null,`${key}: ${error.message}`);}}
  for(const scope of expectedScopes)if(!scopes.has(JSON.stringify(scope)))issue(null,`Missing required municipality/source ${scope.join('/')}`);
  if(selection){
    const project=row=>({runId:row.runId,sha256:row.sha256,step:row.step,municipalityId:row.municipalityId,sourceId:row.sourceId});
    const ordered=rows=>rows.map(project).sort((a,b)=>a.sha256.localeCompare(b.sha256));
    if(adapter.canonicalJson(selection.runIds)!==adapter.canonicalJson(runIds)||adapter.canonicalJson(ordered(selection.receipts))!==adapter.canonicalJson(ordered(report.receipts)))issue(null,'Committed structured receipt set differs from issued selection');
  }
  if(report.issues.length){const error=Error('Structured selection/currency precheck refused: '+report.issues.map(row=>`${row.runId??'selection'}: ${row.message}`).join('; '));error.report=report;throw error;}
  return report;
}

export async function loadStructuredPrecheckCore(root){
  const url=root instanceof URL?root:pathToFileURL(root.replace(/\/$/,'')+'/');
  const [adapter,receipt,structuredJobs,policyReceipt,worker]=await Promise.all(['district-adapter-contract.ts','district-step-receipt.ts','district-structured-jobs.ts','district-policy-receipt.ts','district-structured-parser-worker.ts'].map(file=>import(new URL('src/'+file,url).href)));
  return {adapter,receipt,structuredJobs,policyReceipt,worker};
}
