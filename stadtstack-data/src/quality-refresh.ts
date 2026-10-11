import {realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {prepareKnowledgeMain} from './prepare-knowledge.ts';

/** Explicit pinned managed knowledge intake only; no live refresh or implicit prior-release copy. */
export async function qualityRefreshMain(argv:string[]){
 return prepareKnowledgeMain(argv);
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false)){
 try{console.log(JSON.stringify(await qualityRefreshMain(process.argv.slice(2))));}
 catch(error){console.error(error instanceof Error&&error.message.startsWith('Usage:')?error.message:'Managed knowledge refresh failed; inspect pinned input identities and current source authority');process.exitCode=1;}
}
