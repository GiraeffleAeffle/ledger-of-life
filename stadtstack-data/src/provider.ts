import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cacheDir,hash,jsonFile,save} from './common.ts';
export interface ExtractionDraft {statement:string;nextStep:string;placeMentions?:string[]}
export interface LlmProvider {id:string;generateJson(prompt:string):Promise<ExtractionDraft>}
export const provider:LlmProvider={
 id:'codex:gpt-6-luna',
 async generateJson(prompt){
  const key=hash(prompt),cached=await jsonFile<ExtractionDraft>(join(cacheDir,'llm',key+'.json'));
  if(cached)return cached;
  const path=join(cacheDir,'llm',key+'.txt');await save(path,'');
  const run=spawnSync('codex',['exec','-m','gpt-6-luna','-s','read-only','--skip-git-repo-check','-o',path,prompt],{timeout:240000,encoding:'utf8'});
  if(run.status!==0)throw Error(`Codex failed: ${run.stderr.slice(-400)}`);
  const raw=await readFile(path,'utf8');
  const parsed=JSON.parse(raw.slice(raw.indexOf('{'),raw.lastIndexOf('}')+1)) as ExtractionDraft;
  if(typeof parsed.statement!=='string'||!parsed.statement.trim()||typeof parsed.nextStep!=='string')throw Error('Missing generated statement or next step');
  await save(join(cacheDir,'llm',key+'.json'),JSON.stringify(parsed));
  return parsed;
 }
};
