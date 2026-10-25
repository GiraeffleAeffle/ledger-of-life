import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createCouncilAdapter, councilAdapter, councilCapabilityReceipt} from '../src/adapters/council.ts';
import {digest, semanticHash, ObservationSchema} from '../src/district-adapter-contract.ts';
import type {AdmittedSnapshot, AdapterScope, StructuredLocator} from '../src/district-adapter-contract.ts';

// Hand-authored native fixtures: no claim that these bytes were fetched from the catalog publishers.
const at = '2026-10-10T12:00:00.000Z';
const base = 'https://strausberg.allris.cloud/';
const scope: AdapterScope = {publisherId: 'stadt-strausberg', sourceId: 'council-strausberg', municipalityId: 'strausberg', ags: '12064472', tenant: null, observationWindow: '2026'};
function snapshot(value: unknown, url = base + 'body/1/paper', html = false): AdmittedSnapshot {
 const bytes = new TextEncoder().encode(html ? String(value) : JSON.stringify(value));
 return {sourceSha256: digest(bytes), bytes, url, mimeType: html ? 'text/html' : 'application/json', retrievedAt: at, policyReceiptSha256: 'a'.repeat(64), sourceVersion: 'fixture-v1'};
}
const paper = {id: base + 'body/1/paper/7', type: 'https://schema.oparl.org/1.1/Paper', body: base + 'body/1', name: 'Wärmeplanung', date: '2026-04-01', reference: 'BV/7/2026', modified: '2026-04-02T10:00:00Z', mainFile: {downloadUrl: base + 'files/7.pdf'}, person: ['must-not-import'], contactEmail: 'must-not-import'};
const bindingEvidence: StructuredLocator = {sourceSha256: 'b'.repeat(64), format: 'json', nativeId: 'registry/strausberg', path: '/councilBodyId', sheet: null, rowKey: null, cells: [], rawValue: base + 'body/1', schemaHash: semanticHash('fixture registry'), mappingVersion: 'fixture-registry-v1'};

test('OParl paper metadata has native version, immutable raw evidence, and no invented resolution', () => {
 const s = snapshot({data: [paper], pagination: {currentPage: 1, totalPages: 1, totalElements: 1}});
 const result = councilAdapter.parse(s, scope);
 assert.equal(result.coverage.state, 'partial');
 assert.equal(result.observations.find(o => o.predicate === 'paper_date')?.dateRole, 'paper');
 assert.equal(result.observations.find(o => o.predicate === 'paper_date')?.date, '2026-04-01');
 assert(result.observations.every(o => o.nativeVersion === paper.modified && o.geography.ags === null && o.financialRole === 'none'));
 assert(!JSON.stringify(result).includes('must-not-import'));
 assert(!result.observations.some(o => /adopt|paid|final|completed/.test(o.predicate)));
 for (const o of result.observations) {ObservationSchema.parse(o); assert.equal(o.evidence[0].sourceSha256, s.sourceSha256);}
 assert.equal(result.observations.find(o => o.predicate === 'reference')?.evidence[0].rawValue, 'BV/7/2026');
 assert.deepEqual(councilAdapter.parse(s, scope), result);
 assert.equal(councilAdapter.discover(s, scope, null).resources[0].url, base + 'files/7.pdf');
});

