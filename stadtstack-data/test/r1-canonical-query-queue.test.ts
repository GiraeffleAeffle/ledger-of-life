import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanonicalQueryQueue} from '../src/r1-canonical-query-queue.ts';

test('parallel terminal loaders execute only one query at a time on the checked-out client',async()=>{
 let active=0,maximum=0;const calls:unknown[]=[];
 const queue=createCanonicalQueryQueue(async value=>{active++;maximum=Math.max(maximum,active);calls.push(value);await Promise.resolve();active--;return value;});
 assert.deepEqual(await Promise.all([queue.query('one'),queue.query('two'),queue.query('three')]),['one','two','three']);
 await queue.close();assert.equal(maximum,1);assert.deepEqual(calls,['one','two','three']);await assert.rejects(queue.query('late'),/closed/);
});
test('failure drains before checkout destruction; late branches never touch the client',async()=>{
 let fail!:()=>void;const first=new Promise<never>((_accept,reject)=>{fail=()=>reject(Error('actual query failure'));}),calls:unknown[]=[];
 const queue=createCanonicalQueryQueue(async value=>{calls.push(value);return first;});
 const one=queue.query('one'),two=queue.query('two'),settled=Promise.allSettled([one,two]);await Promise.resolve();
 fail();await queue.close();const result=await settled;
 assert.deepEqual(calls,['one']);assert.equal(result.every(value=>value.status==='rejected'&&value.reason.message==='actual query failure'),true);
 await assert.rejects(queue.query('late'),/closed/);assert.deepEqual(calls,['one']);
});
