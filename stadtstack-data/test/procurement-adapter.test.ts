import assert from 'node:assert/strict';
import test from 'node:test';
import {digest, type AdmittedSnapshot, type AdapterScope} from '../src/district-adapter-contract.ts';
import {createProcurementAdapter, procurementAdapter, procurementCapabilityReceipt, procurementTedReferences} from '../src/adapters/procurement.ts';

const scope: AdapterScope = {publisherId: 'bkms', sourceId: 'procurement-bkms-opendata', municipalityId: 'ratzeburg', ags: '01053100', tenant: null, observationWindow: '2026-10-09'};
function snapshot(data: unknown, mimeType = 'application/json'): AdmittedSnapshot {
 const bytes = data instanceof Uint8Array ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
 return {bytes, sourceSha256: digest(bytes), url: 'https://oeffentlichevergabe.de/api/notice-exports?pubDay=2026-10-09&format=ocds.zip', mimeType, retrievedAt: '2026-10-11T12:00:00Z', policyReceiptSha256: digest('synthetic admitted fixture, not live rights permission'), sourceVersion: 'fixture-1'};
}
const packageFixture = {version: '1.1', releases: [{ocid: 'ocds-test-procedure-001', id: 'notice-001-01', date: '2026-10-09T09:00:00Z', tag: ['tender', 'award'], buyer: {id: 'ORG-0001'}, tender: {id: 'T1', title: 'School construction', status: 'active', value: {amount: 1200000, currency: 'EUR'}, lots: [{id: 'LOT-0001', title: 'Works'}, {id: 'LOT-0002', title: 'Services'}]}, awards: [{id: 'A1', status: 'active', date: '2026-10-08', relatedLots: ['LOT-0001'], value: {amount: 1100000, currency: 'EUR'}, suppliers: [{id: 'ORG-0002'}]}], contracts: [{id: 'C1', awardID: 'A1', dateSigned: '2026-10-09', status: 'active'}]}]};
// Stored native ZIP test writer: original member bytes, local/central headers and CRC, not a normalized parser input.
function nativeZip(files: Record<string, string>): Uint8Array {
 const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
 for (const [name, text] of Object.entries(files)) {
  const payload = Buffer.from(text), filename = Buffer.from(name); let crc = 0xffffffff;
  for (const byte of payload) {crc ^= byte; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
  crc = (crc ^ 0xffffffff) >>> 0;
  const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14); l.writeUInt32LE(payload.length, 18); l.writeUInt32LE(payload.length, 22); l.writeUInt16LE(filename.length, 26);
  local.push(l, filename, payload);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(payload.length, 20); c.writeUInt32LE(payload.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, filename); offset += l.length + filename.length + payload.length;
 }
 const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(Buffer.concat(central).length, 12); end.writeUInt32LE(offset, 16);
 return Buffer.concat([...local, ...central, end]);
}
const xmlFixture = `<ContractAwardNotice xmlns="urn:oasis:names:specification:ubl:schema:xsd:ContractAwardNotice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:efext="http://data.europa.eu/p27/eforms-ubl-extensions/1" xmlns:efac="http://data.europa.eu/p27/eforms-ubl-extension-aggregate-components/1">
<cbc:ID schemeName="notice-id">12345678-1234-1234-1234-123456789abc</cbc:ID><cbc:VersionID>01</cbc:VersionID><cbc:ContractFolderID>aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa</cbc:ContractFolderID><cbc:IssueDate>2026-10-09</cbc:IssueDate>
<cac:ContractingParty><cac:Party><cac:PartyIdentification><cbc:ID schemeName="organization">ORG-0001</cbc:ID></cac:PartyIdentification></cac:Party></cac:ContractingParty>
<cac:ProcurementProjectLot><cbc:ID schemeName="Lot">LOT-0001</cbc:ID><cac:ProcurementProject><cbc:Name>Works</cbc:Name></cac:ProcurementProject></cac:ProcurementProjectLot>
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><efext:EformsExtension><efac:NoticeResult>
<efac:LotResult><cbc:ID>RES-0001</cbc:ID><cbc:TenderResultCode>selec-w</cbc:TenderResultCode><efac:TenderLot><cbc:ID>LOT-0001</cbc:ID></efac:TenderLot><efac:LotTender><cbc:ID>TEN-0001</cbc:ID></efac:LotTender><efac:SettledContract><cbc:ID>CON-0001</cbc:ID></efac:SettledContract></efac:LotResult>
<efac:LotTender><cbc:ID>TEN-0001</cbc:ID><cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="EUR">1100000.00</cbc:PayableAmount></cac:LegalMonetaryTotal><efac:TenderingParty><cbc:ID>TPA-0001</cbc:ID></efac:TenderingParty></efac:LotTender>
<efac:TenderingParty><cbc:ID>TPA-0001</cbc:ID><efac:Tenderer><cbc:ID>ORG-0002</cbc:ID></efac:Tenderer></efac:TenderingParty>
<efac:SettledContract><cbc:ID>CON-0001</cbc:ID><cbc:AwardDate>2026-10-08</cbc:AwardDate><cbc:IssueDate>2026-10-09</cbc:IssueDate></efac:SettledContract>
</efac:NoticeResult></efext:EformsExtension></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions></ContractAwardNotice>`;

