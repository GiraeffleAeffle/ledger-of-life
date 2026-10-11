import {z} from 'zod';
import {HashSchema,ScopeSchema,semanticHash,type AdapterScope} from './district-adapter-contract.ts';
import {ContentFreeSourcePolicySchema,assertSubscriptionSourcePolicy} from './district-schema.ts';
import {effectiveSourcePermission} from './source-policy.ts';
import {assertHostNotOptedOut,readCivicOptOutSnapshot,CIVIC_POLICY_AUTHORITY_ID,type CivicPolicyOptions} from './civic-opt-out.ts';

export const POLICY_RECEIPT_VERSION='district-admissibility-v1';
const DistributionPermissionSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('official_work')}).strict(),
 z.object({kind:z.literal('facts_with_attribution')}).strict(),
 z.object({kind:z.literal('distribution_licence'),distributionUrl:z.url(),licenceId:z.string().min(1),termsUrl:z.url(),termsSha256:HashSchema,approvalSha256:HashSchema}).strict(),
]);
export const PolicyReceiptSchema=z.object({version:z.literal(POLICY_RECEIPT_VERSION),source:z.object({url:z.url(),sha256:HashSchema,mimeType:z.string().min(1)}).strict(),scope:ScopeSchema,sourcePolicy:ContentFreeSourcePolicySchema,permission:DistributionPermissionSchema,checkedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),authorityId:z.string().min(1),authoritySha256:HashSchema,optOutSnapshotSha256:HashSchema,policySnapshotSha256:HashSchema}).strict().superRefine((receipt,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(Date.parse(receipt.expiresAt)<=Date.parse(receipt.checkedAt)||Date.parse(receipt.expiresAt)-Date.parse(receipt.checkedAt)>24*60*60*1000)fail('Policy receipt validity must be positive and at most 24 hours');
 if(receipt.permission.kind==='distribution_licence'&&receipt.permission.distributionUrl!==receipt.source.url)fail('Distribution licence does not bind exact received URL');
 if(receipt.policySnapshotSha256!==semanticHash({source:receipt.source,scope:receipt.scope,sourcePolicy:receipt.sourcePolicy,permission:receipt.permission,authorityId:receipt.authorityId,authoritySha256:receipt.authoritySha256,optOutSnapshotSha256:receipt.optOutSnapshotSha256}))fail('Policy snapshot hash mismatch');
});
export type PolicyReceipt=z.infer<typeof PolicyReceiptSchema>;
export type DistributionPermission=z.infer<typeof DistributionPermissionSchema>;
export interface PolicyRecheckResult {receipt:PolicyReceipt;receiptSha256:string;admissibilityReceiptSha256:string;snapshotSha256:string;optOutSnapshotSha256:string}
/** This wraps settled shared policy. It neither classifies works nor grants rights. */
function assertSharedAdmission(receipt:Pick<PolicyReceipt,'source'|'sourcePolicy'|'permission'>):void {
 assertSubscriptionSourcePolicy(receipt.sourcePolicy,receipt.source);
 if(!effectiveSourcePermission(receipt.sourcePolicy,receipt.source))throw Error('Shared source policy excludes bytes');
 if(receipt.permission.kind==='official_work'&&receipt.sourcePolicy.documentOrigin?.classification!=='official_work')throw Error('Official-work permission lacks exact-byte classification');
 if(receipt.permission.kind==='distribution_licence'&&receipt.permission.distributionUrl!==receipt.source.url)throw Error('Distribution permission mismatch');
}
export async function createPolicyReceipt(input:{source:PolicyReceipt['source'];sourcePolicy:unknown;permission:DistributionPermission;scope:AdapterScope;checkedAt:string;expiresAt:string},options:CivicPolicyOptions={}):Promise<{receipt:PolicyReceipt;receiptSha256:string;snapshotSha256:string}> {
 const sourcePolicy=ContentFreeSourcePolicySchema.parse(JSON.parse(JSON.stringify(input.sourcePolicy))),permission=DistributionPermissionSchema.parse(input.permission),scope=ScopeSchema.parse(input.scope);
 assertSharedAdmission({source:input.source,sourcePolicy,permission});
 await assertHostNotOptedOut(input.source.url,options);
 const optout=await readCivicOptOutSnapshot(options);
 await assertHostNotOptedOut(input.source.url,options);
 const fields={source:input.source,scope,sourcePolicy,permission,authorityId:optout.authorityId,authoritySha256:optout.authoritySha256,optOutSnapshotSha256:optout.sha256};
 const receipt=PolicyReceiptSchema.parse({version:POLICY_RECEIPT_VERSION,...fields,checkedAt:input.checkedAt,expiresAt:input.expiresAt,policySnapshotSha256:semanticHash(fields)});
 if(Date.parse(receipt.checkedAt)>Date.now()||Date.parse(receipt.expiresAt)<=Date.now())throw Error('Current policy receipt clock invalid');
 return {receipt,receiptSha256:semanticHash(receipt),snapshotSha256:receipt.policySnapshotSha256};
}
/** Rechecking keeps original generation policy/provenance immutable; caller stores new execution receipt separately. */
export async function recheckPolicyReceipt(input:unknown,options:CivicPolicyOptions&{evaluationAt:string;currentProof?:unknown}):Promise<PolicyRecheckResult> {
 const receipt=PolicyReceiptSchema.parse(input),current=options.currentProof===undefined?receipt:PolicyReceiptSchema.parse(options.currentProof),evaluationAt=z.iso.datetime().parse(options.evaluationAt);
 if(receipt.authorityId!==(options.authorityId??CIVIC_POLICY_AUTHORITY_ID)||receipt.authorityId!==CIVIC_POLICY_AUTHORITY_ID&&(!options.authorityId||!options.authoritySha256))throw Error('Receipt authority is not the explicitly authorized policy realm');
 if(semanticHash(current.source)!==semanticHash(receipt.source)||semanticHash(current.scope)!==semanticHash(receipt.scope))throw Error('Current admissibility proof changes original source or scope');
 if(current.authorityId!==receipt.authorityId||current.authoritySha256!==receipt.authoritySha256||options.authorityId!==undefined&&options.authorityId!==receipt.authorityId||options.authoritySha256!==undefined&&options.authoritySha256!==receipt.authoritySha256)throw Error('Policy authority cannot change during receipt revalidation');
 const authorityOptions:CivicPolicyOptions={stateDir:options.stateDir,authorityId:receipt.authorityId,authoritySha256:receipt.authoritySha256};
 if(Date.parse(evaluationAt)<Date.parse(current.checkedAt)||Date.parse(evaluationAt)>=Date.parse(current.expiresAt))throw Error('Policy receipt expired; source revalidation required');
 if(Math.abs(Date.now()-Date.parse(evaluationAt))>60_000)throw Error('Current policy check cannot use a historical clock');
 assertSharedAdmission(current);await assertHostNotOptedOut(current.source.url,authorityOptions);
 const optout=await readCivicOptOutSnapshot(authorityOptions);await assertHostNotOptedOut(current.source.url,authorityOptions);
 if(optout.authorityId!==receipt.authorityId||optout.authoritySha256!==receipt.authoritySha256)throw Error('Current policy authority differs from original authority');
 return {receipt,receiptSha256:semanticHash(receipt),admissibilityReceiptSha256:semanticHash(current),optOutSnapshotSha256:optout.sha256,snapshotSha256:semanticHash({source:current.source,scope:current.scope,sourcePolicy:current.sourcePolicy,permission:current.permission,authorityId:optout.authorityId,authoritySha256:optout.authoritySha256,optOutSnapshotSha256:optout.sha256})};
}
export async function loadPolicyReceipt(cas:{read:(hash:string)=>Promise<Uint8Array>},hash:string):Promise<PolicyReceipt> {
 HashSchema.parse(hash);
 const receipt=PolicyReceiptSchema.parse(JSON.parse(Buffer.from(await cas.read(hash)).toString('utf8')));
 if(semanticHash(receipt)!==hash)throw Error('Policy receipt CAS binding mismatch');
 return receipt;
}
