import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {dirname,resolve} from 'node:path';
import {OMP_NATIVE_STREAM_VERSION} from './district-omp-b-runner.ts';
import {HashSchema} from './district-adapter-contract.ts';

export const STEP8_STRUCTURED_RUN_IDS=['3fe33cb6-fb63-4151-b56d-e94271c0d0af','6a60345b-850c-4130-9105-aa6b89e99cf3','f311d068-1f14-47f2-856f-d3213098821a','5f582f17-d494-4fd5-8aea-a6c7a2a22dcc','329d949b-e87f-4942-98d2-767188cf1947'] as const;
export const STEP8_PRIOR_RELEASE={gitCommit:'57bddbbd8b84b0634229ad9cd45b689bda7271ea',directory:'release' as const,manifestSha256:'85b9236328402364ee1211ffe274933d3eaf0ff52c976a39720920337cc866b8',releaseId:'4ceebf75374df54c51bcf4a212c73770186a1a6db502423be7f108b665096691'};
const pin=z.object({path:z.string().refine(isAbsolute),sha256:HashSchema}).strict();
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
