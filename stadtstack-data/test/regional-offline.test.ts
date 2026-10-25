import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';

const run=promisify(execFile);
const entrypoint=new URL('../regional/build.mjs',import.meta.url);
test('legacy regional entrypoint rejects absent and live-mode arguments without network access',async()=>{
 for(const args of [[],['--live'],['--offline','--live']]){
  // Exercise the module-loading boundary only after installing the network sentinel and CLI arguments.
  const script=`let requests=0;globalThis.fetch=async()=>{requests++;throw Error('Unexpected network call')};process.argv=['node','build.mjs',...${JSON.stringify(args)}];try{await import(${JSON.stringify(entrypoint.href)});console.log(JSON.stringify({requests,accepted:true}));}catch(error){console.log(JSON.stringify({requests,error:error.message}));}`;
  const {stdout}=await run(process.execPath,['--input-type=module','--eval',script]);
  const result=JSON.parse(stdout);assert.equal(result.requests,0);assert.match(result.error,/offline-only/);assert.equal(result.accepted,undefined);
 }
});
test('legacy collector has no raw fetch, cache refresh or robots acquisition implementation',async()=>{
 const source=await readFile(entrypoint,'utf8');
 assert.doesNotMatch(source,/\bfetch\s*\(|\bcheckRobots\b|\bmaxAge\b|\bLast-good cache\b/);
 assert.match(source,/No offline snapshot/);
 assert.match(source,/return await readFile\(file, 'utf8'\)/);
});