test('positive native OCDS ZIP separates tender, award, contract and lots, with raw evidence', () => {
 const s = snapshot(nativeZip({'notice.json': JSON.stringify(packageFixture)}), 'application/vnd.bekanntmachungsservice.ocds.zip+zip');
 const result = procurementAdapter.parse(s, scope);
 assert.equal(result.coverage.state, 'complete');
 assert.equal(result.observations.filter(o => o.predicate === 'awarded_to').length, 1);
 assert.equal(new Set(result.observations.filter(o => o.kind === 'Lot').map(o => o.subject)).size, 2);
 assert.equal(result.observations.find(o => o.predicate === 'estimated_value')?.financialRole, 'plan');
 assert.equal(result.observations.find(o => o.predicate === 'award_value')?.financialRole, 'approval');
 assert.ok(result.observations.every(o => o.financialRole !== 'payment' && o.financialRole !== 'actual' && o.geography.ags === null));
 assert.ok(result.observations.every(o => o.evidence[0]!.sourceSha256 === s.sourceSha256 && o.evidence[0]!.path.startsWith('notice.json#')));
 assert.deepEqual(procurementAdapter.parse(s, scope), result);
});

test('explicit withdrawn award has status and version but no awarded_to or deletion inference', () => {
 const fixture = structuredClone(packageFixture); fixture.releases[0]!.id = 'notice-001-02'; fixture.releases[0]!.awards[0]!.status = 'cancelled';
 const result = procurementAdapter.parse(snapshot(fixture), scope);
 assert.equal(result.coverage.state, 'complete');
 assert.ok(result.observations.some(o => o.kind === 'Award' && o.value === 'cancelled' && o.nativeVersion === 'notice-001-02'));
 assert.ok(!result.observations.some(o => o.predicate === 'awarded_to'));
 const before = procurementAdapter.parse(snapshot(packageFixture), scope);
 assert.notEqual(before.observations.find(o => o.kind === 'Notice')?.id, result.observations.find(o => o.kind === 'Notice')?.id);
 assert.equal(before.observations.find(o => o.kind === 'Award')?.subject, result.observations.find(o => o.kind === 'Award')?.subject);
});