test('Body/tenant AGS joins require separately evidenced exact bindings, not requested scope', () => {
 const adapter = createCouncilAdapter({bodyBindings: [{sourceId: scope.sourceId, tenant: null, bodyId: base + 'body/1', ags: scope.ags, evidence: bindingEvidence}]});
 const s = snapshot({data: [paper]});
 const joined = adapter.parse(s, scope).observations;
 assert(joined.length > 0 && joined.every(o => o.geography.ags === scope.ags && o.geography.basis === 'verified_join' && o.evidence.length === 1));
 assert(joined.every(o => o.evidence[0].sourceSha256 === s.sourceSha256 && o.supportingEvidence.length === 1 && o.supportingEvidence[0].role === 'municipality_join'));
 assert(joined.every(o => o.supportingEvidence[0].locator.sourceSha256 === bindingEvidence.sourceSha256));
 const tenantChanged = adapter.parse(s, {...scope, tenant: 'another-body'}).observations;
 assert(tenantChanged.every(o => o.geography.ags === null));
 assert(tenantChanged.every(o => o.supportingEvidence.length === 0 && o.evidence[0].sourceSha256 === s.sourceSha256));
 assert.throws(() => createCouncilAdapter({bodyBindings: [{sourceId: scope.sourceId, tenant: null, bodyId: base + 'body/1', ags: '12064', evidence: bindingEvidence}]}), /eight digits/);
 const districtScope = {...scope, sourceId: 'district-council-mol'};
 const districtPaper = {...paper, id: 'https://www.ratsinfo-online.net/landkreis-mol-bi/paper/7', body: 'https://www.ratsinfo-online.net/landkreis-mol-bi/body/1'};
 const district = councilAdapter.parse(snapshot({data: [districtPaper]}, 'https://www.ratsinfo-online.net/landkreis-mol-bi/paper'), districtScope);
 assert(district.observations.length > 0 && district.observations.every(o => o.geography.ags === null));
});

test('Meetings and embedded agenda decisions preserve distinct roles and document references', () => {
 const meeting = {id: base + 'meeting/9', type: 'https://schema.oparl.org/1.1/Meeting', body: base + 'body/1', start: '2026-05-01T18:00:00+02:00', created: '2026-04-01T12:00:00Z', organization: [base + 'organization/1'], agendaItem: [{id: base + 'agenda/3', type: 'https://schema.oparl.org/1.1/AgendaItem', meeting: base + 'meeting/9', paper: paper.id, number: '3', resolutionText: 'Antrag zur Beratung zurückgestellt.'}], participant: ['private person']};
 const result = councilAdapter.parse(snapshot({data: [meeting]}, base + 'meeting'), scope);
 assert.equal(result.observations.find(o => o.predicate === 'meeting_start')?.dateRole, 'scheduled_meeting');
 assert.equal(result.observations.find(o => o.predicate === 'source_created')?.dateRole, 'source_created');
 assert.equal(result.observations.find(o => o.predicate === 'references_paper')?.value, paper.id);
 const resolution = result.observations.find(o => o.predicate === 'resolution_text');
 assert.equal(resolution?.date, null); assert.equal(resolution?.dateRole, null);
 assert.equal(resolution?.evidence[0].path, '/data/0/agendaItem/0/resolutionText');
 assert(!JSON.stringify(result).includes('private person'));
});

test('Cancelled OParl meeting dates and embedded agendas are not held events', () => {
 const meeting = {id: base + 'meeting/cancelled', type: 'https://schema.oparl.org/1.1/Meeting', start: '2026-05-01T18:00:00+02:00', end: '2026-05-01T20:00:00+02:00', cancelled: true, meetingState: 'cancelled', agendaItem: [{id: base + 'agenda/cancelled', type: 'https://schema.oparl.org/1.1/AgendaItem', meeting: base + 'meeting/cancelled', paper: paper.id}]};
 const s = snapshot({data: [meeting]}, base + 'meeting');
 const result = councilAdapter.parse(s, scope);
 const cancelled = result.observations.find(o => o.kind === 'Meeting' && o.predicate === 'meeting_cancelled');
 assert.equal(cancelled?.value, true); assert.equal(cancelled?.evidence[0].rawValue, true);
 assert.equal(cancelled?.evidence[0].path, '/data/0/cancelled');
 assert.equal(result.observations.find(o => o.predicate === 'meeting_state')?.value, 'cancelled');
 assert(result.observations.filter(o => ['meeting_start', 'meeting_end'].includes(o.predicate)).every(o => o.dateRole === 'cancelled_meeting_schedule'));
 assert(!result.observations.some(o => o.dateRole === 'meeting'));
 const agendaState = result.observations.find(o => o.kind === 'AgendaItem' && o.predicate === 'parent_meeting_cancelled');
 assert.equal(agendaState?.value, true); assert.equal(agendaState?.evidence[0].path, '/data/0/cancelled');
 assert.equal(agendaState?.evidence[0].sourceSha256, s.sourceSha256);
 assert.equal(result.observations.find(o => o.predicate === 'parent_meeting_state')?.value, 'cancelled');
 assert(result.observations.some(o => o.predicate === 'references_paper' && o.value === paper.id));
});

