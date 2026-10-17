import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, semanticHash, type AdapterScope, type AdmittedSnapshot, type StructuredLocator } from '../src/district-adapter-contract.ts';
import { parseFundingOperations, fundingOperationsAdapter } from '../src/adapters/funding-operations.ts';
import { createCouncilAdapter } from '../src/adapters/council.ts';
import { procurementAdapter } from '../src/adapters/procurement.ts';
import { nativeStructuredIdentityGraph, resolveIdentityMentions } from '../src/district-entity-resolution.ts';
import { admitStructuredObservations } from '../src/district-structured-record.ts';

// Synthetic original-format bytes and synthetic policy proofs only; no live acquisition or provider calls.
const at = '2026-10-11T00:00:00Z';
function snapshot(value: string | object, url: string, mimeType: string): AdmittedSnapshot {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { bytes, sourceSha256: digest(bytes), url, mimeType, retrievedAt: at, policyReceiptSha256: digest('synthetic policy proof'), sourceVersion: 'fixture-1' };
}
function scope(sourceId: string, publisherId = 'fixture'): AdapterScope {
  return { publisherId, sourceId, municipalityId: 'ratzeburg', ags: '01053100', tenant: null, observationWindow: '2026-10-09' };
}

test('funding parser v2 survives exact admission replay with operation, recipient and explicit programme identities', async () => {
  const binding = scope('funding-sh-efre-beneficiaries');
  const bytes = 'Vorhabennummer;Name des Begünstigten;Bezeichnung des Vorhabens;Rechtsstatus des Begünstigten;Fonds;CCI;Förderperiode;Verwaltungsbehörde;AGS des Vorhabens;Förderfähige Gesamtkosten\r\n00042;Fixture Provider GmbH;Synthetic operation one;juristische Person;EFRE;TEST-CCI;2021-2027;Fixture Verwaltungsbehörde;01053100;100,00\r\n00043;Unqualified Recipient;Synthetic operation two;unknown;EFRE;TEST-CCI;2021-2027;Fixture Verwaltungsbehörde;01053100;200,00\r\n';
  const original = snapshot(bytes, 'https://www.schleswig-holstein.de/DE/fachinhalte/F/foerderprogramme/MWAVT/Downloads/FP_21_27/liste_Vorhaben-efre21_csv', 'text/csv');
  const parsed = parseFundingOperations(original, binding);
  assert.ok(parsed.observations.length > 0);
  assert.equal(parsed.coverage.state, 'partial'); assert.equal(parsed.coverage.observedRows, 2);
  assert.ok(parsed.observations.every(value => value.nativeId === '00042'));
  assert.ok(parsed.observations.every(value => value.evidence.every(locator => locator.mappingVersion === 'funding-operations-v2')));
  const candidates = parsed.observations.filter(value => ['awarded_to', 'programme', 'supported_by'].includes(value.predicate));
  assert.equal(candidates.length, 3);
  const records = await admitStructuredObservations({ adapter: fundingOperationsAdapter, adapterContractSha256: digest('synthetic funding contract'), snapshot: original, scope: binding, districtId: 'fixture-district', candidates,
    replayInSandbox: async () => parseFundingOperations(original, binding),
    checkCurrentPolicy: async () => ({ allowed: true, sourceSha256: original.sourceSha256, scopeSha256: semanticHash(binding), receiptSha256: original.policyReceiptSha256, checkedAt: at }),
  });
  assert.ok(records.every(value => value.graph.mentions.some(mention => mention.type === 'funding_operation')));
  assert.ok(records.some(value => value.graph.relations.some(relation => relation.predicate === 'awarded_to')));
  assert.ok(records.some(value => value.graph.mentions.some(mention => mention.type === 'funding_programme' && mention.period === '2021-2027')));
  const recipient = records.find(value => value.observation.predicate === 'awarded_to')!.graph.mentions.find(value => value.type === 'organization')!;
  assert.equal(recipient.identifiers.length, 0);
});

