import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {parseR1RegistryArguments} from '../src/district-r1.ts';
import {DistrictDatabaseConnectionLost} from '../src/district-database.ts';
import {NativeAssessmentBEnqueueManifestSchema,readNativeAssessmentBManifest} from '../src/district-r1-assessment-cli.ts';

const manifest={jobs:[{transport:'vm-omp',itemArtifactSha256:'a'.repeat(64),policyProofSha256:'b'.repeat(64),sourceScope:{publisherId:'fixture-publisher',sourceId:'fixture-source',municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'2026-10-11'}}]};

test('native operator manifest remains exact across split stdin chunks',async()=>{
 const bytes=Buffer.from(JSON.stringify(manifest));
 assert.deepEqual(await readNativeAssessmentBManifest(Readable.from([bytes.subarray(0,17),bytes.subarray(17)]),new AbortController().signal),manifest);
 for(const extra of [{transport:'mac-bridge',clientContractSha256:'c'.repeat(64)},{requestedModel:'claude-haiku-5-5'},{requestedModel:'claude-sonnet-5-5'}]){
  assert.throws(()=>NativeAssessmentBEnqueueManifestSchema.parse({jobs:[{...manifest.jobs[0],...extra}]}));
 }
});

test('native operator manifest rejects oversized stdin without truncating it',async()=>{
 await assert.rejects(readNativeAssessmentBManifest(Readable.from([Buffer.alloc(4*1024*1024+1)]),new AbortController().signal),/Operator manifest too large/);
});

test('database shutdown interrupts a blocked native manifest read',async()=>{
 const input=new Readable({read(){}}),controller=new AbortController();
 const reading=readNativeAssessmentBManifest(input,controller.signal);controller.abort();
 await assert.rejects(reading,DistrictDatabaseConnectionLost);assert.equal(input.destroyed,true);
});

test('separate native CLI help and invalid commands need no registry, authority or database',()=>{
 const entry=fileURLToPath(new URL('../src/district-r1-assessment-cli.ts',import.meta.url));
 const invoke=(command:string)=>spawnSync(process.execPath,[entry,command],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',DATABASE_URL:''},timeout:10000});
 const help=invoke('--help');assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/anthropic\/claude-sonnet-5-5/);assert.match(help.stdout,/vm-omp only/);
 const usage=help.stdout.split('\n')[0].replace(/^Usage: /,'').replace(/ \[bounded JSON stdin\]$/,'');
 assert.ok(readFileSync(new URL('../README.md',import.meta.url),'utf8').includes('`node src/'+usage+'`'));
 const documented=usage.split(' ').slice(2).map(value=>value==='DESCRIPTOR_PATH'?'/tmp/registry-descriptor.json':value==='HASH'?'a'.repeat(64):value);
 assert.deepEqual(parseR1RegistryArguments(documented),{registryPin:{path:'/tmp/registry-descriptor.json',sha256:'a'.repeat(64)},args:[]});
 const invalid=invoke('not-a-command');assert.equal(invalid.status,2);assert.equal(invalid.stdout,'');assert.equal(invalid.stderr,'R1_FAILURE phase=startup code=R1_COMMAND_FAILED\n');
});