test('Native meetingState remains attributed; only explicit held state supplies meeting event role', () => {
 const native = {id: base + 'meeting/state', type: 'https://schema.oparl.org/1.1/Meeting', start: '2026-05-01T18:00:00+02:00'};
 for (const [meetingState, cancelled, role] of [
  ['invited', false, 'scheduled_meeting'], ['held', false, 'meeting'],
  ['cancelled', false, 'cancelled_meeting_schedule'], ['held', true, 'cancelled_meeting_schedule'],
  ['unknown-new-state', false, 'scheduled_meeting'],
 ] as const) {
  const result = councilAdapter.parse(snapshot({data: [{...native, meetingState, cancelled}]}, base + 'meeting'), scope);
  assert.equal(result.observations.find(o => o.predicate === 'meeting_state')?.value, meetingState);
  assert.equal(result.observations.find(o => o.predicate === 'meeting_cancelled')?.value, cancelled);
  assert.equal(result.observations.find(o => o.predicate === 'meeting_start')?.dateRole, role);
 }
 const malformed = councilAdapter.parse(snapshot({data: [{...native, cancelled: 'true'}]}, base + 'meeting'), scope);
 assert.equal(malformed.coverage.state, 'held_quality'); assert.deepEqual(malformed.observations, []);
 const malformedState = councilAdapter.parse(snapshot({data: [{...native, meetingState: true}]}, base + 'meeting'), scope);
 assert.equal(malformedState.coverage.state, 'held_quality');
});

test('Native empty and paginated envelopes differ; next page is admitted separately', () => {
 assert.equal(councilAdapter.parse(snapshot({data: []}), scope).coverage.state, 'empty');
 const url = base + 'body/1/paper?page=2';
 const s = snapshot({data: [paper], links: {next: url}, pagination: {currentPage: 1, totalPages: 2}});
 const discovered = councilAdapter.discover(s, scope, null);
 assert.equal(discovered.coverage.state, 'partial'); assert.equal(discovered.coverage.nextCursor, url);
 assert(discovered.resources.some(r => r.url === url && r.parentId === s.url));
 assert.throws(() => councilAdapter.discover(s, scope, url), /Cursor/);
 assert.equal(councilAdapter.parse(snapshot({data: [paper], pagination: {currentPage: 1, totalPages: 2}}), scope).coverage.state, 'held_quality');
 assert.equal(councilAdapter.parse(snapshot({data: [], links: {next: 'https://other.example/page'}}), scope).coverage.state, 'held_quality');
});

test('Changed native schema is held; Person objects/lists are never imported', () => {
 for (const value of [{items: [paper]}, {data: [{...paper, type: 'https://schema.oparl.org/2.0/Paper'}]}, {data: [{id: base + 'person/1', type: 'https://schema.oparl.org/1.1/Person', name: 'Private name'}]}]) {
  const result = councilAdapter.parse(snapshot(value), scope); assert.equal(result.coverage.state, 'held_quality'); assert.deepEqual(result.observations, []);
 }
 const html = snapshot('<title>New unrelated schema</title><article>No native metadata</article>', base + 'public/si010', true);
 assert.equal(councilAdapter.parse(html, scope).coverage.state, 'held_quality');
});

test('Tombstones remove active fields and document discovery; omission is not withdrawal', () => {
 const s = snapshot({data: [{...paper, deleted: true}]});
 const result = councilAdapter.parse(s, scope);
 assert.equal(result.observations.length, 1); assert.equal(result.observations[0].predicate, 'withdrawn');
 assert.equal(result.observations[0].value, true); assert.equal(result.observations[0].nativeVersion, paper.modified);
 assert.deepEqual(councilAdapter.discover(s, scope, null).resources, []);
 assert.equal(councilAdapter.parse(snapshot({data: []}), scope).observations.length, 0);
});

