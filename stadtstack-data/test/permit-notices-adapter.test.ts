import {test} from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {digest,ObservationSchema} from '../src/district-adapter-contract.ts';
import type {AdmittedSnapshot,AdapterScope} from '../src/district-adapter-contract.ts';
import {permitNoticesAdapter,permitNoticesCapabilityReceipt,PERMIT_NOTICE_SOURCES} from '../src/adapters/permit-notices.ts';
import type {PermitNoticeSourceId} from '../src/adapters/permit-notices.ts';

// Synthetic, bounded native HTML fixtures, NOT captured publisher responses or proof of live readiness.
const uuid='a6cda373-679c-4b54-9944-4135500d7c12';
const sources=Object.keys(PERMIT_NOTICE_SOURCES) as PermitNoticeSourceId[];
function scope(sourceId:PermitNoticeSourceId):AdapterScope {
 return {publisherId:`issuer-${sourceId}`,sourceId,municipalityId:'fixture-town',ags:sourceId.endsWith('-bb')?'12064472':sourceId.endsWith('-sh')?'01053100':'13076090',tenant:null,observationWindow:'2026-10'};
}
function snapshot(html:string,url:string):AdmittedSnapshot {
 const bytes=new TextEncoder().encode(html);
 return {bytes,url,sourceSha256:digest(bytes),mimeType:'text/html; charset=utf-8',retrievedAt:'2026-10-11T12:00:00Z',policyReceiptSha256:digest('fixture admission only'),sourceVersion:'fixture-v1'};
}
function detailUrl(source:PermitNoticeSourceId):string {
 if(source.startsWith('uvp-'))return `https://www.uvp-verbund.de/trefferanzeige?docuuid=${uuid}&provider=${source.slice(4)}`;
 if(source==='bimschg-sh')return `https://bimschg.bob-sh.de/verfahren/${uuid}/public/detail`;
 if(source==='bimschg-mv')return 'https://www.stalu-mv.de/wm/Service/Presse_Bekanntmachungen?id=221478&processor=processor.sa.pressemitteilung';
 return PERMIT_NOTICE_SOURCES[source]+'bekanntmachung-antrag.html';
}
const detailHtml=(status='Antrag gestellt')=>`<!doctype html><html lang="de"><body><main><h1>Windenergieanlage – Antrag</h1><dl>
<dt>Zuständige Behörde</dt><dd> Landesamt   für Umwelt </dd>
<dt>Aktenzeichen</dt><dd> WM-2026/001 </dd><dt>Standort</dt><dd>Fixture-Ort</dd>
<dt>Veröffentlichungsdatum</dt><dd>01.10.2026</dd><dt>Stand</dt><dd>30.09.2026</dd>
<dt>Auslegungsbeginn</dt><dd>12.10.2026</dd><dt>Auslegungsende</dt><dd>12.11.2026</dd>
<dt>Einwendungsfrist</dt><dd>26.11.2026</dd><dt>Verfahrensart</dt><dd>UVP-Vorprüfung</dd>
<dt>Status</dt><dd>${status}</dd></dl>
<p>Ein Antrag und eine negative Vorprüfung sind keine erteilte Genehmigung.</p>
<a href="/files/antrag.pdf">Antrag</a><a href="/files/bescheid.pdf">Genehmigungsbescheid mit Nebenbestimmungen</a>
<a href="https://consultant.example.org/application.zip">Gutachten (Dritte)</a>
</main></body></html>`;

