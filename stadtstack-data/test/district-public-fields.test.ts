import test from 'node:test';
import assert from 'node:assert/strict';
import {observation,digest} from '../src/district-adapter-contract.ts';
import {PUBLIC_CONTACT_PATTERN,structuredFieldPublicationHold} from '../src/district-public-fields.ts';

function field(predicate:string,value:string|number){
 return observation({publisherId:'fixture',sourceId:'fixture',nativeId:'row-1',nativeVersion:null,kind:'FixtureObservation',subject:'row-1',predicate,value,unit:null,date:null,dateRole:null,financialRole:'none',geography:{ags:'01053100',basis:'source_explicit',role:'administrative_area'},sourceReferenceDate:null,publishedAt:null,retrievedAt:'2026-10-11T00:00:00.000Z',evidence:[{sourceSha256:digest('fixture bytes'),format:'json',nativeId:'row-1',path:`$.${predicate}`,sheet:null,rowKey:'row-1',cells:[],rawValue:value,schemaHash:digest('fixture schema'),mappingVersion:'fixture-v1'}],limitations:[]});
}
test('narrative native fields require substantive text admission without truncation',()=>{
 const input=field('resolution_text','Ein ausführlicher Beschluss mit Voraussetzungen.'),before=JSON.stringify(input);
 assert.equal(structuredFieldPublicationHold(input),'narrative_requires_text_model');assert.equal(JSON.stringify(input),before);
 assert.equal(structuredFieldPublicationHold(field('project_description','Projektbeschreibung')),'narrative_requires_text_model');
 assert.equal(structuredFieldPublicationHold(field('native_identifier','SEE900000000001')),null);
});
test('public native fields exclude contact details and oversized original literals',()=>{
 assert.equal(structuredFieldPublicationHold(field('name','person@example.org')),'contact_field');
 assert.equal(structuredFieldPublicationHold(field('phone','030123456')),'contact_field');
 assert.equal(structuredFieldPublicationHold(field('name','Telefon: +49 30 123456')),'contact_field');
 assert.equal(structuredFieldPublicationHold(field('name','a'.repeat(1801))),'source_literal_exceeds_short_quote');
 assert.equal(PUBLIC_CONTACT_PATTERN.test('person@example.org'),true);
});
test('coded numbers and bounded source quality qualifications remain attributed facts',()=>{
 assert.equal(structuredFieldPublicationHold(field('amount',1050)),null);
 assert.equal(structuredFieldPublicationHold(field('source_comment','Ungeprüfter Rohwert; beeinflusst durch Rückstau.')),null);
});
test('public source locators, identity fields and qualifications cannot hide contact literals',()=>{
 for(const mutate of [
  (row:ReturnType<typeof field>)=>{row.nativeId='person@example.org';},
  (row:ReturnType<typeof field>)=>{row.subject='person@example.org';},
  (row:ReturnType<typeof field>)=>{row.limitations=['Synthetic contact person@example.org'];},
  (row:ReturnType<typeof field>)=>{row.evidence[0].path='$.contacts["person@example.org"]';},
  (row:ReturnType<typeof field>)=>{row.evidence[0].sheet='person@example.org';},
  (row:ReturnType<typeof field>)=>{row.evidence[0].cells=['person@example.org'];},
  (row:ReturnType<typeof field>)=>{row.supportingEvidence=[{role:'source_metadata',locator:{...row.evidence[0],rowKey:'person@example.org'}}];},
 ]){
  const row=field('amount',1050);mutate(row);const before=JSON.stringify(row);
  assert.equal(structuredFieldPublicationHold(row),'contact_field');assert.equal(JSON.stringify(row),before);
 }
 assert.equal(structuredFieldPublicationHold(field('name','Telefon:\n+49 30 123456')),'contact_field');
 const row=field('amount',1050);row.limitations=['a'.repeat(1801)];
 assert.equal(structuredFieldPublicationHold(row),'source_literal_exceeds_short_quote');
});
