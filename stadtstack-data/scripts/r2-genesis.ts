import {mkdir,open} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {digest} from '../src/district-adapter-contract.ts';
import {genesisRequestPlan,genesisReleaseDraft} from '../src/r2-genesis-release.ts';
import {genesisPreflight,genesisMetadataReviewDraft,genesisEnqueue,genesisAcquire} from '../src/r2-genesis-executor.ts';
import {ZodError} from 'zod';
import {PoliteFetchError} from '../src/polite-fetch.ts';
import {ParserIsolationError} from '../src/district-parser-isolation.ts';
import {DistrictExecutionHold} from '../src/district-jobs.ts';

async function main(){
 const [command,...args]=process.argv.slice(2),flags:Record<string,string>={};
 if(command==='help'||command==='--help'){process.stdout.write('r2-genesis.ts prepare --output ABSOLUTE_DIRECTORY | preflight|metadata-review-draft|enqueue|acquire --authority-root PATH --release PATH --release-sha256 SHA [--metadata-review PATH --metadata-review-sha256 SHA] [--authorization-id UUID]\nNo issuance, resume, retry, MaStR or paid command exists. All effectful commands require a genuinely issued, committed GENESIS-only v3.\n');return;}
 const allowed=command==='prepare'?['--output']:['--authority-root','--release','--release-sha256',...(['enqueue','acquire'].includes(command)?['--metadata-review','--metadata-review-sha256']:[]),...(command==='acquire'?['--authorization-id']:[])];
 if(!['prepare','preflight','metadata-review-draft','enqueue','acquire'].includes(command)||args.length%2)throw Error('Unknown/bounded GENESIS command required');
 for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];if(!allowed.includes(key)||flags[key]||!value||value.startsWith('--'))throw Error('Unknown/duplicate GENESIS flag');flags[key]=value;}
 if(allowed.some(key=>!flags[key]))throw Error('Every explicit GENESIS command flag is required');
 if(command==='prepare'){
  const output=flags['--output'];if(!isAbsolute(output))throw Error('Absolute draft output required');
  const draft=await genesisReleaseDraft();await mkdir(output,{recursive:true,mode:0o700});
  const pins=[];for(const [name,value] of [['r2-genesis-31231-request-plan-v3.draft.json',genesisRequestPlan()],['r2-genesis-structured-security-release-v3.draft.json',draft]] as const){const bytes=JSON.stringify(value,null,2)+'\n',path=join(output,name),file=await open(path,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}pins.push({path,sha256:digest(bytes)});}process.stdout.write(JSON.stringify({unissued:true,pins})+'\n');return;
 }
 const release={path:flags['--release'],sha256:flags['--release-sha256']},authority=flags['--authority-root'],review={path:flags['--metadata-review'],sha256:flags['--metadata-review-sha256']};
 const result=command==='preflight'?await genesisPreflight(release,authority):command==='metadata-review-draft'?await genesisMetadataReviewDraft(release,authority):command==='enqueue'?await genesisEnqueue(release,authority,review):await genesisAcquire(release,authority,review,flags['--authorization-id']);
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
main().catch((error:unknown)=>{
 const code=error instanceof PoliteFetchError?'source_'+error.failure:error instanceof ParserIsolationError?'parser_'+error.reason:error instanceof DistrictExecutionHold?error.reasonCode:error instanceof ZodError?'control_schema_mismatch':'operator_precondition_or_execution';
 process.stderr.write('R2 GENESIS held code='+code+': inspect private local controls; no retry/resume is authorized.\n');process.exitCode=2;
});