for(const source of sources){
 test(`${source}: positive detail metadata binds raw HTML, native identity, date roles and documents`,()=>{
  const input=snapshot(detailHtml(),detailUrl(source)),context=scope(source);
  const parsed=permitNoticesAdapter.parse(input,context),discovered=permitNoticesAdapter.discover(input,context,null);
  assert.equal(parsed.coverage.state,'partial');assert.ok(parsed.observations.length>10);
  assert.equal(discovered.resources.filter(resource=>resource.format==='pdf').length,2);
  assert.equal(discovered.resources.filter(resource=>resource.format==='zip').length,1);
  for(const value of parsed.observations){
   ObservationSchema.parse(value);assert.equal(value.financialRole,'none');assert.equal(value.geography.ags,null);
   assert.equal(value.nativeVersion,'fixture-v1');assert.equal(value.evidence[0].sourceSha256,input.sourceSha256);
   const locator=value.evidence[0],$=load(new TextDecoder().decode(input.bytes));
   const attribute=locator.path.endsWith('/@href');
   assert.equal(attribute?$(locator.path.slice(0,-6)).attr('href'):$(locator.path).text(),locator.rawValue);
  }
  const file=parsed.observations.find(value=>value.predicate==='published_file_reference')!;
  assert.equal(file.value,'WM-2026/001');assert.equal(file.evidence[0].rawValue,' WM-2026/001 ');
  assert.equal(file.publishedAt,'2026-10-01');assert.equal(file.sourceReferenceDate,'2026-09-30');
  const deadline=parsed.observations.find(value=>value.predicate==='published_objection_deadline')!;
  assert.equal(deadline.date,'2026-11-26');assert.equal(deadline.dateRole,'objection_deadline');
  if(source.startsWith('uvp-')||source==='bimschg-sh')assert.equal(file.nativeId,uuid);
  else assert.match(file.nativeId,/^authority-file:/);
  assert.deepEqual(permitNoticesAdapter.parse(input,context),parsed);
  assert.equal(new Set(parsed.observations.map(value=>value.id)).size,parsed.observations.length);
  assert.ok(parsed.observations.every(value=>!['authorizes','issues_permit','payment','construction_complete'].includes(value.predicate)));
 });
 test(`${source}: index links and labelled tabular fields retain page-local pagination`,()=>{
  const root=PERMIT_NOTICE_SOURCES[source],next=new URL(root);next.searchParams.set('page','2');
  const input=snapshot(`<main><h1>Bekanntmachungen</h1><table><thead><tr><th>Vorhaben</th><th>Veröffentlichungsdatum</th><th>Status</th></tr></thead><tbody><tr><td><a href="${detailUrl(source).replaceAll('&','&amp;')}">Windenergie Antrag</a></td><td>02.10.2026</td><td>Auslegung</td></tr></tbody></table><nav class="pagination"><a rel="next" href="${next.href.replaceAll('&','&amp;')}">Weiter</a></nav></main>`,root);
  const parsed=permitNoticesAdapter.parse(input,scope(source)),discovered=permitNoticesAdapter.discover(input,scope(source),null);
  assert.equal(discovered.coverage.nextCursor,next.href);assert.equal(discovered.coverage.state,'partial');
  assert.ok(discovered.resources.some(resource=>resource.url===detailUrl(source)));
  assert.ok(parsed.observations.some(value=>value.predicate==='published_publication_date'&&value.date==='2026-10-02'));
  assert.ok(parsed.observations.some(value=>value.predicate==='published_status'&&value.value==='Auslegung'));
  assert.equal(permitNoticesAdapter.discover(input,scope(source),'https://attacker.example.org/page').coverage.state,'held_quality');
  const nextPage=snapshot('<main>Keine Treffer gefunden</main>',next.href);
  assert.equal(permitNoticesAdapter.discover(nextPage,scope(source),next.href).coverage.state,'empty');
 });
 test(`${source}: explicit empty is different from schema change and challenge`,()=>{
  const root=PERMIT_NOTICE_SOURCES[source],context=scope(source);
  assert.equal(permitNoticesAdapter.parse(snapshot('<main>Keine Bekanntmachungen vorhanden</main>',root),context).coverage.state,'empty');
  assert.equal(permitNoticesAdapter.parse(snapshot('<main><h1>New application shell</h1><div id="app"></div></main>',root),context).coverage.state,'held_quality');
  const blocked=permitNoticesAdapter.parse(snapshot('<main><form><input type="password"></form></main>',root),context);
  assert.equal(blocked.coverage.state,'blocked_access');assert.equal(blocked.observations.length,0);
  assert.equal(permitNoticesAdapter.parse(snapshot('<main>Seite wurde nicht gefunden</main>',detailUrl(source)),context).coverage.state,'held_quality');
 });
 test(`${source}: explicit withdrawal is a versioned attributed status, never disappearance deletion`,()=>{
  const original=snapshot(detailHtml(),detailUrl(source)),withdrawn=snapshot(detailHtml('Antrag zurückgezogen'),detailUrl(source));withdrawn.sourceVersion='fixture-v2';
  const before=permitNoticesAdapter.parse(original,scope(source)),after=permitNoticesAdapter.parse(withdrawn,scope(source));
  const status=after.observations.find(value=>value.predicate==='published_status')!;
  assert.equal(status.value,'Antrag zurückgezogen');assert.equal(status.nativeVersion,'fixture-v2');
  assert.equal(before.observations[0].nativeId,status.nativeId);
  assert.ok(status.limitations.some(value=>value.includes('no historical observation deletion')));
  assert.notEqual(before.observations[0].id,after.observations[0].id);
 });
}