test('Public ALLRIS native HTML preserves meeting versus explicit resolution dates', () => {
 const html = '<title>ALLRIS Sitzung</title><table><tr><th>Sitzungsdatum:</th><td> 01.05.2026 </td></tr><tr><th>Beschlussdatum</th><td>02.05.2026</td></tr><tr><th>Beschlussnummer</th><td>BR/9/2026</td></tr><tr><th>Gremium</th><td><a href="gr020?GRLFDNR=1">Stadtvertretung</a></td></tr></table><a href="to020?TOLFDNR=3">TOP 3</a><a href="pe010?PERLFDNR=2">Private person</a><a href="/files/beschluss.pdf">Beschluss</a>';
 const s = snapshot(html, base + 'public/si005?SILFDNR=9', true);
 const result = councilAdapter.parse(s, scope);
 assert.equal(result.observations.find(o => o.predicate === 'meeting_date')?.date, '2026-05-01');
 assert.equal(result.observations.find(o => o.predicate === 'meeting_date')?.evidence[0].rawValue, ' 01.05.2026 ');
 assert.equal(result.observations.find(o => o.predicate === 'resolution_date')?.dateRole, 'resolution');
 assert.equal(result.observations.find(o => o.predicate === 'resolution_date')?.date, '2026-05-02');
 assert(!JSON.stringify(result).includes('Private person'));
 assert(councilAdapter.discover(s, scope, null).resources.some(r => r.url.endsWith('beschluss.pdf')));
 assert(!result.observations.some(o => o.predicate === 'adopts'));
});

test('Native OParl result and administrative organization origin remain separate attributed fields', () => {
 const agenda = {id: base + 'agenda/result', type: 'https://schema.oparl.org/1.1/AgendaItem', result: '  vertagt  ', number: '4', resolutionText: 'Weitere Beratung erforderlich.', voteResults: {yes: 9, no: 1}, originatorPerson: [base + 'person/private']};
 const s = snapshot(agenda, agenda.id);
 const result = councilAdapter.parse(s, scope);
 const status = result.observations.find(o => o.predicate === 'decision_result');
 assert.equal(status?.value, '  vertagt  '); assert.equal(status?.evidence[0].rawValue, '  vertagt  ');
 assert.equal(status?.evidence[0].path, '/result'); assert.equal(status?.evidence[0].sourceSha256, s.sourceSha256);
 assert.equal(status?.dateRole, null); assert.equal(status?.financialRole, 'none');
 assert(status?.limitations.some(value => value.includes('not a legal-stage ladder')));
 assert(!result.observations.some(o => /adopt|in_force|paid|proposing/.test(o.predicate)));
 assert(!JSON.stringify(result).includes('/person/private'));
 const origin = councilAdapter.parse(snapshot({...paper, originatorOrganization: [base + 'organization/administration'], originatorPerson: [base + 'person/private'], author: 'Private account'}, paper.id), scope);
 assert.equal(origin.observations.find(o => o.predicate === 'administrative_origin_organization')?.value, base + 'organization/administration');
 assert.equal(origin.observations.find(o => o.predicate === 'administrative_origin_organization')?.evidence[0].path, '/originatorOrganization/0');
 assert(!origin.observations.some(o => o.predicate.startsWith('proposing_')));
 assert(!JSON.stringify(origin).includes('Private account')); assert(!JSON.stringify(origin).includes('/person/private'));
});

