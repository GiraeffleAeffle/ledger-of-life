import {digest} from './district-adapter-contract.ts';
import {withParserSandbox,ParserIsolationError} from './district-parser-isolation.ts';
import {DocumentOriginSchema,DOCUMENT_ORIGIN_CLASSIFIER_VERSION} from './document-origin-contract.ts';
import type {DocumentOriginInput,DocumentOriginClassification} from './document-origin-contract.ts';
import type {ManagedSourceContext} from './civic-opt-out.ts';

export interface DocumentOriginOptions {scratch?:ManagedSourceContext}
/** Operational rules-v2 triage, not legal certification. All original-byte parsing stays in the worker. */
export async function classifyDocumentOrigin(input:DocumentOriginInput,options:DocumentOriginOptions={}):Promise<DocumentOriginClassification>{
 const sourceSha256=digest(input.bytes),context=options.scratch;
 if(!context||!context.bindings.some(binding=>binding.url===input.url&&binding.sourceSha256===sourceSha256))throw new ParserIsolationError('request_rejected');
 const {bytes:_bytes,...metadata}=input;
 return withParserSandbox(input.bytes,async sandbox=>{
  const output=(await sandbox.run('node',['--experimental-strip-types','/opt/stadtstack/src/district-policy-inspection-worker.ts','origin',JSON.stringify(metadata)])).stdout;
  const result=DocumentOriginSchema.parse(JSON.parse(output));
  if(result.url!==input.url||result.sha256!==sourceSha256||result.classifierVersion!==DOCUMENT_ORIGIN_CLASSIFIER_VERSION)throw Error('Origin inspection source/contract mismatch');
  return result;
 },{...context,purpose:'classification'});
}
