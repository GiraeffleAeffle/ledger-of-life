import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest, ObservationSchema} from '../src/district-adapter-contract.ts';
import type {AdmittedSnapshot, AdapterScope} from '../src/district-adapter-contract.ts';
import {municipalFinanceAdapter, municipalFinanceDocuments, municipalFinancePdfRoutes, municipalFinanceCapability} from '../src/adapters/municipal-finance.ts';

// Authored native HTML, not live captures: exact known resource URLs/years are catalog-backed.
// Table fixtures exercise real HTML cells, not fabricated normalized JSON observations.
const scope:AdapterScope={publisherId:'stadt-schwarzenbek',sourceId:'schwarzenbek-finance-documents',municipalityId:'schwarzenbek',ags:'01053116',tenant:null,observationWindow:'2026-10'};
function snapshot(html:string,url='https://www.schwarzenbek.de/Themen/Finanzen/Haushaltsunterlagen/'):AdmittedSnapshot {
 const bytes=new TextEncoder().encode(html);
 return {bytes,sourceSha256:digest(bytes),url,mimeType:'text/html; charset=utf-8',retrievedAt:'2026-10-11T00:00:00Z',policyReceiptSha256:digest('fixture-only-admission'),sourceVersion:'fixture-native-html-1'};
}
const schwarz=`<!doctype html><html><main><h1>Finanzen Stadt Schwarzenbek</h1>
<h2>Haushaltsunterlagen</h2><ul>
<li><a href="/loadDocument.phtml?FID=3787.1568.1&amp;Ext=PDF">Haushaltsplan mit Haushaltssatzung Stadt Schwarzenbek 2026</a></li>
<li><a href="/loadDocument.phtml?FID=3787.1796.1&amp;Ext=PDF">1. Nachtrag Stadt Schwarzenbek 2026</a></li>
<li><a href="/Themen/Finanzen/Jahresabschl%C3%BCsse/">Jahresabschlüsse</a></li>
<li><a href="/Themen/Finanzen/Beteiligungen/">Beteiligungen</a></li>
<li><a href="/school.pdf">Haushaltsplan Schulverband Schwarzenbek Nordost 2026</a></li></ul>
<h2>Jahresabschlüsse</h2><p><a href="/loadDocument.phtml?FID=3787.1466.1&amp;Ext=PDF">Jahresabschluss Stadt Schwarzenbek 2024</a></p>
<p><a href="/output/download.php?fid=3787.162.1.PDF">Beteiligungsbericht 2023</a></p>
</main><nav><a href="/unrelated.pdf">Haushaltsplan 2020</a></nav></html>`;

test('Schwarzenbek discovers actual catalog download identities and separate account/association routes',()=>{
 const admitted=snapshot(schwarz),docs=municipalFinanceDocuments(admitted,scope);
 assert.equal(docs.documents.length,7);
 assert.equal(docs.coverage.state,'partial');
 const account=docs.documents.find(d=>d.resource.url.includes('3787.1466.1'))!;
 assert.equal(account.documentClass,'annual_account');assert.deepEqual(account.fiscalYears,['2024']);
 assert.equal(account.issuer,'Stadt Schwarzenbek');assert.equal(account.publishedAt,null);
 const school=docs.documents.find(d=>d.resource.url.endsWith('school.pdf'))!;
 assert.equal(school.budgetScope,'school_association');assert.equal(school.issuer,'Schulverband Schwarzenbek Nordost');
 const routes=municipalFinancePdfRoutes(admitted,scope);
 assert.equal(routes.length,5);assert.equal(routes[0].receiptState,'not_checked');
 assert.ok(routes.every(route=>route.requiredStage==='isolated_pdf_text_or_ocr_then_evidence'));
 const parsed=municipalFinanceAdapter.parse(admitted,scope);
 assert.ok(parsed.observations.length>0);assert.ok(parsed.observations.every(o=>o.financialRole==='none'));
 assert.ok(parsed.observations.every(o=>ObservationSchema.safeParse(o).success));
 assert.deepEqual(parsed,municipalFinanceAdapter.parse(admitted,scope));
 assert.ok(parsed.observations.flatMap(o=>o.evidence).some(e=>e.rawValue==='/loadDocument.phtml?FID=3787.1466.1&Ext=PDF'));
});

