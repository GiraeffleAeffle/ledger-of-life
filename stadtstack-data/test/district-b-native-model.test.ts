import test from 'node:test';
import assert from 'node:assert/strict';
import {modelIdentitySha256,ModelEvidenceSchema,EMPTY_USAGE,type ModelAnswer} from '../src/district-model-contract.ts';
import {NATIVE_B_MODEL,NativeBModelEvidenceSchema,assertNativeBReceiptIdentity,assertNativeBResponseIdentity} from '../src/district-b-native-model.ts';
const identity={provider:'anthropic-subscription' as const,tool:'omp-cli' as const,toolVersion:'omp/0.0.0-synthetic-only',model:NATIVE_B_MODEL,modelIdentityBasis:'reported-cli-model-and-tool-version' as const};
const evidence={...identity,modelIdentitySha256:modelIdentitySha256(identity)};
const answer:ModelAnswer={value:{},responseSha256:'a'.repeat(64),returnedModel:NATIVE_B_MODEL,runtimeWarnings:[],evidence,requestedModel:NATIVE_B_MODEL,reportedModels:[NATIVE_B_MODEL],usage:EMPTY_USAGE};
test('native Sonnet identity admission is B-owned and does not widen legacy routes',()=>{
 assert.doesNotThrow(()=>assertNativeBResponseIdentity(answer));
 assert.equal(NativeBModelEvidenceSchema.safeParse(evidence).success,true);
 assert.equal(ModelEvidenceSchema.safeParse(evidence).success,false);
 for(const role of ['A','C'])assert.throws(()=>assertNativeBReceiptIdentity({role,provider:identity.provider,requestedModel:NATIVE_B_MODEL,returnedModel:NATIVE_B_MODEL,modelEvidence:evidence}));
 for(const model of ['claude-haiku-5-5','claude-sonnet-latest'])assert.throws(()=>assertNativeBResponseIdentity({...answer,returnedModel:model,reportedModels:[model]}));
 assert.throws(()=>assertNativeBResponseIdentity({...answer,returnedModel:null}));
 assert.throws(()=>assertNativeBResponseIdentity({...answer,reportedModels:[]}));
 assert.throws(()=>assertNativeBResponseIdentity({...answer,evidence:{...evidence,modelIdentitySha256:'b'.repeat(64)}}));
 assert.throws(()=>assertNativeBResponseIdentity({...answer,evidence:{...evidence,tool:'claude-cli'}}));
});
