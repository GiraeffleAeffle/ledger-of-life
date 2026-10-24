import {z} from 'zod';
import {createHash} from 'node:crypto';
import {REGIONAL_EXCERPT_LIMITS} from '../regional/statements.mjs';
import {withParserSandbox} from './district-parser-isolation.ts';
import {MAX_DOCUMENT_BYTES} from './district-document.ts';
import {REGIONAL_STATEMENT_WORKER_VERSION} from './district-regional-statement-worker.ts';
import {sourcedStatementInput,statementEvidenceSchema,type RegionalStatementSnapshot} from './regional-statement.ts';

const statementResultSchema=z.object({version:z.literal(REGIONAL_STATEMENT_WORKER_VERSION),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),statement:z.string().min(1).max(REGIONAL_EXCERPT_LIMITS.statementCharacters),statementEvidence:z.array(statementEvidenceSchema).min(1).max(REGIONAL_EXCERPT_LIMITS.quotes)}).strict();
/** Binds a pinned parser result; this does not replace original-byte verification. */
export function assertRegionalStatementResult(input:unknown,result:unknown):void {
 const item=sourcedStatementInput.parse(input),actual=statementResultSchema.parse(result);
 if(!item.statement||!item.statementEvidence)throw Error('Regional statement source verification requires excerpts');
 const expected=item.statementEvidence[0].sourceSha256;
 if(actual.sourceSha256!==expected||actual.statement!==item.statement||actual.statementEvidence.length!==item.statementEvidence.length||actual.statementEvidence.some((evidence,index)=>evidence.sourceSha256!==expected||evidence.quote!==item.statementEvidence![index].quote))throw Error('Regional statement excerpts do not match source snapshot');
}
/** The shape contract alone is not source verification; publication must check actual retained bytes. */
export async function verifyRegionalStatementSnapshot(input:unknown,snapshot:RegionalStatementSnapshot):Promise<void> {
 const item=sourcedStatementInput.parse(input);
 if(!item.statement||!item.statementEvidence)throw Error('Regional statement source verification requires excerpts');
 if(snapshot.url!==item.url)throw Error('Regional statement source URL mismatch');
 const sourceSha256=item.statementEvidence[0].sourceSha256;
 if(snapshot.bytes.byteLength===0||snapshot.bytes.byteLength>MAX_DOCUMENT_BYTES)throw Error('Regional statement source size limit');
 if(createHash('sha256').update(snapshot.bytes).digest('hex')!==sourceSha256)throw Error('Regional statement source hash mismatch');
 if(!snapshot.sourceContext?.bindings.some(binding=>'kind' in binding&&binding.kind==='http_observation'&&binding.url===snapshot.url&&binding.sourceSha256===sourceSha256))throw Error('Regional statement requires genuine original HTTP source custody');
 const sourceBase64=Buffer.from(snapshot.bytes.buffer,snapshot.bytes.byteOffset,snapshot.bytes.byteLength).toString('base64');
 const request=Buffer.from(JSON.stringify({version:REGIONAL_STATEMENT_WORKER_VERSION,sourceSha256,sourceBase64,anchors:item.statementEvidence.map(evidence=>evidence.quote)}));
 const output=await withParserSandbox(request,sandbox=>sandbox.run('node',['--experimental-strip-types','/opt/stadtstack/src/district-regional-statement-worker.ts','/input/document']),snapshot.sourceContext);
 assertRegionalStatementResult(item,JSON.parse(output.stdout));
}
