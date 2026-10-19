import assert from 'node:assert/strict';
import {userInfo} from 'node:os';
import {superviseReconstructionWorker} from '../../src/r1-step8-worker-supervisor.ts';

const url=new URL(process.env.DISTRICT_TEST_DATABASE_URL!),host=url.searchParams.get('host');
assert.notEqual(url.pathname,'/civic_r1');assert.ok(host?.startsWith('/tmp/'));assert.equal(process.argv.length,3);
const connection={host:host!,database:decodeURIComponent(url.pathname.slice(1)),user:userInfo().username,port:Number(url.searchParams.get('port')||5432)};
await superviseReconstructionWorker({connection,marker:process.argv[2]},new URL('./step8-busy-thread.ts',import.meta.url));
