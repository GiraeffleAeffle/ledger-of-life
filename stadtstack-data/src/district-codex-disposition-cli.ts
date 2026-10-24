// Explicit lead action only. Does not resume/authorize jobs or call a provider.
import {Pool} from 'pg';
import {z} from 'zod';
import {HashSchema} from './district-adapter-contract.ts';
import {readCodexUnsettledRecord,registerCodexUnsettledRetry} from './district-codex-disposition.ts';
const RequestSchema=z.object({recordId:z.string(),recordSha256:HashSchema}).strict();
async function main(){
 if(process.argv.length!==2||!process.env.DATABASE_URL)throw Error('Explicit database and stdin record pin required');
 process.umask(0o077);let size=0;const chunks:Buffer[]=[];
 for await(const chunk of process.stdin){size+=chunk.length;if(size>8192)throw Error('Disposition request exceeds bound');chunks.push(chunk);}
 const request=RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))),pinned=await readCodexUnsettledRecord(request.recordId,request.recordSha256);
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10000,statement_timeout:30000});
 try{const proof=await registerCodexUnsettledRetry(pool,{recordBytes:pinned.bytes,recordSha256:pinned.sha256});process.stdout.write(JSON.stringify({version:'r1-codex-unsettled-retry-registration-v1',disposition:proof,jobChanged:false,providerCalled:false,refunded:false})+'\n');}finally{await pool.end();}
}
main().catch(()=>{process.stderr.write('R1_FAILURE phase=execution code=CODEX_UNSETTLED_RETRY_REFUSED\n');process.exitCode=2;});