test('Explicit native ALLRIS decision/proposer labels preserve exact raw source values without stage inference', () => {
 const html = '<title>ALLRIS Vorlage</title><table><tr><th>Beschluss:</th><td> beschlossen mit Änderungen </td></tr><tr><th>Ergebnis</th><td>zurückgestellt</td></tr><tr><th>Antragsteller</th><td>SPD-Fraktion</td></tr><tr><th>Fraktion</th><td>Bündnis 90/Die Grünen</td></tr><tr><th>Antragsteller (Organisation)</th><td>Stadtverwaltung</td></tr><tr><th>Antragsteller</th><td>Private Person</td></tr></table>';
 const s = snapshot(html, base + 'public/vo005?VOLFDNR=71', true);
 const result = councilAdapter.parse(s, scope);
 const statuses = result.observations.filter(o => o.predicate === 'decision_result');
 assert.deepEqual(statuses.map(o => o.value).sort(), [' beschlossen mit Änderungen ', 'zurückgestellt']);
 assert(statuses.every(o => o.evidence[0].rawValue === o.value && o.evidence[0].sourceSha256 === s.sourceSha256 && o.date === null));
 assert(result.observations.some(o => o.predicate === 'proposing_faction' && o.value === 'SPD-Fraktion'));
 assert(result.observations.some(o => o.predicate === 'proposing_faction' && o.value === 'Bündnis 90/Die Grünen'));
 assert(result.observations.some(o => o.predicate === 'proposing_organization' && o.value === 'Stadtverwaltung'));
 assert(!JSON.stringify(result).includes('Private Person'));
 assert(!result.observations.some(o => /adopt|paid|in_force|member_of/.test(o.predicate)));
});

test('Absent or blank status/proposer fields remain unchecked; votes/title/account do not manufacture them', () => {
 const meeting = {id: base + 'meeting/no-result', type: 'https://schema.oparl.org/1.1/Meeting', start: '2026-05-01', name: 'Beschluss der SPD-Fraktion', votes: {yes: 9}, author: 'Account Name'};
 const native = councilAdapter.parse(snapshot({data: [meeting]}, base + 'meeting'), scope);
 assert(!native.observations.some(o => o.predicate === 'decision_result' || o.predicate.startsWith('proposing_')));
 const blank = councilAdapter.parse(snapshot({id: base + 'agenda/blank', type: 'https://schema.oparl.org/1.1/AgendaItem', result: ' '}, base + 'agenda/blank'), scope);
 assert(!blank.observations.some(o => o.predicate === 'decision_result'));
 const html = '<title>ALLRIS Beschluss der Fraktion X</title><table><tr><th>Ergebnis</th><td> </td></tr><tr><th>Fraktion</th><td></td></tr><tr><th>Autor</th><td>Private account</td></tr><tr><th>Antragsteller</th><td><a href=\"pe010?PERLFDNR=9\">Private proposer SPD-Fraktion</a></td></tr><tr><th>Antragsteller</th><td>Person aus Fraktion X</td></tr><tr><th>Fraktion</th><td><a href=\"pe010?PERLFDNR=10\">Private person linked as faction</a></td></tr><tr><th>Abstimmung</th><td>9 Ja, 1 Nein</td></tr></table>';
 const parsed = councilAdapter.parse(snapshot(html, base + 'public/vo005?VOLFDNR=72', true), scope);
 assert(!parsed.observations.some(o => o.predicate === 'decision_result' || o.predicate.startsWith('proposing_')));
 assert(!JSON.stringify(parsed).includes('Private proposer')); assert(!JSON.stringify(parsed).includes('Private account')); assert(!JSON.stringify(parsed).includes('Private person linked as faction'));
 const malformed = councilAdapter.parse(snapshot({id: base + 'agenda/bad-result', type: 'https://schema.oparl.org/1.1/AgendaItem', result: {adopted: true}}, base + 'agenda/bad-result'), scope);
 assert.equal(malformed.coverage.state, 'held_quality');
});

test('Observed Ratzeburg SessionNet /bi/ meeting and getfile routes remain discoverable', () => {
 const ratzScope = {...scope, sourceId: 'council-ratzeburg', ags: '01053100'};
 const s = snapshot('<title>SessionNet</title><a href="/bi/si0057.php?__ksinr=4115">Finanzausschuss</a><a href="/bi/getfile.php?id=71756&amp;type=do">Jahresabschluss</a>', 'https://session.ratzeburg.de/ri/?fdirect=1', true);
 const result = councilAdapter.discover(s, ratzScope, null);
 assert.equal(result.resources.length, 2);
 assert(result.resources.some(r => r.url === 'https://session.ratzeburg.de/bi/getfile.php?id=71756&type=do'));
});

