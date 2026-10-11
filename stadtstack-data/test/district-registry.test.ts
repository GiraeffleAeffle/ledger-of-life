import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import * as registryModule from '../src/district-registry.ts';
import {PoliteFetcher} from '../src/polite-fetch.ts';

test('retired registry refresh rejects before any metadata read or network operation',async t=>{
 const read=t.mock.method(fs,'readFile',async()=>{throw Error('Retired refresh must not read input');});syncBuiltinESMExports();
 t.after(()=>{read.mock.restore();syncBuiltinESMExports();});
 const fetch=t.mock.method(PoliteFetcher.prototype,'fetch',async()=>{throw Error('Registry CLI cannot acquire sources');});
 const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('Registry CLI cannot use an ungoverned transport');});
 await assert.rejects(registryModule.districtRegistryMain(['refresh','--registry','/unread/registry.json','--out','/unwritten/output.json']),/validate/);
 for(const option of ['--out','--cache'])await assert.rejects(registryModule.districtRegistryMain(['validate',option,'/unread/path']),/validation option/);
 assert.equal(read.mock.callCount(),0);assert.equal(fetch.mock.callCount(),0);assert.equal(network.mock.callCount(),0);
 assert.equal('refreshDistrictRegistry' in registryModule,false);
});

test('registry CLI retains local schema validation without acquiring or writing data',async t=>{
 const fetch=t.mock.method(PoliteFetcher.prototype,'fetch',async()=>{throw Error('Validation must remain offline');});
 const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('Validation must remain offline');});
 const messages:string[]=[],log=t.mock.method(console,'log',(...values:unknown[])=>{messages.push(String(values[0]));});
 await registryModule.districtRegistryMain(['validate','--registry',new URL('../sources/district-registry.json',import.meta.url).pathname]);
 assert.equal(log.mock.callCount(),1);
 const summary=JSON.parse(messages[0]);
 assert.equal(summary.schemaVersion,'stadtstack-source-registry-v1');assert.ok(summary.municipalities>0);
 assert.equal(fetch.mock.callCount(),0);assert.equal(network.mock.callCount(),0);
});
