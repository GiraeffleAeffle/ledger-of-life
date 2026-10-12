import test from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {assessmentItemSchema,originalEvidence,reconcile,canonical,type AssessmentOutput} from '../src/district-assessment.ts';
import {digest,semanticHash} from '../src/district-adapter-contract.ts';
import {identityAssertion,unknownValidity,effectiveIntervalFromExpression,type IdentityMention} from '../src/district-entity-resolution.ts';
import {admitPublicationIdentities} from '../src/district-publication-identity.ts';
import {admittedAssessmentFixture,syntheticAssessmentReceipt} from './district-assessment.fixture.ts';

// Explicit synthetic offline assessment receipts; no provider calls or legal-identity facts.
async function fixture(held=false,multiplePairs=false,temporal=false){
 const expression='ab 2025-01-01 bis auf Weiteres';
 const quote='Synthetic Organization A, Synthetic Organization B and Synthetic Organization C are the same organization.'+(temporal?' '+expression:'');
 const admitted=await admittedAssessmentFixture(quote),sourceSha256=admitted.source.originalSha256;
 const evidenceHash=semanticHash([sourceSha256,quote]);
 const mentions:IdentityMention[]=['A','B','C'].map(label=>({id:'synthetic-mention-'+label,type:'organization',name:'Synthetic Organization '+label,municipalityId:'strausberg',sourceSha256,identifiers:[],legalForm:null,period:null,councilBodyIdentity:null,validity:unknownValidity(),evidenceHashes:[evidenceHash]}));
 const assertion=identityAssertion({version:1,leftMentionId:mentions[0].id,rightMentionId:mentions[1].id,decision:'same_identity',status:'accepted',method:'authoritative_review',ruleVersion:'synthetic-rule-v1',author:'synthetic-author',adjudicator:'synthetic-adjudicator',evidenceHashes:[evidenceHash],reviewReceiptSha256:'1'.repeat(64),validity:temporal?effectiveIntervalFromExpression(expression,[evidenceHash]):unknownValidity()});
 const claim={claimId:assertion.id,sourceId:admitted.source.sourceId,locatorId:'page1',quote,subjectId:assertion.leftMentionId,objectId:assertion.rightMentionId,unit:null,value:'same_identity',date:null,dateRole:null,financialRole:'none' as const,stage:null,modality:'confirmed' as const};
 const {id,...fields}=assertion;
 const assertions=multiplePairs?[assertion,identityAssertion({...fields,rightMentionId:mentions[2].id})]:[assertion];
 const claims=assertions.map(assertion=>({...claim,claimId:assertion.id,subjectId:assertion.leftMentionId,objectId:assertion.rightMentionId}));
 const rubric='Synthetic exact-endpoint identity evidence rubric; AI consensus is not independent gold.';
 const item=assessmentItemSchema.parse({version:'assessment-item-v1',itemId:'synthetic-identity-item',question:'Do the original source fields explicitly support the identity pairs?',claim:'Synthetic identity pairs',rubric,rubricSha256:digest(rubric),sources:[admitted.source],claimIds:assertions.map(assertion=>assertion.id),entityIds:mentions.map(mention=>mention.id),constraints:claims,criticalKinds:['identity']});
 const output:AssessmentOutput={itemId:item.itemId,outcome:'supported',assertions:claims,scores:{correctness:2,sources:2,usefulness:1},holdReasons:[],rationale:'Synthetic fixture only.'};
 const evidence=await originalEvidence(item,admitted.context);
 const request={itemId:item.itemId,question:item.question,claim:item.claim,rubric:item.rubric,claimIds:item.claimIds,entityIds:item.entityIds,evidence};
 const A=syntheticAssessmentReceipt(item,'A',output,request),B=syntheticAssessmentReceipt(item,'B',output,request);
 const thirdRequest={...request,assessments:{A,B},mismatchReport:{mismatches:[],A:[],B:[]}};
 const C=syntheticAssessmentReceipt(item,'C',held?{...output,outcome:'unresolved'}:output,thirdRequest,[A.receiptSha256,B.receiptSha256]);
 const final=await reconcile(item,{A,B,C},admitted.context);
 const artifacts=await Promise.all([item,A,B,C,final].map(value=>admitted.context.cas.put(Buffer.from(canonical(value)),{kind:'receipt',mimeType:'application/json'})));
 for(const assertion of assertions)assertion.reviewReceiptSha256=artifacts[4].sha256;
 const inventory={assertions:assertions.map(assertion=>({assertionId:assertion.id,finalArtifactSha256:artifacts[4].sha256,itemArtifactSha256:artifacts[0].sha256,AArtifactSha256:artifacts[1].sha256,BArtifactSha256:artifacts[2].sha256,CArtifactSha256:artifacts[3].sha256}))};
 return {...admitted,assertion,assertions,mentions,inventory};
}

