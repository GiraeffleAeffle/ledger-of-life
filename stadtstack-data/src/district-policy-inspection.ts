import {z} from 'zod';
import {digest} from './district-adapter-contract.ts';
import {withParserSandbox,assertParserSandboxRepresentation,type ParserSourceContext,type ParserSandbox} from './district-parser-isolation.ts';
import type {ResourcePolicyInspection} from './source-policy.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const evidence=z.object({url:z.url(),locator:z.string(),value:z.string(),sha256:hash.optional(),checkedAt:z.string().optional(),valueSha256:hash.optional(),valueBytes:z.number().int().nonnegative().optional(),locatorSha256:hash.optional(),locatorBytes:z.number().int().nonnegative().optional(),itemCount:z.number().int().nonnegative().optional()}).strict();
const resultSchema=z.object({reservation:z.union([z.literal(0),z.literal(1),z.null()]),evidence:z.array(evidence).max(64),access:z.enum(['public','authentication','captcha','paywall']),unavailable:z.boolean(),referenceUnavailable:z.boolean(),declarationUnavailable:z.boolean()}).strict();
/** Reuse the canonical rules inside the fixed worker; this host boundary never parses downloaded HTML. */
export async function inspectResourcePolicySandbox(url:string,headers:Record<string,string|undefined>,body:Buffer,mimeType:string,context:ParserSourceContext,sandbox?:ParserSandbox):Promise<ResourcePolicyInspection>{
 const sourceSha256=digest(body);
 if(context.purpose!=='classification'||!context.bindings.some(binding=>binding.url===url&&'sourceSha256' in binding&&binding.sourceSha256===sourceSha256))throw Error('Resource policy inspection requires source-only binding');
 if(sandbox)assertParserSandboxRepresentation(sandbox,sourceSha256,context);
 const selected:Record<string,string>={};
 for(const name of ['tdm-reservation','tdm-policy','x-robots-tag'])if(headers[name]!==undefined)selected[name]=headers[name]!;
 const inspect=async(sandbox:ParserSandbox)=>{
  const output=(await sandbox.run('node',['--experimental-strip-types','/opt/stadtstack/src/district-policy-inspection-worker.ts','resource',JSON.stringify({url,headers:selected,mimeType})])).stdout;
  const result=resultSchema.parse(JSON.parse(output));
  if(result.evidence.some(item=>item.url!==url))throw Error('Resource policy evidence source mismatch');
  return result;
 };
 // The caller may reuse only the sandbox for these exact bytes and bindings.
 return sandbox?inspect(sandbox):withParserSandbox(body,inspect,context);
}
