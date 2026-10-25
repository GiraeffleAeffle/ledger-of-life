import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical,mcpSourceId,knowledgeSourceDescriptors} from '../src/mcp-source-identity.ts';
import {isRecordRevoked} from '../src/civic-revocations.ts';
import {verifiedMask} from './fixtures/revocations.ts';

// Synthetic metadata only; no municipal, network or model evidence.
test('shared source codec preserves existing v2 source identities and omitted fields',()=>{
 const source={url:'https://example.org/a',locator:'page 3',publisher:'Synthetic town',sha256:null,title:'Not an identity field',retrievedAt:'2026-10-01T00:00:00.000Z'};
 const originalTuple=canonical({url:source.url,locator:source.locator,publisher:source.publisher,sha256:source.sha256??null});
 const expected='source:'+createHash('sha256').update(originalTuple).digest('hex');
 assert.equal(mcpSourceId(source),expected);
 assert.equal(mcpSourceId({...source,sha256:undefined}),expected);
 const renamedSource={...source,title:'Changed display title'};
 assert.equal(mcpSourceId(renamedSource),expected);
 assert.equal(canonical({b:2,a:1,absent:undefined}),'{"a":1,"b":2}');
 assert.equal(canonical({a:[{b:2,a:1},3]}),'{"a":[{"a":1,"b":2},3]}');
});

test('locator order and explicit native scope remain part of source identity',()=>{
 const source={url:'https://example.org/a',publisher:'Synthetic town',locators:[{page:1},{page:2}],sha256:'a'.repeat(64),role:'primary',policyReceiptSha256:'b'.repeat(64),scopeSha256:'c'.repeat(64)};
 assert.notEqual(mcpSourceId(source),mcpSourceId({...source,locators:[...source.locators].reverse()}));
 assert.notEqual(mcpSourceId(source),mcpSourceId({...source,scopeSha256:'d'.repeat(64)}));
 assert.notEqual(mcpSourceId(source),mcpSourceId({...source,role:'supporting'}));
});

test('text and structured revocation descriptors match the attribution codec without ID rewriting',()=>{
 const source={id:'registered source ?=#',url:'https://example.org/a',locator:'page 3',sha256:'a'.repeat(64)};
 assert.deepEqual(knowledgeSourceDescriptors({municipalityId:'synthetic-town',sources:[source]}),[{mcpSourceId:mcpSourceId({...source,publisher:'synthetic-town'}),municipalityId:'synthetic-town',registrySourceId:source.id,url:source.url}]);
 const evidence=[{sourceSha256:source.sha256,page:3}],support={...source,id:'supporting source',url:'https://example.org/b',role:'decision',sha256:'b'.repeat(64)},locator={sourceSha256:support.sha256,page:7},unrelatedLocator={sourceSha256:'c'.repeat(64),page:9};
 const descriptors=knowledgeSourceDescriptors({kind:'structured',municipalityId:'synthetic-town',source,supportingSources:[support],observation:{publisherId:'publisher',evidence,supportingEvidence:[{role:'decision',locator},{role:'unrelated',locator:unrelatedLocator}]},verification:{adapterId:'synthetic-adapter'}});
 assert.equal(descriptors[0].mcpSourceId,mcpSourceId({...source,publisher:'publisher',locators:evidence}));
 assert.equal(descriptors[1].mcpSourceId,mcpSourceId({...support,locators:[locator]}));
 assert.equal(descriptors[1].registrySourceId,support.id);
});

test('nested source provenance participates in host withholding without inventing source IDs',()=>{
 const source={id:'unit-source',url:'https://example.org/document',locator:'page 1',snapshotUrl:'https://snapshots.example.org/copy',policy:{robots:{url:'https://policies.example.org/robots.txt'},tdm:{evidence:[{url:'https://rights.example.org/policy',value:'See https://rights.example.org/terms'}]}}};
 const record={id:'knowledge:unit-record',municipalityId:'synthetic-town',sources:[source]};
 const descriptors=knowledgeSourceDescriptors(record);
 assert.deepEqual(new Set(descriptors.map(item=>item.url)),new Set([source.url,source.snapshotUrl,source.policy.robots.url,'https://rights.example.org/policy','https://rights.example.org/terms']));
 assert.equal(descriptors[0].mcpSourceId,mcpSourceId({...source,publisher:record.municipalityId}));
 assert.ok(descriptors.slice(1).every(item=>item.mcpSourceId===undefined&&item.registrySourceId===undefined));
 const mask=verifiedMask('e'.repeat(64),[{type:'host',host:'policies.example.org'}]);
 assert.equal(isRecordRevoked(mask,{recordId:record.id,municipalityId:record.municipalityId,sources:descriptors}),true);
});
