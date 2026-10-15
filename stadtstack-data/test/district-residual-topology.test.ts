import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
test('real residual queue handlers preserve an enrolled production-topology CAS', {skip:!process.env.DISTRICT_TEST_DATABASE_URL,timeout:910_000},async()=>{
 // This is runner/reporting isolation, not an authority gate; the child must
 // provision and pin its own real isolated-fixture authority before any seam.
 // The same fixture now includes managed full publication, all-member exact replay
 // and candidate-loader admission, not only the former seal/export boundary.
 const {NODE_TEST_CONTEXT:_parentTestContext,...env}=process.env;
 const result=await execute(process.execPath,['--experimental-strip-types','--experimental-test-module-mocks','--test','--test-reporter=tap',fileURLToPath(new URL('./fixtures/residual-production-topology.ts',import.meta.url))],{env,timeout:900_000,maxBuffer:4*1024*1024}).catch((error:unknown)=>{
  if(error instanceof Error&&'stdout' in error)throw new Error(error.message+'\n'+String(error.stdout),{cause:error});
  throw error;
 });
 assert.match(result.stdout,/# fail 0/);
});
