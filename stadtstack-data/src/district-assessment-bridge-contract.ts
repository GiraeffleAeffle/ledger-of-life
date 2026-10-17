import {z} from 'zod';
import {HashSchema,canonicalJson,digest} from './district-adapter-contract.ts';
import {ASSESSMENT_CONTEXT_BYTES} from './district-assessment-context.ts';

export const ASSESSMENT_BRIDGE_VERSION='district-assessment-bridge-v1';
export const NATIVE_B_BRIDGE_VERSION='district-assessment-native-b-v2';
/** Short renewable ownership, bounded independently of slow managed staging. */
export const NATIVE_B_LIFECYCLE_LIMITS=Object.freeze({leaseMs:120000,heartbeatMs:10000,maxLifecycleMs:20*60*1000});
export const BRIDGE_LIMITS=Object.freeze({requestBytes:512*1024,responseBytes:256*1024,evidenceContextBytes:24000,leaseMs:120000,heartbeatMs:10000,maxLeaseMs:300000});
export const ASSESSMENT_BRIDGE_SSH_HOST='codex-workstation';
export const ASSESSMENT_BRIDGE_REMOTE_COMMAND="bash -lc 'export DATABASE_URL=\"postgresql:///civic_r1?host=/var/run/postgresql\"; exec node --experimental-strip-types /home/max/civic-rebuild-r1/stadtstack-data/src/district-assessment-broker.ts'";
export const BridgeLeaseSchema=z.object({version:z.literal(ASSESSMENT_BRIDGE_VERSION),leaseId:z.uuid(),jobKey:HashSchema,inputSha256:HashSchema,authorityId:z.string().min(1),authoritySha256:HashSchema,policySnapshotSha256:HashSchema,expiresAt:z.iso.datetime(),role:z.literal('B'),provider:z.literal('anthropic-subscription'),requestedModel:z.literal('claude-haiku-5-5'),system:z.string().max(8000),data:z.unknown(),outputSchema:z.unknown(),clientContractSha256:HashSchema}).strict().superRefine((lease,ctx)=>{
 if(Buffer.byteLength(canonicalJson(lease.data))>ASSESSMENT_CONTEXT_BYTES)ctx.addIssue({code:'custom',message:'Assessment context exceeds shared governed bound'});
 if(lease.inputSha256!==bridgeInputHash(lease))ctx.addIssue({code:'custom',message:'Bridge input binding mismatch'});
});
export type BridgeLease=z.infer<typeof BridgeLeaseSchema>;
export function bridgeInputHash(input:Pick<BridgeLease,'jobKey'|'authorityId'|'authoritySha256'|'policySnapshotSha256'|'role'|'provider'|'requestedModel'|'system'|'data'|'outputSchema'|'clientContractSha256'>):string{
 const {jobKey,authorityId,authoritySha256,policySnapshotSha256,role,provider,requestedModel,system,data,outputSchema,clientContractSha256}=input;
 return digest(canonicalJson({version:ASSESSMENT_BRIDGE_VERSION,jobKey,authorityId,authoritySha256,policySnapshotSha256,role,provider,requestedModel,system,data,outputSchema,clientContractSha256}));
}
export function nativeBInputHash(input:Omit<Parameters<typeof bridgeInputHash>[0],'requestedModel'>&{requestedModel:'claude-sonnet-5-5'}):string{
 const {jobKey,authorityId,authoritySha256,policySnapshotSha256,role,provider,requestedModel,system,data,outputSchema,clientContractSha256}=input;
 if(requestedModel!=='claude-sonnet-5-5')throw Error('Native B input model binding failed');
 return digest(canonicalJson({version:NATIVE_B_BRIDGE_VERSION,jobKey,authorityId,authoritySha256,policySnapshotSha256,role,provider,requestedModel,system,data,outputSchema,clientContractSha256}));
}
export const BridgePurgeAckSchema=z.object({sourceFiles:z.literal(0),responseFiles:z.literal(0),modelFileWritesDenied:z.literal(true),completedAt:z.iso.datetime()}).strict();
export const BridgeAnswerSchema=z.object({stdout:z.string().min(1).max(96*1024),evidence:z.object({provider:z.literal('anthropic-subscription'),tool:z.literal('claude-cli'),toolVersion:z.string().min(1).max(200),model:z.literal('claude-haiku-5-5'),modelIdentitySha256:HashSchema,modelIdentityBasis:z.literal('reported-cli-model-and-tool-version')}).strict(),startedAt:z.iso.datetime(),finishedAt:z.iso.datetime()}).strict().refine(value=>Buffer.byteLength(value.stdout)<=96*1024&&Date.parse(value.startedAt)<=Date.parse(value.finishedAt),'Bridge provider stream bounds or clocks invalid');
export type BridgeAnswer=z.infer<typeof BridgeAnswerSchema>;
export const BridgeRequestSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('claim'),jobKey:HashSchema,clientId:z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),clientContractSha256:HashSchema}).strict(),
 z.object({operation:z.literal('check'),leaseId:z.uuid(),inputSha256:HashSchema}).strict(),
 z.object({operation:z.literal('submit'),leaseId:z.uuid(),inputSha256:HashSchema,purgeAck:BridgePurgeAckSchema,answer:BridgeAnswerSchema}).strict(),
 z.object({operation:z.literal('abandon'),leaseId:z.uuid(),inputSha256:HashSchema,purgeAck:BridgePurgeAckSchema,reason:z.enum(['lease_expired','authority_changed','provider_failed','client_disconnected'])}).strict(),
]);
export type BridgeRequest=z.infer<typeof BridgeRequestSchema>;
export const BridgeStatusSchema=z.object({version:z.literal(ASSESSMENT_BRIDGE_VERSION),state:z.enum(['active','held','expired','cancelled','submitted']),leaseId:z.uuid(),inputSha256:HashSchema,expiresAt:z.iso.datetime(),authoritySha256:HashSchema,policySnapshotSha256:HashSchema,receiptSha256:HashSchema.nullable(),purgeAckSha256:HashSchema.nullable()}).strict();
export type BridgeStatus=z.infer<typeof BridgeStatusSchema>;