test('Parchim participation report remains a routed report, not inferred operator or city account',()=>{
 const parchim={...scope,publisherId:'stadt-parchim',sourceId:'parchim-finance-documents',municipalityId:'parchim',ags:'13076108'};
 const html=`<main><h1>Haushalt Stadt Parchim</h1><ul>
 <li><a href="/de/ortsrecht/haushalt/20260227-00-haushalt-kernhaushalt-2026-einjaehrig-mn-ubgm.pdf?cid=12ya">Haushaltsplan Kernhaushalt Stadt Parchim 2026</a></li>
 <li><a href="/de/ortsrecht/haushalt/20260227-03-haushaltssatzung-2026-einjaehrig-mit-vermerk-genehmigung-unterschrift-bgm.docx.pdf?cid=12xa">Haushaltssatzung Stadt Parchim 2026</a></li>
 <li><a href="/de/bekanntmachungen/2025/20251016-beteiligungsbericht-2024.pdf">Beteiligungsbericht 2024</a> veröffentlicht am 16.10.2025</li>
 <li><a href="/approval.pdf">Aufsichtsbehördliche Genehmigung des Haushalts Stadt Parchim 2026</a></li></ul></main>`;
 const admitted=snapshot(html,'https://www.parchim.de/de/buergerservice-1/ortsrecht-bekanntmachungen/ortsrecht/haushalt/');
 const docs=municipalFinanceDocuments(admitted,parchim).documents;
 assert.deepEqual(docs.find(d=>d.documentClass==='participation_report')!.fiscalYears,['2024']);
 assert.equal(docs.find(d=>d.documentClass==='participation_report')!.publishedAt,'2025-10-16');
 assert.equal(docs.find(d=>d.documentClass==='budget_plan')!.budgetScope,'core_budget');
 assert.ok(docs.some(d=>d.documentClass==='supervisory_approval'));
 const observations=municipalFinanceAdapter.parse(admitted,parchim).observations;
 assert.ok(observations.every(o=>o.financialRole==='none'));
 assert.ok(!observations.some(o=>o.predicate==='operates'||o.predicate==='payment'||o.kind==='ActualExpenditure'));
});

test('notice cannot stand in for annual account, consolidated account stays distinct, no filename publication dates',()=>{
 const docs=municipalFinanceDocuments(snapshot(`<main><h1>Finanzen</h1>
 <p><a href="/notice.pdf">Bekanntmachung über die Feststellung des Jahresabschlusses 2025</a></p>
 <p><a href="/Gesamtabschluss_2020.pdf">Gesamtabschluss 2020</a></p>
 <p><a href="/20261005.pdf">Jahresabschluss 2024</a> Beschlossen am 05.10.2026</p>
 <p><a href="/special.pdf">Haushaltsplan Sondervermögen Altstadt 2026</a></p></main>`),scope).documents;
 assert.ok(docs.some(d=>d.documentClass==='account_approval_notice'));
 assert.ok(docs.some(d=>d.documentClass==='consolidated_account'&&d.budgetScope==='consolidated'));
 assert.ok(docs.every(d=>d.publishedAt===null));
 assert.ok(docs.some(d=>d.budgetScope==='special_fund'));
});