test('original eForms maps only explicit winning-reference chain, preserves tender lexical amount', () => {
 const result = procurementAdapter.parse(snapshot(xmlFixture, 'application/xml'), scope);
 assert.equal(result.coverage.state, 'complete');
 const winner = result.observations.find(o => o.predicate === 'awarded_to');
 assert.ok(winner); assert.ok(winner.evidence.length >= 4);
 assert.equal(result.observations.find(o => o.predicate === 'tender_value')?.value, '1100000.00');
 assert.equal(result.observations.find(o => o.predicate === 'tender_value')?.financialRole, 'none');
 assert.ok(result.observations.some(o => o.dateRole === 'dispatch' && o.publishedAt === null));
 assert.ok(!result.observations.some(o => o.financialRole === 'payment' || o.predicate === 'completed'));
 const refs = procurementTedReferences(result); assert.equal(refs[0]?.method, 'POST');
 assert.equal(refs[0]?.url, 'https://api.ted.europa.eu/v3/notices/search');
 assert.match(refs[0]!.body!, /notice-identifier/);
 assert.equal(procurementTedReferences(procurementAdapter.parse(snapshot(packageFixture), scope)).length, 0);
});

test('native CSV 1:n joins notice version and lot, tolerates added columns, never treats preferred date as actual', () => {
 const s = snapshot(nativeZip({
  'notice.csv': 'noticeIdentifier,noticeVersion,procedureIdentifier,publicationDate,formType,newColumn\r\nN-001,01,P-001,2026-10-09,competition,ignored\r\nN-001,02,P-001,2026-10-10,result,ignored\r\n',
  'purpose.csv': 'noticeIdentifier,noticeVersion,lotIdentifier,title,estimatedValue,estimatedValueCurrency\r\nN-001,01,LOT-0001,"School, works",1200000.00,EUR\r\nN-001,02,LOT-0002,Services,9000.00,EUR\r\n',
  'tender.csv': 'noticeIdentifier,noticeVersion,tenderIdentifier,lotIdentifier,tenderValue,tenderValueCurrency\r\nN-001,02,TEN-0001,LOT-0002,8500.00,EUR\r\n',
  'placeOfPerformance.csv': 'noticeIdentifier,noticeVersion,lotIdentifier,placePerformanceCountrySubdivision\r\nN-001,02,LOT-0002,DEF06\r\n',
  'new-table.csv': 'new,fields\r\nignored,ignored\r\n',
 }), 'application/vnd.bekanntmachungsservice.csv.zip+zip');
 const result = procurementAdapter.parse(s, scope); assert.equal(result.coverage.state, 'complete');
 assert.equal(result.observations.find(o => o.predicate === 'title')?.evidence[0]?.format, 'csv');
 assert.ok(result.observations.some(o => o.value === 'School, works'));
 assert.ok(result.observations.filter(o => o.predicate === 'preferred_publication_date').every(o => o.publishedAt === null && o.dateRole === 'preferred_publication'));
 assert.ok(result.observations.some(o => o.value === 'DEF06' && o.geography.role === 'performance_location' && o.geography.ags === null));
 assert.ok(result.observations.filter(o => o.predicate === 'tenderValue').every(o => o.financialRole === 'none'));
});