test('identity publication seals only actual final/item/A/B/C CAS replay and remains AI-labelled',async()=>{
 const f=await fixture();
 try{
  const input={assertions:[f.assertion],mentions:f.mentions,inventoryInput:f.inventory,cas:f.context.cas,stateDir:f.context.policyOptions.stateDir};
  const admitted=await admitPublicationIdentities(input);
  assert.equal(admitted.admissions.length,1);
  assert.equal(admitted.admissions[0].assessmentReceiptSha256,f.assertion.reviewReceiptSha256);
  assert.equal(admitted.admissions[0].labelProvenance,'ai_reconciled');
  assert.equal('independentlyValidated' in admitted.admissions[0],false);
  const replay=await admitPublicationIdentities({...input,originalAdmissions:admitted.admissions});
  assert.deepEqual(replay,admitted);
  await assert.rejects(admitPublicationIdentities({...input,inventoryInput:{assertions:[]}}),/actual final assessment/);
  await assert.rejects(admitPublicationIdentities({...input,assertions:[{...f.assertion,decision:'different_identity'}]}),/exact endpoint decision/);
  await assert.rejects(admitPublicationIdentities({...input,assertions:[{...f.assertion,leftMentionId:f.assertion.rightMentionId,rightMentionId:f.assertion.leftMentionId}]}),/exact endpoint decision/);
  const wrong={assertions:[{...f.inventory.assertions[0],BArtifactSha256:f.inventory.assertions[0].AArtifactSha256}]};
  await assert.rejects(admitPublicationIdentities({...input,inventoryInput:wrong}),/binding/);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});

test('held assessment cannot create an admitted identity even with real receipt hashes',async()=>{
 const f=await fixture(true);
 try{await assert.rejects(admitPublicationIdentities({assertions:[f.assertion],mentions:f.mentions,inventoryInput:f.inventory,cas:f.context.cas,stateDir:f.context.policyOptions.stateDir}),/not admitted source-backed identity/);}
 finally{await rm(f.directory,{recursive:true,force:true});}
});

test('one actual final assessment can substantiate multiple separately bound identity pairs',async()=>{
 const f=await fixture(false,true);
 try{
  const admitted=await admitPublicationIdentities({assertions:f.assertions,mentions:f.mentions,inventoryInput:f.inventory,cas:f.context.cas,stateDir:f.context.policyOptions.stateDir});
  assert.equal(admitted.admissions.length,2);
  assert.equal(admitted.admissions[0].assessmentReceiptSha256,admitted.admissions[1].assessmentReceiptSha256);
  assert.notEqual(admitted.admissions[0].assertionId,admitted.admissions[1].assertionId);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});

test('reviewed identity applicability must replay from the literal source expression',async()=>{
 const f=await fixture(false,false,true);
 try{
  const input={assertions:[f.assertion],mentions:f.mentions,inventoryInput:f.inventory,cas:f.context.cas,stateDir:f.context.policyOptions.stateDir};
  const admitted=await admitPublicationIdentities(input);
  assert.equal(admitted.admissions[0].assertionSha256,semanticHash(f.assertion));
  const changed=structuredClone(f.assertion);changed.validity.validFrom={kind:'date',date:'2024-01-01',inclusive:true,precision:'day'};
  await assert.rejects(admitPublicationIdentities({...input,assertions:[changed]}),/temporal bounds do not replay/);
  const unsourced=structuredClone(f.assertion);unsourced.validity=effectiveIntervalFromExpression('ab 2024-01-01 bis auf Weiteres',f.assertion.validity.evidenceHashes);
  await assert.rejects(admitPublicationIdentities({...input,assertions:[unsourced]}),/temporal expression is absent/);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