const fiscalTable=`<main><h1>Finanzen</h1><table><caption>Kernhaushalt Stadt Schwarzenbek</caption><tr>
<th>Produkt</th><th>Investitionsnummer</th><th>Haushaltsbereich</th><th>Haushaltsträger</th>
<th>Ansatz 2026 brutto (EUR)</th><th>Ergebnis 2024 netto (TEUR)</th><th>Genehmigt 2026 (EUR)</th><th>Ausgezahlt 2025 (EUR)</th></tr>
<tr><td>021100</td><td>I-0007</td><td>Kernhaushalt</td><td>Stadt Schwarzenbek</td><td>1.250,50</td><td>1,25</td><td>2.000,00</td><td>50,00</td></tr></table></main>`;
test('calendar dates and contradictory/forecast monetary columns do not create stronger fiscal roles',()=>{
 const documents=municipalFinanceDocuments(snapshot('<main><p><a href="/notice.pdf">Bekanntmachung Jahresabschluss 2024 vom 05.10.2026</a></p></main>'),scope).documents;
 assert.deepEqual(documents[0].fiscalYears,['2024']);
 const forecast=municipalFinanceAdapter.parse(snapshot(fiscalTable.replace('Ergebnis 2024 netto (TEUR)','Prognose Ergebnis 2024 netto (TEUR)')),scope);
 assert.ok(!forecast.observations.some(o=>o.predicate==='amount'&&o.financialRole==='actual'));
 const mixed=municipalFinanceAdapter.parse(snapshot(fiscalTable.replace('Ergebnis 2024 netto (TEUR)','Ergebnis Plan 2024 netto (TEUR)')),scope);
 assert.ok(!mixed.observations.some(o=>o.predicate==='amount'&&o.financialRole==='actual'));
 const school=municipalFinanceAdapter.parse(snapshot(fiscalTable.replaceAll('Stadt Schwarzenbek','Schulverband Schwarzenbek Nordost')),scope);
 assert.ok(school.observations.filter(o=>o.predicate==='amount').every(o=>o.geography.ags===null&&o.geography.basis==='unknown'));
});
test('native fiscal table preserves leading-zero IDs, separate amounts/roles/periods, original cells and schema',()=>{
 const admitted=snapshot(fiscalTable),parsed=municipalFinanceAdapter.parse(admitted,scope);
 const amounts=parsed.observations.filter(o=>o.predicate==='amount');
 assert.equal(amounts.length,4);
 assert.equal(amounts.find(o=>o.financialRole==='plan')!.value,1250.5);
 assert.equal(amounts.find(o=>o.financialRole==='actual')!.value,1250);
 assert.equal(amounts.find(o=>o.financialRole==='actual')!.date,'2024');
 assert.equal(amounts.find(o=>o.financialRole==='approval')!.value,2000);
 assert.equal(amounts.find(o=>o.financialRole==='payment')!.value,50);
 assert.equal(new Set(amounts.map(o=>o.subject)).size,4);
 assert.ok(amounts.every(o=>o.unit==='EUR'&&o.geography.ags==='01053116'));
 assert.ok(parsed.observations.some(o=>o.predicate==='product_id'&&o.value==='021100'));
 assert.ok(parsed.observations.some(o=>o.predicate==='investment_id'&&o.value==='I-0007'));
 assert.ok(parsed.observations.some(o=>o.predicate==='gross_net'&&o.value==='net'));
 assert.ok(amounts.flatMap(o=>o.evidence).some(e=>e.rawValue==='1.250,50'));
 assert.ok(amounts.flatMap(o=>o.evidence).some(e=>e.rawValue==='Ergebnis 2024 netto (TEUR)'));
 assert.equal(parsed.coverage.state,'partial');
});

