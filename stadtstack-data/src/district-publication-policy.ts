import {z} from 'zod';
import {HashSchema,semanticHash,canonicalJson} from './district-adapter-contract.ts';
import {DistrictCas} from './district-cas.ts';
import {loadPolicyReceipt,recheckPolicyReceipt,type PolicyReceipt,type PolicyRecheckResult} from './district-policy-receipt.ts';
import type {DistrictKnowledgeRecord} from './district-schema.ts';
import type {StructuredKnowledgeRecord} from './district-structured-record.ts';
import type {PublicationInputs} from './district-publication-inputs.ts';

export const publicationPolicyReceiptInventorySchema=z.object({records:z.array(z.object({recordId:z.string().min(1),receipts:z.array(z.object({sourceUrl:z.url(),sourceSha256:HashSchema,receiptSha256:HashSchema,currentReceiptSha256:HashSchema.optional()}).strict()).min(1)}).strict()),currentAdmissionReceipts:z.record(HashSchema,HashSchema).optional()}).strict();
export type PublicationPolicyReceiptInventory=z.infer<typeof publicationPolicyReceiptInventorySchema>;
/** Receipt hashes are resolved in private CAS; no caller-provided approval boolean is accepted. */
export async function recheckPublicationPolicy(records:readonly (DistrictKnowledgeRecord|StructuredKnowledgeRecord)[],inventoryInput:unknown,cas:DistrictCas,options:{evaluationAt:string;stateDir?:string;originalPolicy?:PublicationInputs['policy']}):Promise<{policy:PublicationInputs['policy'];inventorySha256:string;executionSnapshotSha256:string;currentAdmissionReceipts:Readonly<Record<string,string>>;optOutSnapshotSha256:string|null}>{
 const inventory=publicationPolicyReceiptInventorySchema.parse(inventoryInput),byRecord=new Map<string,PublicationPolicyReceiptInventory['records'][number]>();
 const currentAdmissionReceipts:Record<string,string>={...inventory.currentAdmissionReceipts};
 for(const entry of inventory.records)for(const receipt of entry.receipts)if(receipt.currentReceiptSha256){
  if(currentAdmissionReceipts[receipt.receiptSha256]&&currentAdmissionReceipts[receipt.receiptSha256]!==receipt.currentReceiptSha256)throw Error('Conflicting current policy proof for one original receipt');
  currentAdmissionReceipts[receipt.receiptSha256]=receipt.currentReceiptSha256;
 }
 for(const entry of inventory.records){if(byRecord.has(entry.recordId))throw Error('Duplicate publication policy record');byRecord.set(entry.recordId,entry);}
 if(records.some(record=>!byRecord.has(record.id)))throw Error('Publication requires actual policy receipts for every record');
 const receipts:PublicationInputs['policy']['receipts']=[],snapshots=new Set<string>(),epochs=new Set<string>();
 const originals=new Map<string,PolicyReceipt>(),checks=new Map<string,PolicyRecheckResult>(),verifiedSources=new Set<string>();
 for(const record of records){
  const structured='kind' in record&&record.kind==='structured';
  const sources=structured?[record.source,...record.supportingSources]:record.sources;
  const entry=byRecord.get(record.id)!;
  const sourceKeys=new Set(sources.map(source=>JSON.stringify([source.id,source.url,source.sha256]))),coveredSources=new Set<string>(),mappedReceipts=new Set(entry.receipts.map(receipt=>receipt.receiptSha256));
  if(mappedReceipts.size!==entry.receipts.length||sourceKeys.size!==entry.receipts.length)throw Error('Publication policy source inventory binding mismatch');
  const sourceReceipts:string[]=[];
  for(const reference of entry.receipts){
   let original=originals.get(reference.receiptSha256);
   if(!original){original=await loadPolicyReceipt(cas,reference.receiptSha256);originals.set(reference.receiptSha256,original);}
   if(original.source.url!==reference.sourceUrl||original.source.sha256!==reference.sourceSha256||original.scope.municipalityId!==record.municipalityId||original.scope.ags!==record.ags||!sources.some(source=>source.id===original.scope.sourceId&&source.url===reference.sourceUrl&&source.sha256===reference.sourceSha256&&source.mimeType===original.source.mimeType))throw Error('Publication policy receipt source/scope binding mismatch');
   const sourceKey=JSON.stringify([original.scope.sourceId,original.source.url,original.source.sha256]);
   if(!sourceKeys.has(sourceKey)||coveredSources.has(sourceKey))throw Error('Publication policy receipt duplicates or changes source scope');coveredSources.add(sourceKey);
   if(structured){
    const source=record.source.id===original.scope.sourceId&&record.source.url===reference.sourceUrl&&record.source.sha256===reference.sourceSha256?record.source:record.supportingSources.find(source=>source.id===original.scope.sourceId&&source.url===reference.sourceUrl&&source.sha256===reference.sourceSha256)!;
    const scopeSha256='scopeSha256' in source?source.scopeSha256:record.verification.scopeSha256;
    if(source.policyReceiptSha256!==reference.receiptSha256||scopeSha256!==semanticHash(original.scope))throw Error('Structured publication policy receipt binding mismatch');
   }
   const currentReceiptSha256=currentAdmissionReceipts[reference.receiptSha256],checkKey=JSON.stringify([reference.receiptSha256,currentReceiptSha256??null]);
   let current=checks.get(checkKey);
   if(!current){
    let currentProof=currentReceiptSha256?originals.get(currentReceiptSha256):undefined;
    if(currentReceiptSha256&&!currentProof){currentProof=await loadPolicyReceipt(cas,currentReceiptSha256);originals.set(currentReceiptSha256,currentProof);}
    current=await recheckPolicyReceipt(original,{evaluationAt:options.evaluationAt,...(options.stateDir?{stateDir:options.stateDir}:{}),...(currentProof?{currentProof}:{})});checks.set(checkKey,current);
   }
   if(!verifiedSources.has(original.source.sha256)){await cas.verify(original.source.sha256);verifiedSources.add(original.source.sha256);}
   if(current.receiptSha256!==reference.receiptSha256)throw Error('Current policy recheck changed original receipt provenance');
   sourceReceipts.push(reference.receiptSha256);snapshots.add(current.snapshotSha256);
   epochs.add(current.optOutSnapshotSha256);if(epochs.size>1)throw Error('Mixed current-policy epochs in one publication');
  }
  if(coveredSources.size!==sourceKeys.size)throw Error('Publication policy source inventory binding mismatch');
  sourceReceipts.sort();receipts.push({recordId:record.id,receiptSha256:sourceReceipts.length===1?sourceReceipts[0]:semanticHash(sourceReceipts)});
 }
 receipts.sort((a,b)=>a.recordId<b.recordId?-1:a.recordId>b.recordId?1:0);
 const executionSnapshotSha256=semanticHash([...snapshots].sort());
 if(options.originalPolicy&&canonicalJson(options.originalPolicy.receipts)!==canonicalJson(receipts))throw Error('Replay original publication policy receipt binding mismatch');
 // Current revalidation proofs are execution inputs, not rewritten original publication provenance.
 const originalInventory={records:inventory.records.map(entry=>({recordId:entry.recordId,receipts:entry.receipts.map(({currentReceiptSha256,...original})=>original).sort((a,b)=>canonicalJson(a)<canonicalJson(b)?-1:canonicalJson(a)>canonicalJson(b)?1:0)})).sort((a,b)=>a.recordId<b.recordId?-1:a.recordId>b.recordId?1:0)};
 return {policy:options.originalPolicy??{snapshotSha256:executionSnapshotSha256,receipts},inventorySha256:semanticHash(originalInventory),executionSnapshotSha256,currentAdmissionReceipts,optOutSnapshotSha256:epochs.values().next().value??null};
}
