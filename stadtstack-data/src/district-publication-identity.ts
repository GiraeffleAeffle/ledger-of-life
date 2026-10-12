import {z} from 'zod';
import {HashSchema,semanticHash,canonicalJson} from './district-adapter-contract.ts';
import {verifyPinnedAssessment} from './district-assessment.ts';
import {IdentityAdmissionSchema,IdentityAssertionSchema,assertIdentityAssertionsBound,effectiveIntervalFromExpression,type IdentityAdmission,type IdentityAssertion,type IdentityMention} from './district-entity-resolution.ts';
import type {DistrictCas} from './district-cas.ts';
import type {CivicPolicyOptions} from './civic-opt-out.ts';

export const identityAssessmentInventorySchema=z.object({assertions:z.array(z.object({assertionId:z.string().regex(/^identity:[a-f0-9]{64}$/),finalArtifactSha256:HashSchema,itemArtifactSha256:HashSchema,AArtifactSha256:HashSchema,BArtifactSha256:HashSchema,CArtifactSha256:HashSchema}).strict())}).strict();
export type IdentityAssessmentInventory=z.infer<typeof identityAssessmentInventorySchema>;
/** Public seals come only from replayed private final/item/A/B/C artifacts and exact original evidence. */
export async function admitPublicationIdentities(input:{assertions:readonly IdentityAssertion[];mentions:IdentityMention[];additionalSourceHashes?:string[];inventoryInput:unknown;cas:DistrictCas;policyOptions?:CivicPolicyOptions;currentAdmissionReceipts?:Readonly<Record<string,string>>;originalAdmissions?:readonly IdentityAdmission[]}):Promise<{admissions:IdentityAdmission[];dependencySha256:string}>{
 const assertions=input.assertions.map(assertion=>IdentityAssertionSchema.parse(assertion));
 const reviewed=assertions.filter(assertion=>assertion.status==='accepted'&&assertion.method==='authoritative_review');
 const inventory=identityAssessmentInventorySchema.parse(input.inventoryInput),key=(entry:{assertionId:string;finalArtifactSha256:string})=>canonicalJson([entry.assertionId,entry.finalArtifactSha256]),entries=new Map(inventory.assertions.map(entry=>[key(entry),entry]));
 if(entries.size!==inventory.assertions.length||reviewed.some(assertion=>!entries.has(key({assertionId:assertion.id,finalArtifactSha256:assertion.reviewReceiptSha256!}))))throw Error('Publication requires actual final assessment dependencies for every reviewed identity assertion');
 const mentions=new Map(input.mentions.map(mention=>[mention.id,mention])),admissions:IdentityAdmission[]=[];
 for(const assertion of reviewed){
  const entry=entries.get(key({assertionId:assertion.id,finalArtifactSha256:assertion.reviewReceiptSha256!}))!;
  if(entry.finalArtifactSha256!==assertion.reviewReceiptSha256)throw Error('Identity review final receipt binding mismatch');
  const verified=await verifyPinnedAssessment(input.cas,entry.finalArtifactSha256,entry,{...(input.policyOptions?{policyOptions:input.policyOptions}:{}),...(input.currentAdmissionReceipts?{currentAdmissionReceipts:input.currentAdmissionReceipts}:{})});
  const {final,item,assessments}=verified;
  if(final.disposition!=='ai_reconciled'||final.blocksAffectedAdmission||final.independentlyValidated||!final.output||final.output.outcome==='unresolved'||!item.criticalKinds.includes('identity')||!item.claimIds.includes(assertion.id))throw Error('Identity review assessment is not admitted source-backed identity evidence');
  const left=mentions.get(assertion.leftMentionId),right=mentions.get(assertion.rightMentionId);
  const originals=new Set(item.sources.map(source=>source.originalSha256));
  if(!left||!right||!originals.has(left.sourceSha256)||!originals.has(right.sourceSha256))throw Error('Identity assessment original source endpoints mismatch');
  const claims=final.output.assertions.filter(claim=>claim.claimId===assertion.id&&claim.subjectId===assertion.leftMentionId&&claim.objectId===assertion.rightMentionId&&claim.value===assertion.decision&&(claim.modality==='confirmed'||assertion.decision==='insufficient_evidence'&&claim.modality==='unknown'));
  if(!claims.length)throw Error('Identity assessment does not substantiate the exact endpoint decision');
  const actualEvidence=new Set<string>(),sourceExpressions:string[]=[];
  for(const claim of claims){
   const source=item.sources.find(source=>source.sourceId===claim.sourceId);
   if(!source)throw Error('Identity assessment source membership mismatch');
   actualEvidence.add(source.originalSha256);
   if('nativeEvidence' in claim){actualEvidence.add(semanticHash(claim.nativeEvidence));if(typeof claim.nativeEvidence.rawValue==='string')sourceExpressions.push(claim.nativeEvidence.rawValue);}
   else{actualEvidence.add(semanticHash([source.originalSha256,claim.quote]));sourceExpressions.push(claim.quote);}
  }
  if(assertion.evidenceHashes.some(hash=>!actualEvidence.has(hash))||assertion.validity.evidenceHashes.some(hash=>!actualEvidence.has(hash)))throw Error('Identity review does not support assertion source or temporal evidence');
  if(assertion.validity.expression!==null&&!sourceExpressions.some(text=>text.includes(assertion.validity.expression!)))throw Error('Identity temporal expression is absent from reviewed original evidence');
  if(canonicalJson(assertion.validity)!==canonicalJson(effectiveIntervalFromExpression(assertion.validity.expression,assertion.validity.evidenceHashes)))throw Error('Identity temporal bounds do not replay from the exact reviewed source expression');
  const fields={schemaVersion:'assessment-disposition-v1' as const,assertionId:assertion.id,assertionSha256:semanticHash(assertion),assessmentReceiptSha256:entry.finalArtifactSha256,receiptHashes:{A:assessments.A.receiptSha256,B:assessments.B.receiptSha256,C:assessments.C.receiptSha256},itemSha256:final.itemSha256,leftMentionId:assertion.leftMentionId,rightMentionId:assertion.rightMentionId,decision:assertion.decision,status:'admitted' as const,adjudicator:assertion.adjudicator!,labelProvenance:'ai_reconciled' as const,sourceEvidenceHashes:[...actualEvidence].sort(),deterministicPassed:true as const};
  admissions.push(IdentityAdmissionSchema.parse({...fields,sealSha256:semanticHash(fields)}));
 }
 admissions.sort((a,b)=>a.assertionId<b.assertionId?-1:a.assertionId>b.assertionId?1:0);
 if(input.originalAdmissions&&canonicalJson([...input.originalAdmissions].sort((a,b)=>a.assertionId<b.assertionId?-1:a.assertionId>b.assertionId?1:0))!==canonicalJson(admissions))throw Error('Original identity admission seals do not match actual private assessment replay');
 assertIdentityAssertionsBound(input.mentions,assertions,admissions,input.additionalSourceHashes);
 const dependencies=inventory.assertions.map(entry=>({...entry})).sort((a,b)=>a.assertionId<b.assertionId?-1:a.assertionId>b.assertionId?1:0);
 return {admissions,dependencySha256:semanticHash(dependencies)};
}
