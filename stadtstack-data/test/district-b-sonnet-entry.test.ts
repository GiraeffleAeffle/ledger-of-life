import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {OMP_EXECUTION_ARGS} from '../src/district-execution-profile.ts';

test('reviewed image translates only the frozen bootstrap to effective Sonnet, preserving payload',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-sonnet-entry-'));
 try{
  await writeFile(join(directory,'omp'),'#!/bin/sh\n[ "$ANTHROPIC_OAUTH_TOKEN" = synthetic-test-only ] || exit 125\nprintf "%s\\n" "$@"\nprintf "%s\\n" ---payload---\ncat\n',{mode:0o700});
  const run=(args:string[])=>new Promise<{code:number|null;out:string;error:string}>((resolve,reject)=>{
   const child=spawn('/bin/sh',[fileURLToPath(new URL('../docker/omp-b/entry.sh',import.meta.url)),...args],{env:{PATH:directory+':/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});
   let out='',error='';child.stdout.on('data',bytes=>out+=String(bytes));child.stderr.on('data',bytes=>error+=String(bytes));child.on('error',reject);child.on('close',code=>resolve({code,out,error}));child.stdin.on('error',()=>{});child.stdin.end('synthetic-test-only\n{"synthetic":"payload"}');
  });
  const result=await run([...OMP_EXECUTION_ARGS]);assert.equal(result.code,0);assert.equal(result.error,'');
  assert.equal(result.out,[...OMP_EXECUTION_ARGS.slice(0,4),'anthropic/claude-sonnet-5-5',...OMP_EXECUTION_ARGS.slice(5),'---payload---','{"synthetic":"payload"}'].join('\n'));
  for(const selector of ['anthropic/claude-sonnet-5-5','anthropic/claude-haiku-latest']){
   const args=[...OMP_EXECUTION_ARGS];args[4]=selector;const rejected=await run(args);assert.equal(rejected.code,126);assert.equal(rejected.out,'');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