test('German monetary magnitude qualifiers scale native headers, ambiguous magnitudes stay held',()=>{
 const units:[string,number][]=[['EUR',1],['TEUR',1000],['T€',1000],['Tsd. €',1000],['Tausend €',1000],['Tausend Euro',1000],['Mio. EUR',1000000],['Mio. €',1000000],['Millionen EUR',1000000],['MEUR',1000000]];
 const roles=[['Ansatz','plan'],['Ergebnis','actual'],['Genehmigt','approval'],['Ausgezahlt','payment']];
 for(const [label,role] of roles)for(const [unit,multiplier] of units) {
  const rawHeader=`${label} 2024 (${unit})`;
  const html=`<main><table><tr><th>${rawHeader}</th></tr><tr><td>1,25</td></tr></table></main>`;
  const parsed=municipalFinanceAdapter.parse(snapshot(html),scope);
  const amount=parsed.observations.find(o=>o.predicate==='amount')!;
  assert.ok(amount,rawHeader);assert.equal(amount.value,1.25*multiplier,rawHeader);
  assert.equal(amount.financialRole,role);assert.equal(amount.unit,'EUR');
  assert.ok(amount.evidence.some(e=>e.rawValue===rawHeader));
  assert.ok(amount.evidence.some(e=>e.rawValue==='1,25'));
 }
 for(const unit of ['Mrd. EUR','Milliarden €','Billionen EUR','Tsd. brutto EUR','Tsd. EUR und Mio. EUR','Tsd. EUR oder Mio. brutto EUR','in 1000 EUR']) {
  const html=`<main><table><tr><th>Ansatz 2024 (${unit})</th></tr><tr><td>1,25</td></tr></table></main>`;
  const parsed=municipalFinanceAdapter.parse(snapshot(html),scope);
  assert.ok(!parsed.observations.some(o=>o.predicate==='amount'),unit);
  assert.equal(parsed.coverage.state,'held_quality',unit);
  assert.ok(parsed.coverage.limitations.some(reason=>reason.includes('magnitude qualifier')),unit);
 }
});

test('explicit participation percentage is fiscal ownership observation, never legal identity/current operation',()=>{
 const html='<main><table><caption>Beteiligungen</caption><tr><th>Unternehmen</th><th>Jahr</th><th>Beteiligungsquote (%)</th></tr><tr><td>Stadtwerke Beispiel GmbH</td><td>2024</td><td>100,00</td></tr></table></main>';
 const parsed=municipalFinanceAdapter.parse(snapshot(html),scope);
 const share=parsed.observations.find(o=>o.predicate==='participation_percent')!;
 assert.equal(share.value,100);assert.equal(share.financialRole,'none');assert.equal(share.date,'2024');
 assert.ok(!parsed.observations.some(o=>o.predicate==='same_as'||o.predicate==='operates'));
 const euroShare=html.replace('Beteiligungsquote (%)','Kapitalanteil (EUR)');
 assert.ok(!municipalFinanceAdapter.parse(snapshot(euroShare),scope).observations.some(o=>o.predicate==='participation_percent'));
});

test('explicit empty differs from unloaded/schema-changed/absent entries',()=>{
 assert.equal(municipalFinanceAdapter.parse(snapshot('<main><h1>Finanzen</h1><p>Keine Finanzdokumente vorhanden</p></main>'),scope).coverage.state,'empty');
 assert.equal(municipalFinanceAdapter.parse(snapshot('<main><h1>Finanzen</h1><p>Ergebnisse werden geladen</p></main>'),scope).coverage.state,'held_quality');
 const changed=fiscalTable.replace('<td>50,00</td>','');
 const result=municipalFinanceAdapter.parse(snapshot(changed),scope);
 assert.equal(result.observations.length,0);assert.equal(result.coverage.state,'held_quality');
 assert.ok(result.coverage.limitations.some(value=>value.includes('shape changed')));
 const unknown=fiscalTable.replaceAll('EUR','unbekannt').replace('TEUR','unbekannt');
 assert.ok(!municipalFinanceAdapter.parse(snapshot(unknown),scope).observations.some(o=>o.predicate==='amount'));
 const suppressed=fiscalTable.replace('1.250,50','…');
 assert.ok(!municipalFinanceAdapter.parse(snapshot(suppressed),scope).observations.some(o=>o.predicate==='amount'&&o.financialRole==='plan'));
});