test('council parser v3 keeps OParl paper/body reference through primary and supporting-source admission', async () => {
  const base = 'https://strausberg.allris.cloud/';
  const binding = { ...scope('council-strausberg', 'stadt-strausberg'), municipalityId: 'strausberg', ags: '12064472' };
  const joinSha = digest('synthetic original municipality binding');
  const join: StructuredLocator = { sourceSha256: joinSha, format: 'json', nativeId: 'registry/strausberg', path: '/councilBodyId', sheet: null, rowKey: null, cells: [], rawValue: base + 'body/1', schemaHash: digest('synthetic binding schema'), mappingVersion: 'fixture-registry-v1' };
  const adapter = createCouncilAdapter({ bodyBindings: [{ sourceId: binding.sourceId, tenant: null, bodyId: base + 'body/1', ags: binding.ags, evidence: join }] });
  const original = snapshot({ data: [{ id: base + 'body/1/paper/7', type: 'https://schema.oparl.org/1.1/Paper', body: base + 'body/1', name: 'Fixture Paper', date: '2026-04-01', reference: 'BV/7/2026', modified: '2026-04-02T10:00:00Z' }] }, base + 'body/1/paper', 'application/json');
  const parsed = adapter.parse(original, binding), candidate = parsed.observations.find(value => value.predicate === 'belongs_to_body')!;
  assert.ok(candidate); assert.equal(candidate.evidence[0].mappingVersion, 'council-native-v3');
  const support = { id: 'fixture-registry', url: 'https://example.org/registry', sha256: joinSha, mimeType: 'application/json', retrievedAt: at, policyReceiptSha256: digest('synthetic supporting policy'), scopeSha256: semanticHash(binding), role: 'municipality_join' as const };
  const records = await admitStructuredObservations({ adapter, adapterContractSha256: digest('synthetic council contract'), snapshot: original, scope: binding, districtId: 'fixture-district', candidates: [candidate], supportingSources: [support],
    replayInSandbox: async () => adapter.parse(original, binding),
    checkCurrentPolicy: async () => ({ allowed: true, sourceSha256: original.sourceSha256, scopeSha256: semanticHash(binding), receiptSha256: original.policyReceiptSha256, checkedAt: at }),
    checkSupportingPolicies: async () => [{ allowed: true, sourceSha256: support.sha256, scopeSha256: support.scopeSha256, receiptSha256: support.policyReceiptSha256, checkedAt: at }],
  });
  assert.deepEqual(records[0].graph.mentions.map(value => value.type), ['council_paper', 'authority']);
  assert.equal(records[0].graph.relations[0].predicate, 'belongs_to_body');
  assert.equal(records[0].graph.relations[0].eventDate, null);
  assert.equal(records[0].supportingSources[0].sha256, joinSha);
});

const noticeId = '12345678-1234-1234-1234-123456789abc';
const procedureId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function europeanXml(id = noticeId, version = '01'): string {
  return `<ContractAwardNotice xmlns="urn:oasis:names:specification:ubl:schema:xsd:ContractAwardNotice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:efext="http://data.europa.eu/p27/eforms-ubl-extensions/1" xmlns:efac="http://data.europa.eu/p27/eforms-ubl-extension-aggregate-components/1">
<cbc:ID schemeName="notice-id">${id}</cbc:ID><cbc:VersionID>${version}</cbc:VersionID><cbc:ContractFolderID>${procedureId}</cbc:ContractFolderID><cbc:IssueDate>2026-10-09</cbc:IssueDate>
<cac:ContractingParty><cac:Party><cac:PartyIdentification><cbc:ID schemeName="organization">ORG-0001</cbc:ID></cac:PartyIdentification></cac:Party></cac:ContractingParty>
<cac:ProcurementProjectLot><cbc:ID schemeName="Lot">LOT-0001</cbc:ID><cac:ProcurementProject><cbc:Name>Fixture Works</cbc:Name></cac:ProcurementProject></cac:ProcurementProjectLot>
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><efext:EformsExtension><efac:NoticeResult>
<efac:LotResult><cbc:ID>RES-0001</cbc:ID><cbc:TenderResultCode>selec-w</cbc:TenderResultCode><efac:TenderLot><cbc:ID>LOT-0001</cbc:ID></efac:TenderLot><efac:LotTender><cbc:ID>TEN-0001</cbc:ID></efac:LotTender><efac:SettledContract><cbc:ID>CON-0001</cbc:ID></efac:SettledContract></efac:LotResult>
<efac:LotTender><cbc:ID>TEN-0001</cbc:ID><efac:TenderingParty><cbc:ID>TPA-0001</cbc:ID></efac:TenderingParty></efac:LotTender>
<efac:TenderingParty><cbc:ID>TPA-0001</cbc:ID><efac:Tenderer><cbc:ID>ORG-0002</cbc:ID></efac:Tenderer></efac:TenderingParty>
<efac:SettledContract><cbc:ID>CON-0001</cbc:ID><cbc:AwardDate>2026-10-08</cbc:AwardDate><cbc:IssueDate>2026-10-09</cbc:IssueDate></efac:SettledContract>
</efac:NoticeResult></efext:EformsExtension></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions></ContractAwardNotice>`;
}