test('explicit AGS preserves leading zeroes, conflicts and malformed date stay unresolved',()=>{
 const source='bimschg-sh',url=detailUrl(source),context=scope(source);
 const html=detailHtml('Genehmigung erteilt').replace('</dl>','<dt>AGS</dt><dd>01053100</dd></dl>');
 const result=permitNoticesAdapter.parse(snapshot(html,url),context);
 assert.ok(result.observations.every(value=>value.geography.ags==='01053100'&&value.geography.basis==='source_explicit'));
 assert.ok(result.observations.every(value=>value.predicate.startsWith('published_')));
 const conflict=permitNoticesAdapter.parse(snapshot(html.replace('</dl>','<dt>AGS</dt><dd>01053090</dd></dl>'),url),context);
 assert.ok(conflict.observations.every(value=>value.geography.ags===null));
 const invalid=permitNoticesAdapter.parse(snapshot(detailHtml().replace('26.11.2026','31.11.2026'),url),context);
 assert.equal(invalid.observations.find(value=>value.predicate==='published_objection_deadline')!.date,null);
 assert.ok(invalid.observations.find(value=>value.predicate==='published_objection_deadline')!.limitations.some(value=>value.includes('no unambiguous')));
});

test('authority file identity is issuer-scoped; no authority remains a document, not a procedure',()=>{
 const source='bimschg-mv',input=snapshot(detailHtml(),detailUrl(source)),context=scope(source);
 const result=permitNoticesAdapter.parse(input,context),other=permitNoticesAdapter.parse(input,{...context,publisherId:'another issuer'});
 assert.notEqual(result.observations[0].nativeId,other.observations[0].nativeId);
 const noAuthority=permitNoticesAdapter.parse(snapshot(detailHtml().replace('<dt>Zuständige Behörde</dt><dd> Landesamt   für Umwelt </dd>',''),detailUrl(source)),context);
 assert.ok(noAuthority.observations.every(value=>value.kind==='PermitNoticeDocumentMetadata'&&value.nativeId.startsWith('source-document:')));
});

test('attachments use own resource identity, parent procedure and separate rights boundary',()=>{
 const source='bimschg-sh',result=permitNoticesAdapter.discover(snapshot(detailHtml()+`<a href="http://127.0.0.1/private.pdf">private</a>`,detailUrl(source)),scope(source),null);
 assert.ok(result.resources.every(value=>value.parentId===uuid));
 assert.ok(result.resources.some(value=>value.url==='https://consultant.example.org/application.zip'));
 assert.ok(result.resources.every(value=>!value.url.includes('127.0.0.1')));
 assert.ok(result.coverage.limitations.some(value=>value.includes('own acquisition/origin')));
});

test('byte binding, MIME, source slices, bounds and conflicting pagination fail closed',()=>{
 const source='uvp-sh',context=scope(source),root=PERMIT_NOTICE_SOURCES[source],input=snapshot(detailHtml(),detailUrl(source));
 assert.throws(()=>permitNoticesAdapter.parse({...input,sourceSha256:digest('not original')},context),/byte binding/);
 assert.equal(permitNoticesAdapter.parse({...input,mimeType:'application/pdf'},context).coverage.state,'held_quality');
 assert.equal(permitNoticesAdapter.parse({...input,url:detailUrl('uvp-bb')},context).coverage.state,'held_quality');
 assert.equal(permitNoticesAdapter.parse(snapshot('<main>'+ '<a href="/files/a.pdf">a</a>'.repeat(2001)+'</main>',root),context).coverage.state,'held_quality');
 assert.equal(permitNoticesAdapter.parse(snapshot('<main>'+ '<dt>Ort</dt><dd>x</dd>'.repeat(1001)+'</main>',root),context).coverage.state,'held_quality');
 assert.equal(permitNoticesAdapter.parse(snapshot('<main>'+ 'x'.repeat(8*1024*1024)+'</main>',root),context).coverage.state,'held_quality');
 const conflict=snapshot('<main><a rel="next" href="?provider=sh&page=2">Next</a><a rel="next" href="?provider=sh&page=3">Next</a></main>',root);
 assert.equal(permitNoticesAdapter.discover(conflict,context,null).coverage.state,'held_quality');
 assert.equal(permitNoticesCapabilityReceipt.sources.length,6);
 assert.ok(permitNoticesCapabilityReceipt.sources.every(value=>value.collectionState==='held_origin'));
});
