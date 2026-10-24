import test from 'node:test';
import assert from 'node:assert/strict';
import {STAGING_FIXTURE_CHILD_MS,STAGING_FIXTURE_KILL_GRACE_MS,STAGING_FIXTURE_CLEANUP_GRACE_MS,STAGING_FIXTURE_OUTER_MS,STAGING_FIXTURE_SELECTION_MS,STAGING_FIXTURE_PLANNING,STAGING_FIXTURE_PHASE_PREFIX,markStagingFixturePhase,parseStagingFixturePhase,stagingFixtureFailure} from './helpers/step8-staging-runtime.ts';

test('heavy retained fixture has bounded execution, escalation, cleanup and genuine authorization headroom',()=>{
 assert.equal(STAGING_FIXTURE_CHILD_MS,90*60*1000);
 assert.ok(STAGING_FIXTURE_CLEANUP_GRACE_MS>=120000);
 assert.ok(STAGING_FIXTURE_KILL_GRACE_MS>0&&STAGING_FIXTURE_KILL_GRACE_MS<STAGING_FIXTURE_CLEANUP_GRACE_MS);
 assert.equal(STAGING_FIXTURE_OUTER_MS,STAGING_FIXTURE_CHILD_MS+STAGING_FIXTURE_CLEANUP_GRACE_MS);
 assert.equal(STAGING_FIXTURE_PLANNING.estimatedDurationSeconds*1000,STAGING_FIXTURE_CHILD_MS);
 assert.ok(STAGING_FIXTURE_SELECTION_MS>STAGING_FIXTURE_OUTER_MS+STAGING_FIXTURE_PLANNING.expiryMarginSeconds*1000);
});
test('live phase projection is bounded and rejects invented progress',()=>{
 const phase={phase:'execute',event:'started',elapsedMs:123};
 assert.deepEqual(parseStagingFixturePhase(STAGING_FIXTURE_PHASE_PREFIX+JSON.stringify({...phase,sourceBody:'not forwarded'})),phase);
 for(const line of ['ordinary output',STAGING_FIXTURE_PHASE_PREFIX+'invalid',STAGING_FIXTURE_PHASE_PREFIX+JSON.stringify({...phase,phase:'invented'}),STAGING_FIXTURE_PHASE_PREFIX+JSON.stringify({...phase,elapsedMs:-1}),STAGING_FIXTURE_PHASE_PREFIX+'x'.repeat(513)])assert.equal(parseStagingFixturePhase(line),undefined);
});
test('subprocess failure retains exit, signal, kill and last phase without arbitrary error text',()=>{
 const error=Object.assign(Error('secret source body'),{code:143,signal:'SIGTERM',killed:true,stdout:'secret source body',stderr:'secret connection'}),lastPhase={phase:'execute' as const,event:'started' as const,elapsedMs:900};
 const details=stagingFixtureFailure(error,1000.4,lastPhase);
 assert.deepEqual(details,{schemaVersion:'r1-staging-fixture-failure-v1',code:143,signal:'SIGTERM',killed:true,elapsedMs:1000,lastPhase});
 assert.ok(!JSON.stringify(details).includes('secret'));
 assert.equal(stagingFixtureFailure({code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'},1).code,'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
 assert.deepEqual(stagingFixtureFailure({code:'https://secret/',signal:'secret'},2),{schemaVersion:'r1-staging-fixture-failure-v1',code:null,signal:null,killed:false,elapsedMs:2,lastPhase:null});
});
test('phase markers are emitted only for the explicit retained fixture mode',t=>{
 const previous=process.env.R1_TEST_STEP8_STAGING,lines:string[]=[];t.mock.method(console,'log',(line:string)=>lines.push(line));
 try{
  delete process.env.R1_TEST_STEP8_STAGING;markStagingFixturePhase('native-import','started');assert.equal(lines.length,0);
  process.env.R1_TEST_STEP8_STAGING='1';markStagingFixturePhase('native-import','started');assert.equal(lines.length,1);assert.equal(parseStagingFixturePhase(lines[0])?.phase,'native-import');
 }finally{if(previous===undefined)delete process.env.R1_TEST_STEP8_STAGING;else process.env.R1_TEST_STEP8_STAGING=previous;}
});
