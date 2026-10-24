import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertStep8ExportMembership,reserveStep8Generation,classifyStep8Exception,assertNativeContributorCoverage,step8SocketConnection,Step8CampaignSchema} from '../src/r1-step8-governance.ts';
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),source={municipalityId:'synthetic',sourceId:'website',corpus:{path:'/synthetic/index',sha256:a},documents:[{documentId:'one',sha256:b,jobKey:c}]};
const result={documentId:'one',corpusSha256:a,result:{taskId:c,municipalityId:'synthetic',sourceSha256:b}};
test('campaign export membership rejects omitted held originals, substituted jobs and same-sized wrong sources',()=>{
 Step8CampaignSchema.parse({schemaVersion:'stadtstack-r1-step8-campaign-v1',sources:[source]});assert.doesNotThrow(()=>assertStep8ExportMembership(source,[result]));
 assert.throws(()=>assertStep8ExportMembership(source,[]),/document\/job set/);
 assert.throws(()=>assertStep8ExportMembership(source,[{...result,result:{...result.result,taskId:a}}]),/document\/job set/);
 assert.throws(()=>assertStep8ExportMembership(source,[{...result,corpusSha256:b}]),/source scope/);
 assert.throws(()=>assertStep8ExportMembership({...source,documents:[...source.documents,{documentId:'held',sha256:a,jobKey:b}]},[result]),/document\/job set/);
});
test('generation reservation has one atomic winner and rejects changed ownership',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r1-step8-claim-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'candidate');
 const results=await Promise.allSettled([reserveStep8Generation(path),reserveStep8Generation(path)]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
 const winner=results.find(result=>result.status==='fulfilled');assert.ok(winner?.status==='fulfilled');await winner.value.assertOwned();await writeFile(path+'.claim','different owner');await assert.rejects(winner.value.assertOwned(),/claim changed/);
});
test('exception classifications retain critical, rights, disagreement and legitimate negative distinctions',()=>{
 assert.equal(classifyStep8Exception([{reason:'assessment_missing'}]).critical,true);assert.equal(classifyStep8Exception([{reason:'assessment_held'}]).disagreement,true);assert.equal(classifyStep8Exception([{holdReasons:['rights']}]).rights,true);assert.deepEqual(classifyStep8Exception([{reason:'no_supported_case'}]),{critical:false,rights:false,disagreement:false});
 assert.equal(classifyStep8Exception({criticalKinds:['stage']}).critical,true);
});
test('native custody requires primary and every supporting contributor, never unrelated text bindings',()=>{
 const primary={url:'https://example.org/native',sha256:a},support={url:'https://example.org/boundaries',sha256:b},bindings=[{url:primary.url,sourceSha256:a},{url:support.url,sourceSha256:b}];assert.doesNotThrow(()=>assertNativeContributorCoverage(bindings,[primary,support]));
 assert.throws(()=>assertNativeContributorCoverage(bindings.slice(0,1),[primary,support]),/contributor coverage/);assert.throws(()=>assertNativeContributorCoverage([{url:'https://example.org/text',sourceSha256:c}],[primary,support]),/contributor coverage/);
});
test('documented socket DSNs preserve the original pg connection string and reject network/relative hosts',()=>{
 for(const dsn of ['postgresql://OPERATOR@/DB?host=/absolute/socket-directory','postgres:///DB?host=%2Fabsolute%2Fsocket'])assert.equal(step8SocketConnection(dsn),dsn);
 for(const dsn of ['postgresql://user@localhost/DB','postgres:///DB?host=relative/socket'])assert.throws(()=>step8SocketConnection(dsn),/Unix-domain socket/);
});
