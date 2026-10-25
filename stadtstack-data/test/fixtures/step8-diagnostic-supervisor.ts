import assert from 'node:assert/strict';
import {userInfo} from 'node:os';
import {randomUUID} from 'node:crypto';
import {superviseReconstructionWorker} from '../../src/r1-step8-worker-supervisor.ts';

const url=new URL(process.env.DISTRICT_TEST_DATABASE_URL!),host=url.searchParams.get('host');
assert.notEqual(url.pathname,'/civic_r1');assert.ok(host?.startsWith('/tmp/'));
const mode=process.argv[2];assert.ok(['error','exit','heap','success'].includes(mode));
const connection={host:host!,database:decodeURIComponent(url.pathname.slice(1)),user:userInfo().username,port:Number(url.searchParams.get('port')||5432)};
await superviseReconstructionWorker({nonce:randomUUID(),indices:[0],connection,mode},new URL('./step8-diagnostic-thread.ts',import.meta.url));
