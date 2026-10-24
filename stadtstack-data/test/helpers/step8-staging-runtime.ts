export const STAGING_FIXTURE_CHILD_MS=90*60*1000;
export const STAGING_FIXTURE_KILL_GRACE_MS=60*1000;
export const STAGING_FIXTURE_CLEANUP_GRACE_MS=120*1000;
export const STAGING_FIXTURE_OUTER_MS=STAGING_FIXTURE_CHILD_MS+STAGING_FIXTURE_CLEANUP_GRACE_MS;
export const STAGING_FIXTURE_SELECTION_MS=4*60*60*1000;
export const STAGING_FIXTURE_PLANNING={estimatedDurationSeconds:STAGING_FIXTURE_CHILD_MS/1000,expiryMarginSeconds:10*60} as const;
const phases=['fixture-setup','native-import','native-queue','retained-plan','retained-import','standalone-audit','embedded-audit','execute','loader-and-evidence','tamper-refusal'] as const;
type Phase=typeof phases[number];
export interface StagingFixturePhase {phase:Phase;event:'started'|'completed';elapsedMs:number}
export const STAGING_FIXTURE_PHASE_PREFIX='REAL_RETAINED_STEP8_PHASE ';
const started=performance.now();
export function markStagingFixturePhase(phase:Phase,event:StagingFixturePhase['event']){
 if(process.env.R1_TEST_STEP8_STAGING==='1')console.log(STAGING_FIXTURE_PHASE_PREFIX+JSON.stringify({phase,event,elapsedMs:Math.round(performance.now()-started)}));
}
export function parseStagingFixturePhase(line:string):StagingFixturePhase|undefined{
 if(!line.startsWith(STAGING_FIXTURE_PHASE_PREFIX)||line.length>512)return;
 try{
  const value=JSON.parse(line.slice(STAGING_FIXTURE_PHASE_PREFIX.length));
  if(value&&phases.includes(value.phase)&&['started','completed'].includes(value.event)&&Number.isSafeInteger(value.elapsedMs)&&value.elapsedMs>=0)return {phase:value.phase,event:value.event,elapsedMs:value.elapsedMs};
 }catch{/* Non-phase stdout remains ordinary subprocess output. */}
}
export function stagingFixtureFailure(error:unknown,elapsedMs:number,lastPhase?:StagingFixturePhase){
 const value=error&&typeof error==='object'?error as {code?:unknown;signal?:unknown;killed?:unknown}:{};
 const code=typeof value.code==='number'&&Number.isSafeInteger(value.code)?value.code:typeof value.code==='string'&&/^(?:ERR_[A-Z_]{1,64}|E[A-Z]{1,32})$/.test(value.code)?value.code:null;
 const signal=typeof value.signal==='string'&&/^SIG[A-Z0-9]{1,16}$/.test(value.signal)?value.signal:null;
 return {schemaVersion:'r1-staging-fixture-failure-v1',code,signal,killed:value.killed===true,elapsedMs:Math.max(0,Math.round(elapsedMs)),lastPhase:lastPhase??null};
}
