import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ParserIsolationReasonSchema} from '../src/district-parser-isolation.ts';

test('fixed parser worker classifies refusal and Node heap failures without exporting stderr',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-S','-c',`
import importlib.util, json, sys
spec=importlib.util.spec_from_file_location('private_worker', sys.argv[1])
worker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
policy='/opt/stadtstack/src/district-policy-inspection-worker.ts'
cases=[
 ('node',[policy],64,b'PRIVATE_SOURCE'),
 ('node',['/another/worker.ts'],64,b'PRIVATE_SOURCE'),
 ('node',[policy],1,b'PRIVATE_SOURCE'),
 ('node',[policy],-6,b'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory PRIVATE_SOURCE'),
 ('python3',[],1,b'FATAL ERROR: heap out of memory PRIVATE_SOURCE'),
 ('node',[policy],1,b'heap out of memory PRIVATE_SOURCE'),
]
print(json.dumps([worker.command_failure_reason(*case) for case in cases]))
`,fileURLToPath(new URL('../src/district-parser-worker.py',import.meta.url))],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),['request_rejected','command_failed','command_failed','heap_limit','command_failed','command_failed']);
 assert.equal(result.stdout.includes('PRIVATE_SOURCE'),false);
 assert.equal(ParserIsolationReasonSchema.safeParse('heap_limit').success,true);
 assert.equal(ParserIsolationReasonSchema.safeParse('deadline').success,true);
 assert.equal(ParserIsolationReasonSchema.safeParse('PRIVATE_SOURCE').success,false);
});
