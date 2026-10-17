import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {HashSchema} from './district-adapter-contract.ts';

export const STEP8_PROCESSING_COMMIT='355691be56a5fcc5a76d4993955ba089bde4a494';
export const STEP8_ASSESSMENT_QUEUE='0f8f88aaea6f4d1af62c0c4a3301f77d06ec584bc6e0b4ae24005aa964399ac9';
export const STEP8_NATIVE_B_CONTRACT='43539ee71a2dd9b906dea9ff5c4c09a2ba10b3e8fcb910147058b81a14f7223c';
export const STEP8_PROCESSING_REVIEW_SHA256='7847b1d05a3bc66238856590a0a5af23f62559044f18b402d00c77a64ffa729f';
export const STEP8_STRUCTURED_RUN_IDS=['3fe33cb6-fb63-4151-b56d-e94271c0d0af','6a60345b-850c-4130-9105-aa6b89e99cf3','f311d068-1f14-47f2-856f-d3213098821a','5f582f17-d494-4fd5-8aea-a6c7a2a22dcc','329d949b-e87f-4942-98d2-767188cf1947'] as const;
export const STEP8_PRIOR_RELEASE={gitCommit:'57bddbbd8b84b0634229ad9cd45b689bda7271ea',directory:'release' as const,manifestSha256:'85b9236328402364ee1211ffe274933d3eaf0ff52c976a39720920337cc866b8',releaseId:'4ceebf75374df54c51bcf4a212c73770186a1a6db502423be7f108b665096691'};
const pin=z.object({path:z.string().refine(isAbsolute),sha256:HashSchema}).strict();
/** Selection policy is distinct from historical receipt decoding and from replay's
 * current implementation manifest. A new processing approval requires a cutover. */
export const Step8CurrentGenerationSchema=z.object({
 processingCommit:z.literal(STEP8_PROCESSING_COMMIT),catalogue:pin,processingReview:pin,
 assessmentQueueContractSha256:HashSchema,projectionVersion:z.literal('assessment-source-record-v2'),
 B:z.object({jobContractSha256:HashSchema,receiptVersion:z.literal('assessment-receipt-v2'),
  selector:z.literal('anthropic/claude-sonnet-5-5'),transport:z.literal('vm-omp')}).strict(),
}).strict();
export type Step8CurrentGeneration=z.infer<typeof Step8CurrentGenerationSchema>;