test('HTML native empty, paginated and shared-Amt body scopes remain honest', () => {
 const amtScope = {...scope, sourceId: 'amt-buechen', tenant: 'buechen'};
 const amtBase = 'https://sessionnet.amt-buechen.de/bi/';
 const empty = snapshot('<title>SessionNet Sitzungskalender</title><table></table>', amtBase + 'si010', true);
 assert.equal(councilAdapter.parse(empty, amtScope).coverage.state, 'empty');
 const s = snapshot('<title>SessionNet</title><table><tr><td><a href="gr0040.php?__kgrnr=4">Gemeindevertretung</a></td><td><a href="si0057.php?__ksinr=7">Sitzung</a></td></tr></table><a rel="next" href="si010?page=2">Weiter</a>', amtBase + 'si010', true);
 const result = councilAdapter.parse(s, amtScope);
 assert.equal(result.coverage.nextCursor, amtBase + 'si010?page=2');
 assert(result.observations.length > 0 && result.observations.every(o => o.geography.ags === null));
 assert(result.observations.some(o => o.predicate === 'belongs_to_body'));
});

test('Catalog access blockers remain blocked and never become parser-ready empty sources', () => {
 for (const [sourceId, url] of Object.entries({'district-council-lup': 'https://bis.kreis-lup.de/', 'amt-maerkische-schweiz': 'https://amt-maerkische-schweiz.ratsinfomanagement.net/', 'council-hagenow': 'https://hagenow.sitzung-mv.de/ratsinfo/logon', 'amt-ms-buckow': 'https://amt-maerkische-schweiz.ratsinfomanagement.net/buckow/'})) {
  const s = snapshot('<title>Blocked</title>', url, true), bound = {...scope, sourceId};
  assert.equal(councilAdapter.parse(s, bound).coverage.state, 'blocked_access');
  assert.deepEqual(councilAdapter.discover(s, bound, null).resources, []);
 }
 assert.equal(councilAdapter.parse(snapshot('<input type="password">', base, true), scope).coverage.state, 'blocked_access');
});

test('Byte binding, resource bounds and tenant/source escapes fail closed', () => {
 const s = snapshot({data: [paper]});
 assert.throws(() => councilAdapter.parse({...s, sourceSha256: 'c'.repeat(64)}, scope), /byte binding/);
 assert.equal(createCouncilAdapter({maxBytes: 2}).parse(s, scope).coverage.state, 'held_quality');
 assert.equal(createCouncilAdapter({maxRecords: 0}).parse(s, scope).coverage.state, 'held_quality');
 assert.equal(councilAdapter.parse(snapshot({data: [paper]}, 'https://other.example/paper'), scope).coverage.state, 'held_quality');
 const molScope = {...scope, sourceId: 'district-council-mol'};
 const mol = snapshot('<title>ALLRIS</title><a rel="next" href="/different-tenant/si010">Weiter</a>', 'https://www.ratsinfo-online.net/landkreis-mol-bi/si010_e.asp', true);
 assert.equal(councilAdapter.discover(mol, molScope, null).coverage.state, 'held_quality');
});

test('Capability/source contract supplements all nine towns, three districts and four Amt roots', () => {
 const receipt = councilCapabilityReceipt();
 assert.equal(receipt.peopleImport, false); assert.equal(receipt.network, false); assert.equal(receipt.collection, 'not_run');
 const contract = JSON.parse(readFileSync(new URL('../sources/council-contract.json', import.meta.url), 'utf8'));
 const ids: string[] = contract.sources.map((s: {id: string}) => s.id);
 assert.equal(ids.filter(id => id.startsWith('council-')).length, 9);
 assert.equal(ids.filter(id => id.startsWith('district-council-')).length, 3);
 for (const id of ['amt-maerkische-schweiz', 'amt-lauenburgische-seen', 'amt-ludwigslust-land', 'amt-buechen']) assert(ids.includes(id));
 assert.deepEqual(receipt.sourceIds, ids.sort());
});
