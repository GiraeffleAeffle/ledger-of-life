import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {dirname,resolve} from 'node:path';
import {OMP_NATIVE_STREAM_VERSION} from './district-omp-b-runner.ts';
import {HashSchema,canonicalJson,digest} from './district-adapter-contract.ts';
import {authenticateStructuredExecutionEvidence} from './r1-step8-structured-execution.ts';

export const STEP8_STRUCTURED_SOURCE_SCOPES=[['strausberg','regionalstatistik-genesis'],['hagenow','pegelonline']] as const;
export const STEP8_PRIOR_RELEASE={gitCommit:'57bddbbd8b84b0634229ad9cd45b689bda7271ea',directory:'release' as const,manifestSha256:'85b9236328402364ee1211ffe274933d3eaf0ff52c976a39720920337cc866b8',releaseId:'4ceebf75374df54c51bcf4a212c73770186a1a6db502423be7f108b665096691'};
const pin=z.object({path:z.string().refine(isAbsolute),sha256:HashSchema}).strict();
export const Step8StructuredSelectionSchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-step8-structured-selection-v1'),id:z.string().min(1),
 issuedBy:z.string().min(1),issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
 renewalAuthority:pin,ownerDecision:pin,runIds:z.array(z.uuid()).min(1).max(1000),
 receipts:z.array(z.object({runId:z.uuid(),sha256:HashSchema,step:z.enum(['structured_parse','structured_discover']),municipalityId:z.string().min(1),sourceId:z.string().min(1)}).strict()).min(1).max(1000),
 executionEvidence:pin.optional(),
}).strict();
/** Independently pinned issuance replaces the erroneous five-ID literal. This
 * checks authority and exact receipt selection, not source-policy currency. */
export async function authenticateStep8StructuredSelection(input:{selection:{path:string;sha256:string};runIds:readonly string[];readControl:(pin:{path:string;sha256:string})=>Promise<Uint8Array>;requiredThrough?:number}){
 const read=async(selected:{path:string;sha256:string})=>{pin.parse(selected);const bytes=Buffer.from(await input.readControl(selected));if(digest(bytes)!==selected.sha256)throw Error('Structured control digest mismatch');return JSON.parse(bytes.toString('utf8'));};
 const selection=Step8StructuredSelectionSchema.parse(await read(input.selection));
 const issued=(value:{issuedAt:string;expiresAt:string},label:string)=>{const issuedAt=Date.parse(z.iso.datetime().parse(value.issuedAt)),expiresAt=Date.parse(z.iso.datetime().parse(value.expiresAt));if(issuedAt>Date.now()||expiresAt<=Date.now()||expiresAt<=issuedAt||input.requiredThrough!==undefined&&expiresAt<=input.requiredThrough)throw Error(label+' unissued, future, expired or shorter than required horizon');};
 issued(selection,'Structured selection');
 if(new Set(selection.runIds).size!==selection.runIds.length||canonicalJson(selection.runIds)!==canonicalJson(input.runIds))throw Error('Structured selection changes exact ordered run IDs');
 if(new Set(selection.receipts.map(row=>row.sha256)).size!==selection.receipts.length||selection.runIds.some(id=>!selection.receipts.some(row=>row.runId===id))||selection.receipts.some(row=>!selection.runIds.includes(row.runId)))throw Error('Structured selection has duplicate, missing or extra receipt/run membership');
 const scopes=[...new Set(selection.receipts.map(row=>canonicalJson([row.municipalityId,row.sourceId])))].sort();
 if(canonicalJson(scopes)!==canonicalJson(STEP8_STRUCTURED_SOURCE_SCOPES.map(scope=>canonicalJson(scope)).sort()))throw Error('Structured selection must cover exactly the approved K1/K2 source scopes');
 const rawAuthority=await read(selection.renewalAuthority);
 const authority=z.object({schemaVersion:z.literal('stadtstack-r1-operator-action-record-v1'),id:z.string(),action:z.literal('fresh-exact-k1-k2-acquisition-and-structured-parse-for-step8'),issuedBy:z.string().min(1),issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),requiredOwnerDecision:z.string(),acquisition:pin,bounds:z.object({maxModelCalls:z.literal(0),paidMicroUsd:z.literal(0)}).passthrough()}).passthrough().parse(rawAuthority);
 const owner=z.object({schemaVersion:z.literal('stadtstack-r1-owner-approval-record-v1'),id:z.string(),issuedAt:z.iso.datetime(),approver:z.literal('Max (owner)'),ownerStatementsVerbatim:z.array(z.string().min(1)).min(1),approved:z.literal(true),request:z.object({action:z.string(),actionDraftSha256:HashSchema,acquisition:pin,bounds:z.record(z.string(),z.unknown()),expiresAt:z.iso.datetime()}).passthrough()}).passthrough().parse(await read(selection.ownerDecision));
 issued(authority,'Structured renewal authority');issued({issuedAt:owner.issuedAt,expiresAt:owner.request.expiresAt},'Structured owner decision');
 if(authority.requiredOwnerDecision!==owner.id||owner.request.action!==authority.action||owner.request.actionDraftSha256!==digest(JSON.stringify({...rawAuthority,issuedAt:''},null,2)+'\n')||canonicalJson(owner.request.acquisition)!==canonicalJson(authority.acquisition)||canonicalJson(owner.request.bounds)!==canonicalJson(authority.bounds)||authority.expiresAt!==owner.request.expiresAt||Date.parse(selection.expiresAt)>Date.parse(authority.expiresAt)||Date.parse(authority.issuedAt)<Date.parse(owner.issuedAt)||Date.parse(selection.issuedAt)<Date.parse(authority.issuedAt))throw Error('Structured selection changes approved renewal action/bounds or issuance order');
 if(selection.executionEvidence)await authenticateStructuredExecutionEvidence({evidence:selection.executionEvidence,baseAuthority:selection.renewalAuthority,selectionIssuedAt:selection.issuedAt,receipts:selection.receipts,readControl:input.readControl});
 return selection;
}
/** The catalogue's independently pinned confirmed review, not publication HEAD
 * or a window-specific code literal, supplies the admitting worker identities. */