test('changed native identity columns, dangling CSV references, changed OCDS and malformed XML hold all output', () => {
 for (const s of [snapshot({version: '2.0', releases: []}), snapshot({releases: [{ocid: 'x'}]}), snapshot('procedureIdentifier,noticeIdentifier\r\nP1,N1\r\n', 'text/csv'), snapshot(nativeZip({'notice.csv': 'noticeIdentifier,noticeVersion,procedureIdentifier\r\nN1,01,P1\r\n', 'tender.csv': 'noticeIdentifier,noticeVersion,tenderIdentifier\r\nN1,02,T1\r\n'})), snapshot('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + xmlFixture, 'application/xml')]) {
  const result = procurementAdapter.parse(s, scope); assert.equal(result.coverage.state, 'held_quality'); assert.deepEqual(result.observations, []);
 }
});

test('empty native ZIP/release package/search do not imply withdrawals or no spending', () => {
 for (const s of [snapshot(nativeZip({}), 'application/zip'), snapshot({version: '1.1', releases: []})]) {const result = procurementAdapter.parse(s, scope); assert.equal(result.coverage.state, 'empty'); assert.deepEqual(result.observations, []);}
 assert.equal(procurementAdapter.parse(snapshot({notices: [], totalNoticeCount: 0}), {...scope, sourceId: 'procurement-ted'}).coverage.state, 'empty');
});

test('completed publication-day discovery stays Europe/Berlin scoped, supports all three original formats and paginates', () => {
 const seed = snapshot({openapi: '3.1.0', paths: {'/api/notice-exports': {get: {}}}});
 for (const format of ['ocds.zip', 'eforms.zip', 'csv.zip'] as const) {
  const adapter = createProcurementAdapter({format}); const window = {...scope, observationWindow: '2026-10-08/2026-10-09'};
  const first = adapter.discover(seed, window, null); assert.equal(first.coverage.state, 'partial'); assert.equal(first.coverage.nextCursor, '2026-10-09'); assert.match(first.resources[0]!.url, new RegExp('pubDay=2026-10-08&format=' + format));
  assert.equal(adapter.discover(seed, window, first.coverage.nextCursor).coverage.state, 'complete');
 }
 assert.equal(procurementAdapter.discover(seed, {...scope, observationWindow: '2026-10-11'}, null).coverage.state, 'held_quality');
 assert.equal(procurementAdapter.discover(seed, {...scope, observationWindow: '2022-11-30'}, null).coverage.state, 'held_quality');
 const midnight = {...seed, retrievedAt: '2026-10-10T22:30:00Z'};
 assert.equal(procurementAdapter.discover(midnight, {...scope, observationWindow: '2026-10-11'}, null).coverage.state, 'held_quality');
 assert.equal(procurementAdapter.discover(seed, scope, '2026-10-12').coverage.state, 'held_quality');
});

test('native TED v3 iteration response produces bounded POST continuation, with all versions and explicit IDs', () => {
 const tedScope = {...scope, sourceId: 'procurement-ted', publisherId: 'ted'};
 const fixture = {notices: [{'notice-identifier': 'N-001', 'notice-version': 2, 'procedure-identifier': 'P-001', 'publication-number': '123456-2026', 'publication-date': '20261009'}], totalNoticeCount: 2, iterationNextToken: 'opaque-token', timedOut: false};
 const s = snapshot(fixture), adapter = createProcurementAdapter({tedQuery: 'notice-identifier = N-001'});
 const result = adapter.parse(s, tedScope); assert.equal(result.coverage.state, 'partial'); assert.equal(result.coverage.nextCursor, 'opaque-token');
 assert.ok(result.observations.some(o => o.publishedAt === '2026-10-09'));
 const discovered = adapter.discover(s, tedScope, null), body = JSON.parse(discovered.resources[0]!.body!);
 assert.equal(discovered.resources[0]?.method, 'POST'); assert.equal(body.paginationMode, 'ITERATION'); assert.equal(body.onlyLatestVersions, false); assert.equal(body.iterationNextToken, 'opaque-token');
 assert.equal(adapter.parse(snapshot({...fixture, iterationNextToken: undefined, timedOut: true}), tedScope).coverage.state, 'partial');
 assert.equal(adapter.parse(snapshot({notices: [{'title': 'School construction'}], totalNoticeCount: 1}), tedScope).coverage.state, 'held_quality');
 assert.equal(procurementAdapter.discover(s, tedScope, null).coverage.state, 'not_checked');
});

test('access interstitials and byte mismatches never become successful/empty import', () => {
 const blocked = procurementAdapter.parse(snapshot('<html>login required</html>', 'text/html'), scope); assert.equal(blocked.coverage.state, 'blocked_access'); assert.deepEqual(blocked.observations, []);
 const s = snapshot(packageFixture); assert.throws(() => procurementAdapter.parse({...s, sourceSha256: digest('different bytes')}, scope), /byte binding/);
 assert.equal(procurementCapabilityReceipt.liveCollection, 'not_checked'); assert.match(procurementCapabilityReceipt.rights, /held_origin/);
});

test('explicit European ID and numeric version semantics unify only notice identity, never a matching title', () => {
 const federal = procurementAdapter.parse(snapshot(xmlFixture, 'application/xml'), scope);
 const tedScope = {...scope, sourceId: 'procurement-ted', publisherId: 'ted'};
 const cross = procurementAdapter.parse(snapshot({notices: [{'notice-identifier': '12345678-1234-1234-1234-123456789abc', 'notice-version': 1, 'procedure-identifier': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'publication-date': '2026-10-09'}], totalNoticeCount: 1}), tedScope);
 assert.equal(federal.observations.find(o => o.kind === 'Notice')?.subject, cross.observations.find(o => o.kind === 'Notice')?.subject);
 assert.equal(federal.observations.find(o => o.kind === 'Notice')?.nativeVersion, '01');
 assert.equal(cross.observations.find(o => o.kind === 'Notice')?.nativeVersion, '1');
 const other = procurementAdapter.parse(snapshot({notices: [{'notice-identifier': 'DIFFERENT', 'notice-version': 1, 'procedure-identifier': 'DIFFERENT', title: 'Works'}], totalNoticeCount: 1}), tedScope);
 assert.notEqual(federal.observations.find(o => o.kind === 'Notice')?.subject, other.observations.find(o => o.kind === 'Notice')?.subject);
 const fakeNamespace = xmlFixture.replace('urn:oasis:names:specification:ubl:schema:xsd:ContractAwardNotice-2', 'urn:unrelated');
 assert.equal(procurementAdapter.parse(snapshot(fakeNamespace, 'application/xml'), scope).coverage.state, 'held_quality');
});

test('zone-qualified native xsd:date validates calendar and keeps original date offsets in evidence', () => {
 for (const zone of ['+01:00', '-05:30', 'Z', '+14:00', '-14:00']) {
  const xml = xmlFixture.replaceAll('2026-10-09</cbc:IssueDate>', '2026-10-09' + zone + '</cbc:IssueDate>').replace('2026-10-08</cbc:AwardDate>', '2026-10-08' + zone + '</cbc:AwardDate>');
  const result = procurementAdapter.parse(snapshot(xml, 'application/xml'), scope);
  assert.equal(result.coverage.state, 'complete');
  const dispatch = result.observations.find(o => o.dateRole === 'dispatch');
  assert.equal(dispatch?.date, '2026-10-09');
  assert.equal(dispatch?.sourceReferenceDate, '2026-10-09');
  assert.equal(dispatch?.evidence[0]?.rawValue, '2026-10-09' + zone);
  const decision = result.observations.find(o => o.dateRole === 'award_decision');
  assert.equal(decision?.date, '2026-10-08'); assert.equal(decision?.evidence[0]?.rawValue, '2026-10-08' + zone);
 }
 for (const invalid of ['2026-02-30+01:00', '2026-10-09+14:01', '2026-10-09+15:00', '2026-10-09+01:60']) {
  const result = procurementAdapter.parse(snapshot(xmlFixture.replace('2026-10-09</cbc:IssueDate>', invalid + '</cbc:IssueDate>'), 'application/xml'), scope);
  assert.equal(result.coverage.state, 'held_quality'); assert.deepEqual(result.observations, []);
 }
});

test('same-procedure notices and versions may reuse eForms ORG/RES/TEN/CON/TPA without identity collisions', () => {
 const anotherNotice = xmlFixture.replace('12345678-1234-1234-1234-123456789abc', '87654321-4321-4321-4321-cba987654321');
 const anotherVersion = xmlFixture.replace('<cbc:VersionID>01</cbc:VersionID>', '<cbc:VersionID>02</cbc:VersionID>');
 const result = procurementAdapter.parse(snapshot(nativeZip({'first.xml': xmlFixture, 'second.xml': anotherNotice, 'version.xml': anotherVersion}), 'application/vnd.bekanntmachungsservice.eforms.zip+zip'), scope);
 assert.equal(result.coverage.state, 'complete');
 for (const kind of ['Award', 'Tender', 'Contract', 'Buyer']) assert.equal(new Set(result.observations.filter(o => o.kind === kind).map(o => o.subject)).size, 3);
 assert.equal(new Set(result.observations.filter(o => o.predicate === 'awarded_to').map(o => o.value)).size, 3);
 assert.equal(new Set(result.observations.filter(o => o.predicate === 'tendering_party_reference').map(o => o.value)).size, 3);
 assert.equal(new Set(result.observations.filter(o => o.kind === 'Lot').map(o => o.subject)).size, 1);
 for (const winner of result.observations.filter(o => o.predicate === 'awarded_to')) {
  assert.ok(winner.evidence.length >= 4);
  assert.ok(winner.evidence.every(e => e.path.startsWith(winner.evidence[0]!.path.split('#')[0]! + '#')));
 }
});

test('CSV notice/version scopes isolate reused technical tender, contract and result IDs but retain lot scope', () => {
 const result = procurementAdapter.parse(snapshot(nativeZip({
  'notice.csv': 'noticeIdentifier,noticeVersion,procedureIdentifier\r\nN1,01,P1\r\nN2,01,P1\r\nN1,02,P1\r\n',
  'purpose.csv': 'noticeIdentifier,noticeVersion,lotIdentifier,title\r\nN1,01,LOT-0001,Works\r\nN2,01,LOT-0001,Works\r\nN1,02,LOT-0001,Works\r\n',
  'tender.csv': 'noticeIdentifier,noticeVersion,tenderIdentifier,tenderValue,tenderValueCurrency\r\nN1,01,TEN-0001,100.00,EUR\r\nN2,01,TEN-0001,200.00,EUR\r\nN1,02,TEN-0001,300.00,EUR\r\n',
  'contract.csv': 'noticeIdentifier,noticeVersion,contractIdentifier,winnerDecisionDate\r\nN1,01,CON-0001,2026-10-08+01:00\r\nN2,01,CON-0001,2026-10-08Z\r\nN1,02,CON-0001,2026-10-09+02:00\r\n',
  'procedureLotResult.csv': 'noticeIdentifier,noticeVersion,lotIdentifier,winnerChosen\r\nN1,01,LOT-0001,selec-w\r\nN2,01,LOT-0001,selec-w\r\nN1,02,LOT-0001,selec-w\r\n',
 }), 'application/vnd.bekanntmachungsservice.csv.zip+zip'), scope);
 assert.equal(result.coverage.state, 'complete');
 for (const kind of ['Tender', 'Contract', 'LotResult']) assert.equal(new Set(result.observations.filter(o => o.kind === kind).map(o => o.subject)).size, 3);
 assert.equal(new Set(result.observations.filter(o => o.kind === 'Lot').map(o => o.subject)).size, 1);
 assert.ok(result.observations.filter(o => o.dateRole === 'award_decision').every(o => o.date === '2026-10-08' || o.date === '2026-10-09'));
});

test('only exactly active OCDS awards carry approval-role amounts', () => {
 for (const status of ['pending', 'cancelled', 'unsuccessful', 'active', 'unknown']) {
  const fixture = structuredClone(packageFixture); fixture.releases[0]!.awards[0]!.status = status;
  const result = procurementAdapter.parse(snapshot(fixture), scope);
  assert.equal(result.coverage.state, 'complete');
  assert.equal(result.observations.find(o => o.predicate === 'award_value')?.financialRole, status === 'active' ? 'approval' : 'none');
  assert.equal(result.observations.filter(o => o.predicate === 'awarded_to').length, status === 'active' ? 1 : 0);
 }
});