test('bounded local pagination pins exact index bytes and server pagination stays a native resource',()=>{
 const links=Array.from({length:105},(_,i)=>`<li><a href="/loadDocument.phtml?FID=fixture.${i}&amp;Ext=PDF">Haushaltsplan 2026 Teil ${i}</a></li>`).join('');
 const admitted=snapshot(`<main><h1>Haushaltsunterlagen</h1><ul>${links}</ul><a rel="next" href="?page=2">Weiter</a></main>`);
 const first=municipalFinanceAdapter.discover(admitted,scope,null);
 assert.equal(first.resources.length,100);assert.ok(first.coverage.nextCursor);
 const second=municipalFinanceAdapter.discover(admitted,scope,first.coverage.nextCursor);
 assert.equal(second.resources.length,6);assert.equal(second.coverage.nextCursor,null);
 assert.ok(second.resources.some(r=>r.url.endsWith('?page=2')&&r.format==='html'));
 assert.equal(new Set([...first.resources,...second.resources].filter(r=>r.format==='pdf').map(r=>r.nativeId)).size,105);
 assert.throws(()=>municipalFinanceAdapter.discover(snapshot('<main>changed bytes</main>'),scope,first.coverage.nextCursor));
 // A still-recognized changed snapshot must reject the cursor rather than silently resetting.
 assert.throws(()=>municipalFinanceAdapter.discover(snapshot(schwarz),scope,first.coverage.nextCursor),/cursor/);
});

test('explicit withdrawal retained as evidenced listing tombstone and never re-routed for acquisition',()=>{
 const admitted=snapshot('<main><p><a href="/withdrawn.pdf">Haushaltsplan 2026</a> zurückgezogen</p></main>');
 const doc=municipalFinanceDocuments(admitted,scope).documents[0];
 assert.equal(doc.status,'withdrawn');assert.equal(municipalFinanceAdapter.discover(admitted,scope,null).resources.length,0);
 assert.equal(municipalFinancePdfRoutes(admitted,scope).length,0);
 assert.ok(municipalFinanceAdapter.parse(admitted,scope).observations.some(o=>o.predicate==='listing_status'&&o.value==='withdrawn'));
});

test('access block, oversized input, PDF original and incorrect byte/policy bindings fail closed',()=>{
 const blocked=snapshot('<html><title>Login</title><input type="password"></html>');
 assert.equal(municipalFinanceAdapter.parse(blocked,scope).coverage.state,'blocked_access');
 assert.equal(municipalFinanceAdapter.discover(blocked,scope,null).resources.length,0);
 assert.equal(municipalFinanceAdapter.parse(snapshot(' '.repeat(2*1024*1024+1)),scope).coverage.state,'held_quality');
 assert.equal(municipalFinanceAdapter.parse({...snapshot('%PDF-1.7'),mimeType:'application/pdf'},scope).coverage.state,'held_quality');
 const admitted=snapshot(schwarz);
 assert.throws(()=>municipalFinanceAdapter.parse({...admitted,sourceSha256:'0'.repeat(64)},scope),/binding/);
 assert.throws(()=>municipalFinanceAdapter.parse({...admitted,policyReceiptSha256:'missing'},scope));
 assert.throws(()=>municipalFinanceAdapter.parse(admitted,{...scope,ags:'13076108'}),/mismatch/);
});

test('all nine catalog municipalities have held capabilities, Hagenow remains collection-blocked',()=>{
 const towns=[['strausberg','12064472'],['hoppegarten','12064227'],['ruedersdorf','12064428'],['ratzeburg','01053100'],['moelln','01053090'],['schwarzenbek','01053116'],['ludwigslust','13076090'],['parchim','13076108'],['hagenow','13076060']];
 for(const [id,ags] of towns) {
  const scoped={...scope,sourceId:id+'-finance-documents',municipalityId:id,ags};
  const receipt=municipalFinanceCapability(scoped);
  assert.equal(receipt.collectionPerformed,false);assert.deepEqual(receipt.implementedFormats,['html']);
  assert.equal(receipt.productionState,id==='hagenow'?'blocked_policy':'held_origin');
  assert.equal(receipt.contractSha256.length,64);
  assert.equal(municipalFinanceAdapter.parse(snapshot('<main><p><a href="/budget.pdf">Haushaltsplan 2026</a></p></main>'),scoped).coverage.state,'partial');
 }
});
