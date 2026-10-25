import {z} from 'zod';
import {modelIdentitySha256,type ModelAnswer} from './district-model-contract.ts';

/** Native lane B only. Legacy Mac/Haiku and A/C routes retain their frozen contract. */
export const NATIVE_B_MODEL='claude-sonnet-5-5';
export const NATIVE_B_SELECTOR='anthropic/claude-sonnet-5-5';
export const NATIVE_B_RECEIPT_VERSION='assessment-receipt-v2';
export const NativeBModelEvidenceSchema=z.object({
 provider:z.literal('anthropic-subscription'),tool:z.literal('omp-cli'),toolVersion:z.string().min(1).max(200),
 model:z.literal(NATIVE_B_MODEL),modelIdentitySha256:z.string().regex(/^[a-f0-9]{64}$/),
 modelIdentityBasis:z.literal('reported-cli-model-and-tool-version'),
}).strict();
export type NativeBModelEvidence=z.infer<typeof NativeBModelEvidenceSchema>;

export function assertNativeBReceiptIdentity(receipt:{role:string;provider:string;requestedModel:string;returnedModel:string|null;modelEvidence:unknown}):void{
 const evidence=NativeBModelEvidenceSchema.parse(receipt.modelEvidence);
 if(receipt.role!=='B'||receipt.provider!==evidence.provider||receipt.requestedModel!==NATIVE_B_MODEL
  ||receipt.returnedModel!==NATIVE_B_MODEL||evidence.modelIdentitySha256!==modelIdentitySha256(evidence))throw Error('Native B model identity binding failed');
}
export function assertNativeBResponseIdentity(answer:ModelAnswer):void{
 assertNativeBReceiptIdentity({role:'B',provider:answer.evidence.provider,requestedModel:answer.requestedModel,returnedModel:answer.returnedModel,modelEvidence:answer.evidence});
 if(!answer.reportedModels.includes(NATIVE_B_MODEL)||answer.reportedModels.some(model=>model!==NATIVE_B_MODEL))throw Error('Native B reported model mismatch');
}
