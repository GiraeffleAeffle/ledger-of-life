import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePublicRequestHeaders} from '../src/district-native-request.ts';

const genesisUrl=new URL('https://www.regionalstatistik.de/genesisws/rest/2020/data/table');
const genesisBody=new URLSearchParams({name:'12411-06-01',area:'free',language:'de',regionalvariable:'GEMEIN',regionalkey:'01053100',startyear:'2024',endyear:'2024',compress:'false',transpose:'false',job:'false'}).toString();
const tedUrl=new URL('https://api.ted.europa.eu/v3/notices/search');
const tedBody={query:'publication-date = 20261010',fields:['publication-number'],limit:100,scope:'ALL',paginationMode:'ITERATION',onlyLatestVersions:false};

test('GENESIS public profile injects only guest credentials on allowlisted POST endpoints',()=>{
 for(const path of ['data/table','data/tablefile','metadata/table']){
  assert.deepEqual(nativePublicRequestHeaders(new URL(`https://www.regionalstatistik.de/genesisws/rest/2020/${path}`),'POST',genesisBody,'genesis_guest'),{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8',username:'GAST',password:'GAST'});
 }
 assert.deepEqual(nativePublicRequestHeaders(genesisUrl,'GET',undefined,'genesis_guest'),{});
 assert.deepEqual(nativePublicRequestHeaders(new URL('https://example.org/fixture'),'GET',undefined,'genesis_guest'),{});
 assert.deepEqual(nativePublicRequestHeaders(new URL('https://example.org/fixture'),'POST','selector=public'),{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'});
 for(const url of ['https://example.org/genesisws/rest/2020/data/table','https://www.regionalstatistik.de.example.org/genesisws/rest/2020/data/table','http://www.regionalstatistik.de/genesisws/rest/2020/data/table','https://www.regionalstatistik.de/genesisws/rest/2020/data/table?tenant=other','https://www.regionalstatistik.de/genesisws/rest/2020/data/table/','https://www.regionalstatistik.de/genesisws/rest/2020/data/cube']){
  assert.throws(()=>nativePublicRequestHeaders(new URL(url),'POST',genesisBody,'genesis_guest'),/endpoint mismatch/);
 }
});

test('GENESIS selector rejects credential overrides, duplicate fields and unbounded data selectors',()=>{
 for(const [key,value] of [['username','fixture'],['password','fixture'],['area','all'],['language','en'],['name','12411'],['regionalkey','01053100,01053090'],['startyear','2020-2024'],['endyear','2025'],['compress','true'],['transpose','true'],['job','true']]){
  const params=new URLSearchParams(genesisBody);params.set(key,value);
  assert.throws(()=>nativePublicRequestHeaders(genesisUrl,'POST',params.toString(),'genesis_guest'),/selector rejected|single-region/);
 }
 assert.throws(()=>nativePublicRequestHeaders(genesisUrl,'POST',`${genesisBody}&name=12411-06-01`,'genesis_guest'),/selector rejected/);
 for(const body of [undefined,'','x'.repeat(65537),'ä'.repeat(32769)])assert.throws(()=>nativePublicRequestHeaders(genesisUrl,'POST',body,'genesis_guest'),/bound rejected/);
 const district=new URLSearchParams(genesisBody);district.set('regionalkey','01053');
 assert.equal(nativePublicRequestHeaders(genesisUrl,'POST',district.toString(),'genesis_guest').username,'GAST');
});

test('GENESIS admits only the exact municipal-depth exception, retaining synchronous bounds',()=>{
 const mapped=genesisBody.replace('name=12411-06-01','name=12411-02-03-5');
 assert.equal(nativePublicRequestHeaders(genesisUrl,'POST',mapped,'genesis_guest').username,'GAST');
 for(const name of ['12411-02-03-4','12411-02-03-55','12411-02-03-5-extra','12411-06-01-5','31231-02-01-5','unknown']){
  const params=new URLSearchParams(mapped);params.set('name',name);
  assert.throws(()=>nativePublicRequestHeaders(genesisUrl,'POST',params.toString(),'genesis_guest'),/selector rejected/);
 }
 for(const [key,value] of [['username','fixture'],['endyear','2025'],['job','true'],['regionalkey','12064472,12064227']]){
  const params=new URLSearchParams(mapped);params.set(key,value);
  assert.throws(()=>nativePublicRequestHeaders(genesisUrl,'POST',params.toString(),'genesis_guest'),/selector rejected|single-region/);
 }
});

test('TED profile validates strict JSON and never carries GENESIS guest headers',()=>{
 assert.deepEqual(nativePublicRequestHeaders(tedUrl,'POST',JSON.stringify(tedBody),'ted_search'),{'Content-Type':'application/json'});
 assert.deepEqual(nativePublicRequestHeaders(tedUrl,'POST',JSON.stringify({...tedBody,iterationNextToken:'synthetic-cursor'}),'ted_search'),{'Content-Type':'application/json'});
 for(const url of ['https://example.org/v3/notices/search','https://api.ted.europa.eu/v3/notices/search?query=x','https://api.ted.europa.eu/v3/notices/search/','http://api.ted.europa.eu/v3/notices/search'])assert.throws(()=>nativePublicRequestHeaders(new URL(url),'POST',JSON.stringify(tedBody),'ted_search'),/endpoint mismatch/);
 for(const patch of [{query:''},{query:'x'.repeat(4001)},{fields:[]},{fields:Array(31).fill('id')},{limit:0},{limit:101},{scope:'DE'},{paginationMode:'PAGE_NUMBER'},{onlyLatestVersions:true},{iterationNextToken:'x'.repeat(16001)},{username:'GAST'}])assert.throws(()=>nativePublicRequestHeaders(tedUrl,'POST',JSON.stringify({...tedBody,...patch}),'ted_search'));
 assert.throws(()=>nativePublicRequestHeaders(tedUrl,'POST','not json','ted_search'));
 assert.throws(()=>nativePublicRequestHeaders(tedUrl,'POST','x'.repeat(65537),'ted_search'),/bound rejected/);
});