test('parser-produced eForms and TED keep global European IDs and notice/version-local technical actors', () => {
  const binding = scope('procurement-bkms-opendata', 'bkms');
  const parse = (id: string, version: string) => procurementAdapter.parse(snapshot(europeanXml(id, version), 'https://oeffentlichevergabe.de/api/notice-exports?pubDay=2026-10-09', 'application/xml'), binding);
  const first = parse(noticeId, '01'), revised = parse(noticeId, '02'), other = parse('87654321-1234-1234-1234-123456789abc', '01');
  const winner = (parsed: typeof first) => nativeStructuredIdentityGraph(parsed.observations.find(value => value.predicate === 'awarded_to')!, binding);
  const graph = winner(first); assert.equal(graph.relations[0].predicate, 'awarded_to');
  assert.equal(graph.mentions[1].type, 'procurement_party');
  assert.ok(graph.mentions[1].identifiers.every(value => value.namespace === 'eu-eforms:notice-local:party' && value.issuer.includes(':notice:')));
  const partyId = (parsed: typeof first) => resolveIdentityMentions(winner(parsed).mentions).clusters.find(value => value.mentionIds.includes(winner(parsed).mentions[1].id))!.id;
  assert.notEqual(partyId(first), partyId(revised)); assert.notEqual(partyId(first), partyId(other));
  const european = nativeStructuredIdentityGraph(first.observations.find(value => value.predicate === 'announces')!, binding);
  const tedScope = scope('procurement-ted', 'ted');
  const ted = procurementAdapter.parse(snapshot({ notices: [{ 'notice-identifier': noticeId, 'notice-version': 1, 'procedure-identifier': procedureId, 'publication-number': '123456-2026', 'publication-date': '20261009' }], totalNoticeCount: 1 }, 'https://api.ted.europa.eu/v3/notices/search', 'application/json'), tedScope);
  const tedGraph = nativeStructuredIdentityGraph(ted.observations.find(value => value.predicate === 'announces')!, tedScope);
  assert.deepEqual(resolveIdentityMentions(european.mentions).clusters.map(value => value.id), resolveIdentityMentions(tedGraph.mentions).clusters.map(value => value.id));
  assert.ok(european.mentions.every(value => value.identifiers.every(identifier => identifier.issuer === 'eu-eforms')));
});

// Minimal original stored ZIP, with CRC and original native CSV members; this does not normalize parser input.
function nativeCsvArchive(files: Record<string, string>): Uint8Array {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(value); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes); central.push(entry, filename); offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('parser-produced CSV uses canonical European notice/version and procedure-global lot identity', () => {
  const binding = scope('procurement-bkms-opendata', 'bkms');
  const bytes = nativeCsvArchive({
    'notice.csv': 'noticeIdentifier,noticeVersion,procedureIdentifier,publicationDate,formType\r\nN-001,01,P-001,2026-10-09,competition\r\nN-001,02,P-001,2026-10-10,result\r\n',
    'purpose.csv': 'noticeIdentifier,noticeVersion,lotIdentifier,title\r\nN-001,01,LOT-0001,First\r\nN-001,02,LOT-0001,Revised\r\n',
    'tender.csv': 'noticeIdentifier,noticeVersion,tenderIdentifier,lotIdentifier\r\nN-001,01,TEN-0001,LOT-0001\r\nN-001,02,TEN-0001,LOT-0001\r\n',
  });
  const original: AdmittedSnapshot = { bytes, sourceSha256: digest(bytes), url: 'https://oeffentlichevergabe.de/api/notice-exports?pubDay=2026-10-09&format=csv.zip', mimeType: 'application/vnd.bekanntmachungsservice.csv.zip+zip', retrievedAt: at, policyReceiptSha256: digest('synthetic CSV policy'), sourceVersion: 'fixture-1' };
  const parsed = procurementAdapter.parse(original, binding);
  const notices = parsed.observations.filter(value => value.kind === 'Notice' && value.predicate === 'announces');
  assert.equal(notices.length, 2);
  const noticeIds = notices.map(value => resolveIdentityMentions(nativeStructuredIdentityGraph(value, binding).mentions).clusters.find(cluster => cluster.mentionIds.includes(nativeStructuredIdentityGraph(value, binding).mentions[0].id))!.id);
  assert.notEqual(noticeIds[0], noticeIds[1]);
  const lots = parsed.observations.filter(value => value.kind === 'Lot' && value.predicate === 'title');
  assert.equal(lots.length, 2);
  assert.equal(resolveIdentityMentions(nativeStructuredIdentityGraph(lots[0], binding).mentions).clusters[0].id, resolveIdentityMentions(nativeStructuredIdentityGraph(lots[1], binding).mentions).clusters[0].id);
  const tenders = parsed.observations.filter(value => value.kind === 'Tender' && value.predicate === 'lotIdentifier');
  assert.equal(tenders.length, 2);
  assert.notEqual(resolveIdentityMentions(nativeStructuredIdentityGraph(tenders[0], binding).mentions).clusters[0].id, resolveIdentityMentions(nativeStructuredIdentityGraph(tenders[1], binding).mentions).clusters[0].id);
  assert.ok(parsed.observations.filter(value => value.predicate === 'preferred_publication_date').every(value => value.publishedAt === null));
});
