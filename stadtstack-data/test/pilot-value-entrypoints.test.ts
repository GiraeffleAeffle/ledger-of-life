import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const exec=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
// Deliberately omit database, custody, provider and credential environment settings.
const options={cwd:root,env:{PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1'},timeout:30000};
const modules=['evaluate-pilot-value.ts','district-assessment-jobs.ts','district-r1.ts','pilot-value-audit.ts'];
test('value evaluator, queue, audit and R1 entrypoints initialize in either import order',async()=>{
 for(const order of [modules,[...modules].reverse()]){
  const script=order.map(name=>`await import(${JSON.stringify(new URL('../src/'+name,import.meta.url).href)});`).join('\n');
  const result=await exec(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],options);
  assert.equal(result.stderr,'');
 }
});
test('value and R1 CLI help exits before production authority or model setup',async()=>{
 for(const name of ['evaluate-pilot-value.ts','district-r1.ts']){
  const result=await exec(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('../src/'+name,import.meta.url)),'--help'],options);
  assert.match(result.stdout,/Usage:/);assert.equal(result.stderr,'');
 }
});