export const Step8CurrentGenerationSchema=z.object({
 processingCommit:z.string().regex(/^[a-f0-9]{40}$/),catalogue:pin,processingReview:pin,
 assessmentQueueContractSha256:HashSchema,projectionVersion:z.literal('assessment-source-record-v2'),
 B:z.object({jobContractSha256:HashSchema,runnerContractSha256:HashSchema,runnerOutputContractSha256:HashSchema,
  nativeStreamVersion:z.literal(OMP_NATIVE_STREAM_VERSION),thinking:z.literal('medium'),receiptVersion:z.literal('assessment-receipt-v2'),
  selector:z.literal('anthropic/claude-sonnet-5-5'),transport:z.literal('vm-omp')}).strict(),
}).strict();
export type Step8CurrentGeneration=z.infer<typeof Step8CurrentGenerationSchema>;

export function assertStep8ProcessingPin(policy:Step8CurrentGeneration,rawCatalogue:unknown,rawReview:unknown){
 const catalogue=z.object({processingCodeRevision:z.string().regex(/^[a-f0-9]{7,40}$/),processingPinReview:z.object({path:z.string(),sha256:HashSchema}).passthrough()}).passthrough().parse(rawCatalogue);
 const review=z.object({activation:z.literal('confirmed'),to:z.object({commit:z.string().regex(/^[a-f0-9]{40}$/)}).passthrough(),contracts:z.object({
  current:z.object({assessmentQueue:HashSchema}).passthrough(),assessmentBJobContract:HashSchema,ompRunnerContract:HashSchema,ompRunnerOutputContract:HashSchema,
 }).passthrough()}).passthrough().parse(rawReview);
 if(!policy.processingCommit.startsWith(catalogue.processingCodeRevision)||review.to.commit!==policy.processingCommit
  ||catalogue.processingPinReview.sha256!==policy.processingReview.sha256
  ||resolve(dirname(policy.catalogue.path),catalogue.processingPinReview.path)!==resolve(policy.processingReview.path))throw Error('Inactive processing pin/catalogue');
 if(review.contracts.current.assessmentQueue!==policy.assessmentQueueContractSha256||review.contracts.assessmentBJobContract!==policy.B.jobContractSha256
  ||review.contracts.ompRunnerContract!==policy.B.runnerContractSha256||review.contracts.ompRunnerOutputContract!==policy.B.runnerOutputContractSha256)throw Error('Processing approval contract mismatch');
}

export function assertStep8NativeBStep(policy:Step8CurrentGeneration,spec:{semanticContractSha256:string;selector:unknown},versions:Readonly<Record<string,string>>){
 const selected=z.object({transport:z.literal('vm-omp'),requestedModel:z.literal('claude-sonnet-5-5'),runnerOutputContractSha256:HashSchema}).passthrough().safeParse(spec.selector);
 if(!selected.success||spec.semanticContractSha256!==policy.B.jobContractSha256||selected.data.runnerOutputContractSha256!==policy.B.runnerOutputContractSha256
  ||versions.runnerContractSha256!==policy.B.runnerContractSha256||versions.ompNativeStreamVersion!==policy.B.nativeStreamVersion
  ||versions.ompThinking!==policy.B.thinking||versions.ompOutputNormalization!==undefined)throw Error('Admitting B job is outside approved native Sonnet profile/stream');
}
