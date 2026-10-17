import {XMLParser, XMLValidator} from 'fast-xml-parser';
import {readCsv, readZip} from './structured-tables.ts';
import {assertSnapshot, canonicalJson, observation, semanticHash, type AdmittedSnapshot, type AdapterScope, type AdapterCoverage, type StructuredAdapter, type StructuredObservation, type StructuredLocator, type ParseResult, type ResourceReference} from '../district-adapter-contract.ts';

export const PROCUREMENT_MAPPING_VERSION = 'procurement-native-v1';
export const procurementCapabilityReceipt = {
 family: 9, version: PROCUREMENT_MAPPING_VERSION,
 sources: ['procurement-bkms-opendata', 'procurement-ted'],
 primary: 'https://oeffentlichevergabe.de/api/notice-exports',
 crossReference: 'https://api.ted.europa.eu/v3/notices/search',
 formats: ['OCDS 1.1 JSON', 'original UBL eForms XML', 'RFC4180 CSV tables', 'TED v3 search JSON'],
 liveCollection: 'not_checked', rights: 'held_origin_pending_distribution_admission',
 identity: 'procedure namespace + notice/version + lot/award; BT-701/BT-04 only establish explicit cross-source ID semantics',
 limitations: ['Completed Europe/Berlin publication days only; no spending-ledger completeness', 'Buyer seat and NUTS do not establish municipal project geography', 'Tender and award values are never invoice/payment/actual expenditure', 'Preferred publication date is not actual publication; missing versions are held', 'Natural-person/contact fields are not imported', 'Parsers require admitted byte-bound snapshots; no parser network'],
} as const;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => {if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Expected native object'); return v as Obj;};
const list = (v: unknown): unknown[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
const str = (v: unknown): string | null => typeof v === 'string' && v.length ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
const required = (v: unknown, field: string): string => {const s = str(v); if (!s) throw Error('Missing native ' + field); return s;};
const date = (v: unknown): string | null => {
 const raw = str(v); if (!raw) return null;
 const s = /^\d{8}$/.test(raw) ? raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6) : raw;
 const calendar = s.slice(0, 10);
 if (!/^\d{4}-\d{2}-\d{2}/.test(s) || !Number.isFinite(Date.parse(calendar)) || new Date(calendar).toISOString().slice(0, 10) !== calendar) throw Error('Invalid native calendar date');
 // xsd:date's optional zone qualifies a local calendar day, not a timestamp. Keep its original lexeme in evidence.
 if (/^\d{4}-\d{2}-\d{2}(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)?$/.test(s)) return calendar;
 if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s))) throw Error('Invalid native date or timezone');
 return s;
};
const key = (...parts: string[]) => 'procurement:' + parts.map(encodeURIComponent).join(':');
const limits = [...procurementCapabilityReceipt.limitations];
function canonicalNoticeVersion(version: string): string {
 if (!/^\d{1,9}$/.test(version)) throw Error('Unsupported BT-757 numeric notice version');
 return String(Number(version));
}
function coverage(scope: AdapterScope, snapshot: AdmittedSnapshot, state: AdapterCoverage['state'], reason: string, rows = 0, cursor: string | null = null): AdapterCoverage {
 return {state, scope: canonicalJson(scope), reason, checkedAt: snapshot.retrievedAt, nextCursor: cursor, observedRows: rows, limitations: limits};
}
function context(snapshot: AdmittedSnapshot, scope: AdapterScope, format: StructuredLocator['format'], schema: unknown) {
 const schemaHash = semanticHash(schema); const observations: StructuredObservation[] = [];
 function emit(nativeId: string, version: string | null, kind: string, subject: string, predicate: string, raw: unknown, path: string, options: {value?: string | number | boolean | null; unit?: string | null; date?: string | null; dateRole?: string | null; publishedAt?: string | null; referenceDate?: string | null; financialRole?: StructuredObservation['financialRole']; geographyRole?: StructuredObservation['geography']['role']; evidence?: StructuredLocator[]; cells?: string[]; rowKey?: string; limitations?: string[]} = {}) {
  if (raw === undefined || raw === null || raw === '') return;
  if (!['string', 'number', 'boolean'].includes(typeof raw)) throw Error('Non-scalar native evidence');
  if (observations.length >= 50000) throw Error('Observation bound exceeded');
  const locator: StructuredLocator = {sourceSha256: snapshot.sourceSha256, format, nativeId, path, sheet: null, rowKey: options.rowKey ?? null, cells: options.cells ?? [], rawValue: raw as string | number | boolean, schemaHash, mappingVersion: PROCUREMENT_MAPPING_VERSION};
  observations.push(observation({publisherId: scope.publisherId, sourceId: scope.sourceId, nativeId, nativeVersion: version, kind, subject, predicate, value: options.value === undefined ? raw as string | number | boolean : options.value, unit: options.unit ?? null, date: options.date ?? null, dateRole: options.dateRole ?? null, financialRole: options.financialRole ?? 'none', geography: {ags: null, basis: 'unknown', role: options.geographyRole ?? 'unknown'}, sourceReferenceDate: options.referenceDate ?? null, publishedAt: options.publishedAt ?? null, retrievedAt: snapshot.retrievedAt, evidence: [locator, ...(options.evidence ?? [])], limitations: [...limits, ...(options.limitations ?? [])]}));
 }
 return {emit, observations};
}

function ocds(bytes: Uint8Array, snapshot: AdmittedSnapshot, scope: AdapterScope, member: string): StructuredObservation[] {
 const packageData = obj(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
 if (packageData.version !== undefined && !/^1\.1(?:\.|$)/.test(required(packageData.version, 'OCDS version'))) throw Error('Changed OCDS schema');
 const releases = packageData.releases === undefined ? [packageData] : list(packageData.releases);
 if (releases.length > 10000) throw Error('Release bound exceeded');
 const c = context(snapshot, scope, 'json', {standard: 'OCDS 1.1', mapping: PROCUREMENT_MAPPING_VERSION});
 releases.forEach((entry, ri) => {
  const r = obj(entry), procedureId = required(r.ocid, 'ocid'), version = required(r.id, 'release id');
  const base = member + (packageData.releases === undefined ? '#' : '#/releases/' + ri);
  const procedure = key(scope.publisherId, 'ocid', procedureId), notice = key(scope.publisherId, 'ocid', procedureId, 'release', version);
  const published = date(r.date), defaults = {publishedAt: published, referenceDate: published};
  const emit = (kind: string, subject: string, predicate: string, value: unknown, path: string, extra: Parameters<typeof c.emit>[7] = {}) => c.emit(procedureId, version, kind, subject, predicate, value, base + path, {...defaults, ...extra});
  emit('Notice', notice, 'announces', procedureId, '/ocid', {value: procedure});
  emit('Notice', notice, 'release_id', r.id, '/id');
  emit('Notice', notice, 'published_at', r.date, '/date', {date: published, dateRole: 'publication'});
  list(r.tag).forEach((tag, i) => emit('Notice', notice, 'release_tag', tag, '/tag/' + i));
  const tender = r.tender === undefined ? null : obj(r.tender);
  if (tender) {
   const tenderId = required(tender.id, 'tender id'), tenderKey = key(scope.publisherId, procedureId, 'tender', tenderId);
   for (const field of ['id', 'title', 'status']) emit('Tender', tenderKey, field, tender[field], '/tender/' + field);
   if (tender.value) {const v = obj(tender.value); emit('Tender', tenderKey, 'estimated_value', v.amount, '/tender/value/amount', {unit: str(v.currency), financialRole: 'plan'});}
   list(tender.lots).forEach((l, i) => {const lot = obj(l), id = required(lot.id, 'lot id'), subject = key(scope.publisherId, procedureId, 'lot', id); emit('Lot', subject, 'part_of', lot.id, '/tender/lots/' + i + '/id', {value: procedure}); for (const f of ['title', 'status']) emit('Lot', subject, f, lot[f], '/tender/lots/' + i + '/' + f);});
  }
  if (r.buyer) {const buyer = obj(r.buyer), id = required(buyer.id, 'buyer id'); emit('Buyer', key(scope.publisherId, procedureId, 'party', id), 'procures_procedure', id, '/buyer/id', {value: procedure});}
  list(r.parties).forEach((p, i) => {const party = obj(p), id = required(party.id, 'party id'); const roles = list(party.roles); if (!roles.includes('buyer') && !roles.includes('supplier')) return; const additional = party.details ? obj(party.details) : {}; if (additional.naturalPerson === true) return; const subject = key(scope.publisherId, procedureId, 'party', id); if (party.identifier) {const ident = obj(party.identifier); emit('OrganizationMention', subject, 'identifier', ident.id, '/parties/' + i + '/identifier/id', {unit: str(ident.scheme), limitations: ['Native party identifiers are not independent legal-entity verification']});} });
  list(r.awards).forEach((a, i) => {
   const award = obj(a), id = required(award.id, 'award id'), subject = key(scope.publisherId, procedureId, 'award', id), p = '/awards/' + i;
   emit('Award', subject, 'award_id', award.id, p + '/id'); emit('Award', subject, 'status', award.status, p + '/status');
   emit('Award', subject, 'decision_date', award.date, p + '/date', {date: date(award.date), dateRole: 'award_decision'});
   if (award.value) {const v = obj(award.value); emit('Award', subject, 'award_value', v.amount, p + '/value/amount', {unit: str(v.currency), financialRole: award.status === 'active' ? 'approval' : 'none'});}
   list(award.relatedLots).forEach((l, j) => emit('Award', subject, 'for_lot', l, p + '/relatedLots/' + j, {value: key(scope.publisherId, procedureId, 'lot', required(l, 'related lot'))}));
   // Only an explicit active award supplies an award relationship; cancelled/pending awards remain attributed statuses.
   if (award.status === 'active') list(award.suppliers).forEach((s, j) => {const supplier = obj(s), id = required(supplier.id, 'supplier id'); emit('Award', subject, 'awarded_to', supplier.id, p + '/suppliers/' + j + '/id', {value: key(scope.publisherId, procedureId, 'party', id)});});
  });
  list(r.contracts).forEach((a, i) => {const contract = obj(a), id = required(contract.id, 'contract id'), subject = key(scope.publisherId, procedureId, 'contract', id), p = '/contracts/' + i; emit('Contract', subject, 'award_reference', contract.awardID, p + '/awardID', {value: contract.awardID ? key(scope.publisherId, procedureId, 'award', required(contract.awardID, 'awardID')) : null}); emit('Contract', subject, 'signature_date', contract.dateSigned, p + '/dateSigned', {date: date(contract.dateSigned), dateRole: 'contract_signature'}); emit('Contract', subject, 'status', contract.status, p + '/status');});
 });
 return c.observations;
}

// eForms uses exact SDK selectors, not loose descendant/name searches.
function eforms(bytes: Uint8Array, snapshot: AdmittedSnapshot, scope: AdapterScope, member: string): StructuredObservation[] {
 const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
 if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw Error('Unsafe or malformed XML');
 const bindings: Record<string, string> = {cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2', cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2', ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2', efac: 'http://data.europa.eu/p27/eforms-ubl-extension-aggregate-components/1', efext: 'http://data.europa.eu/p27/eforms-ubl-extensions/1'};
 for (const match of text.matchAll(/xmlns:(cbc|cac|ext|efac|efext)\s*=\s*(['"])(.*?)\2/g)) if (bindings[match[1]!] !== match[3]) throw Error('Unsupported or shadowed eForms namespace binding');
 const parsed = obj(new XMLParser({ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false, processEntities: false}).parse(text));
 const rootName = Object.keys(parsed).find(n => /^(?:\w+:)?(?:ContractNotice|ContractAwardNotice|PriorInformationNotice)$/.test(n));
 if (!rootName) throw Error('Changed eForms root');
 const r = obj(parsed[rootName]);
 const rootParts = rootName.split(':'), rootLocal = rootParts[rootParts.length - 1]!;
 if (r[rootParts.length === 1 ? '@_xmlns' : '@_xmlns:' + rootParts[0]] !== 'urn:oasis:names:specification:ubl:schema:xsd:' + rootLocal + '-2') throw Error('Unsupported UBL root namespace');
 if (r['@_xmlns:cbc'] !== 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2' || r['@_xmlns:cac'] !== 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2') throw Error('Unsupported eForms namespace binding');
 const scalar = (v: unknown): string | null => str(v && typeof v === 'object' ? obj(v)['#text'] : v);
 const at = (v: unknown, path: string): unknown => {let current: unknown = v; for (const p of path.split('/')) {if (current === undefined) return undefined; current = obj(current)[p];} return current;};
 const nodeId = (v: unknown): string => required(scalar(at(v, 'cbc:ID')), 'eForms node ID');
 const noticeNode = list(r['cbc:ID']).find(v => typeof v === 'object' && obj(v)['@_schemeName'] === 'notice-id');
 const id = required(scalar(noticeNode), 'BT-701'), version = required(scalar(r['cbc:VersionID']), 'BT-757'), procedureId = required(scalar(r['cbc:ContractFolderID']), 'BT-04');
 const notice = key('eu-eforms', 'notice', id, canonicalNoticeVersion(version)), procedure = key('eu-eforms', 'procedure', procedureId);
 const c = context(snapshot, scope, 'xml', {standard: 'eForms UBL 2.3', customization: scalar(r['cbc:CustomizationID']), mapping: PROCUREMENT_MAPPING_VERSION});
 const emit = (kind: string, subject: string, predicate: string, raw: unknown, path: string, extra: Parameters<typeof c.emit>[7] = {}) => c.emit(id, version, kind, subject, predicate, scalar(raw), member + '#/' + rootName + '/' + path, {referenceDate: date(scalar(r['cbc:IssueDate'])), ...extra});
 emit('Notice', notice, 'announces', r['cbc:ContractFolderID'], 'cbc:ContractFolderID', {value: procedure});
 emit('Notice', notice, 'european_notice_identifier', noticeNode, "cbc:ID[@schemeName='notice-id']");
 emit('Notice', notice, 'notice_version', r['cbc:VersionID'], 'cbc:VersionID');
 emit('Notice', notice, 'dispatch_date', r['cbc:IssueDate'], 'cbc:IssueDate', {date: date(scalar(r['cbc:IssueDate'])), dateRole: 'dispatch'});
 list(r['cac:ProcurementProjectLot']).forEach((l, i) => {const lot = obj(l), ident = obj(lot['cbc:ID']); if (ident['@_schemeName'] !== 'Lot') return; const lotId = nodeId(lot), subject = key('eu-eforms', procedureId, 'lot', lotId), p = 'cac:ProcurementProjectLot[' + (i + 1) + ']'; emit('Lot', subject, 'part_of', lot['cbc:ID'], p + '/cbc:ID', {value: procedure}); emit('Lot', subject, 'title', at(lot, 'cac:ProcurementProject/cbc:Name'), p + '/cac:ProcurementProject/cbc:Name');});
 list(r['cac:ProcurementProjectLot']).forEach((l, i) => {
  const lot = obj(l), ident = obj(lot['cbc:ID']); if (ident['@_schemeName'] !== 'Lot') return;
  const subject = key('eu-eforms', procedureId, 'lot', nodeId(lot)), project = at(lot, 'cac:ProcurementProject');
  if (!project) return;
  list(obj(project)['cac:RealizedLocation']).forEach((location, j) => {
   for (const field of ['cbc:CountrySubentityCode', 'cbc:CityName', 'cbc:PostalZone']) emit('Lot', subject, field.split(':')[1]!, at(location, 'cac:Address/' + field), 'cac:ProcurementProjectLot[' + (i + 1) + ']/cac:ProcurementProject/cac:RealizedLocation[' + (j + 1) + ']/cac:Address/' + field, {geographyRole: 'performance_location'});
  });
 });
 list(r['cac:ContractingParty']).forEach((v, i) => {const buyer = at(v, 'cac:Party/cac:PartyIdentification/cbc:ID'), bid = scalar(buyer); if (bid) emit('Buyer', key(notice, 'party', bid), 'procures_procedure', buyer, 'cac:ContractingParty[' + (i + 1) + ']/cac:Party/cac:PartyIdentification/cbc:ID', {value: procedure});});
 const extensionPath = 'ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent/efext:EformsExtension/efac:NoticeResult';
 // Multiple extension containers are held rather than selecting an arbitrary result.
 const result = at(r, extensionPath);
 if (result !== undefined) {
  if (r['@_xmlns:efac'] !== 'http://data.europa.eu/p27/eforms-ubl-extension-aggregate-components/1' || r['@_xmlns:efext'] !== 'http://data.europa.eu/p27/eforms-ubl-extensions/1' || r['@_xmlns:ext'] !== 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2') throw Error('Unsupported result namespace');
  list(obj(result)['efac:LotResult']).forEach((v, i) => {const a = obj(v), aid = nodeId(a), subject = key(notice, 'award', aid), p = extensionPath + '/efac:LotResult[' + (i + 1) + ']'; emit('Award', subject, 'status', a['cbc:TenderResultCode'], p + '/cbc:TenderResultCode'); emit('Award', subject, 'for_lot', at(a, 'efac:TenderLot/cbc:ID'), p + '/efac:TenderLot/cbc:ID', {value: key('eu-eforms', procedureId, 'lot', required(scalar(at(a, 'efac:TenderLot/cbc:ID')), 'lot reference'))}); for (const name of ['efac:LotTender', 'efac:SettledContract']) list(a[name]).forEach((ref, j) => emit('Award', subject, name === 'efac:LotTender' ? 'tender_reference' : 'contract_reference', at(ref, 'cbc:ID'), p + '/' + name + '[' + (j + 1) + ']/cbc:ID', {value: key(notice, name === 'efac:LotTender' ? 'tender' : 'contract', nodeId(ref))}));});
  list(obj(result)['efac:LotTender']).forEach((v, i) => {const t = obj(v), tid = nodeId(t), subject = key(notice, 'tender', tid), p = extensionPath + '/efac:LotTender[' + (i + 1) + ']'; const amount = at(t, 'cac:LegalMonetaryTotal/cbc:PayableAmount'); emit('Tender', subject, 'tender_value', amount, p + '/cac:LegalMonetaryTotal/cbc:PayableAmount', {unit: amount ? str(obj(amount)['@_currencyID']) : null, financialRole: 'none'}); const partyRef = at(t, 'efac:TenderingParty/cbc:ID'); emit('Tender', subject, 'tendering_party_reference', partyRef, p + '/efac:TenderingParty/cbc:ID', {value: partyRef ? key(notice, 'tendering_party', required(scalar(partyRef), 'tendering party ID')) : null});});
  list(obj(result)['efac:SettledContract']).forEach((v, i) => {const t = obj(v), cid = nodeId(t), subject = key(notice, 'contract', cid), p = extensionPath + '/efac:SettledContract[' + (i + 1) + ']'; emit('Contract', subject, 'decision_date', t['cbc:AwardDate'], p + '/cbc:AwardDate', {date: date(scalar(t['cbc:AwardDate'])), dateRole: 'award_decision'}); emit('Contract', subject, 'conclusion_date', t['cbc:IssueDate'], p + '/cbc:IssueDate', {date: date(scalar(t['cbc:IssueDate'])), dateRole: 'contract_conclusion'});});
  const tenders = list(obj(result)['efac:LotTender']).map((v, index) => ({node: obj(v), index}));
  const parties = list(obj(result)['efac:TenderingParty']).map((v, index) => ({node: obj(v), index}));
  list(obj(result)['efac:LotResult']).forEach((v, i) => {
   const award = obj(v); if (scalar(award['cbc:TenderResultCode']) !== 'selec-w') return;
   const subject = key(notice, 'award', nodeId(award));
   for (const tenderRef of list(award['efac:LotTender'])) {
    const tender = tenders.find(t => nodeId(t.node) === nodeId(tenderRef)); if (!tender) throw Error('Dangling eForms winning tender reference');
    const partyId = scalar(at(tender.node, 'efac:TenderingParty/cbc:ID')); if (!partyId) throw Error('Missing eForms tendering party reference');
    const party = parties.find(p => nodeId(p.node) === partyId); if (!party) throw Error('Dangling eForms tendering party reference');
    const chain = c.observations.filter(o => (o.subject === subject && ['status', 'tender_reference'].includes(o.predicate)) || (o.subject === key(notice, 'tender', nodeId(tender.node)) && o.predicate === 'tendering_party_reference')).flatMap(o => o.evidence);
    list(party.node['efac:Tenderer']).forEach((winner, j) => {const wid = nodeId(winner); emit('Award', subject, 'awarded_to', at(winner, 'cbc:ID'), extensionPath + '/efac:TenderingParty[' + (party.index + 1) + ']/efac:Tenderer[' + (j + 1) + ']/cbc:ID', {value: key(notice, 'party', wid), evidence: chain});});
   }
  });
 }
 return c.observations;
}

function csvTables(members: Map<string, Uint8Array>, snapshot: AdmittedSnapshot, scope: AdapterScope): StructuredObservation[] {
 if (!members.has('notice.csv')) throw Error('Missing native notice.csv');
 const c = context(snapshot, scope, 'csv', {standard: 'Bekanntmachungsservice CSV', mapping: PROCUREMENT_MAPPING_VERSION});
 const notices = new Map<string, {procedure: string; procedureId: string; version: string; id: string}>();
 const read = (name: string) => {const table = readCsv(members.get(name)!); const headers = table.rows[0]?.map(cell => cell.raw) ?? []; if (!headers.includes('noticeIdentifier') || !headers.includes('noticeVersion') || new Set(headers).size !== headers.length) throw Error('Changed CSV identity columns'); return {headers, rows: table.rows.slice(1).map((cells, i) => ({row: Object.fromEntries(headers.map((h, j) => [h, cells[j]?.raw ?? ''])), cells, number: i + 2}))};};
 const main = read('notice.csv');
 if (!main.headers.includes('procedureIdentifier')) throw Error('Changed CSV procedure column');
 for (const {row, number} of main.rows) {
  const id = required(row.noticeIdentifier, 'noticeIdentifier'), version = required(row.noticeVersion, 'noticeVersion'), pid = required(row.procedureIdentifier, 'procedureIdentifier');
  const nk = key('eu-eforms', 'notice', id, canonicalNoticeVersion(version)), pk = key('eu-eforms', 'procedure', pid), composite = canonicalJson([id, version]);
  if (notices.has(composite)) throw Error('Duplicate CSV notice version'); notices.set(composite, {procedure: pk, procedureId: pid, version, id});
  for (const field of ['noticeIdentifier', 'noticeVersion', 'procedureIdentifier', 'formType', 'noticeType']) c.emit(id, version, 'Notice', nk, field === 'procedureIdentifier' ? 'announces' : field, row[field], 'notice.csv#row=' + number + '/' + field, {value: field === 'procedureIdentifier' ? pk : row[field], rowKey: composite, cells: [field]});
  c.emit(id, version, 'Notice', nk, 'preferred_publication_date', row.publicationDate, 'notice.csv#row=' + number + '/publicationDate', {date: date(row.publicationDate), dateRole: 'preferred_publication', rowKey: composite, cells: ['publicationDate']});
 }
 const mappings: Record<string, {kind: string; identity: string; fields: string[]}> = {
  'purpose.csv': {kind: 'Lot', identity: 'lotIdentifier', fields: ['title', 'description', 'estimatedValue', 'internalIdentifier']},
  'lot.csv': {kind: 'Lot', identity: 'lotIdentifier', fields: ['title']},
  'procedureLotResult.csv': {kind: 'LotResult', identity: 'lotIdentifier', fields: ['winnerChosen', 'notAwardedReason']},
  'tender.csv': {kind: 'Tender', identity: 'tenderIdentifier', fields: ['lotIdentifier', 'tenderValue']},
  'contract.csv': {kind: 'Contract', identity: 'contractIdentifier', fields: ['winnerDecisionDate', 'contractConclusionDate']},
  'placeOfPerformance.csv': {kind: 'Lot', identity: 'lotIdentifier', fields: ['placePerformanceCity', 'placePerformancePostCode', 'placePerformanceCountrySubdivision', 'placePerformanceCountryCode']},
 };
 for (const [name, mapping] of Object.entries(mappings)) {
  if (!members.has(name)) continue;
  const table = read(name);
  if (!table.headers.includes(mapping.identity)) throw Error('Changed CSV scoped identity column');
  for (const {row, number} of table.rows) {
   const composite = canonicalJson([row.noticeIdentifier, row.noticeVersion]), notice = notices.get(composite); if (!notice) throw Error('Dangling CSV notice/version foreign key');
   const ident = row[mapping.identity];
   // Empty lot key is explicitly procedure-level, never assigned to a guessed lot.
   if (!ident && !['purpose.csv', 'placeOfPerformance.csv'].includes(name)) throw Error('Missing CSV scoped ID');
   const subject = !ident ? notice.procedure : mapping.kind === 'Lot' ? key('eu-eforms', notice.procedureId, 'lot', ident) : key(key('eu-eforms', 'notice', notice.id, canonicalNoticeVersion(notice.version)), mapping.kind.toLowerCase(), ident);
   for (const field of mapping.fields) {
    const isDate = field.endsWith('Date'), isPerformance = field.startsWith('placePerformance');
    c.emit(notice.id, notice.version, ident ? mapping.kind : 'Procedure', subject, field, row[field], name + '#row=' + number + '/' + field, {unit: field.endsWith('Value') ? row[field + 'Currency'] || null : null, financialRole: field === 'estimatedValue' ? 'plan' : 'none', date: isDate ? date(row[field]) : null, dateRole: field === 'winnerDecisionDate' ? 'award_decision' : field === 'contractConclusionDate' ? 'contract_conclusion' : null, geographyRole: isPerformance ? 'performance_location' : 'unknown', rowKey: canonicalJson([row.noticeIdentifier, row.noticeVersion, ident, number]), cells: [field, 'noticeIdentifier', 'noticeVersion', mapping.identity]});
   }
  }
 }
 return c.observations;
}

function ted(data: Obj, snapshot: AdmittedSnapshot, scope: AdapterScope): ParseResult {
 if (!Array.isArray(data.notices) || !Number.isSafeInteger(data.totalNoticeCount) || Number(data.totalNoticeCount) < data.notices.length || data.notices.length > 250) throw Error('Changed TED response schema');
 const c = context(snapshot, scope, 'json', {standard: 'TED search v3', fields: ['notice-identifier', 'notice-version', 'procedure-identifier', 'publication-number', 'publication-date']});
 data.notices.forEach((v, i) => {
  const n = obj(v), id = required(n['notice-identifier'], 'TED notice-identifier'), version = required(n['notice-version'], 'TED notice-version'), pid = required(n['procedure-identifier'], 'TED procedure-identifier');
  const subject = key('eu-eforms', 'notice', id, canonicalNoticeVersion(version)), p = '#/notices/' + i;
  for (const f of ['notice-identifier', 'notice-version', 'procedure-identifier', 'publication-number', 'publication-date']) c.emit(id, version, 'Notice', subject, f === 'procedure-identifier' ? 'announces' : f, n[f], p + '/' + f, {value: f === 'procedure-identifier' ? key('eu-eforms', 'procedure', pid) : str(n[f]), publishedAt: date(n['publication-date']), referenceDate: date(n['publication-date']), date: f === 'publication-date' ? date(n[f]) : null, dateRole: f === 'publication-date' ? 'publication' : null});
 });
 const token = str(data.iterationNextToken), partial = data.timedOut === true || !!token || Number(data.totalNoticeCount) > data.notices.length;
 return {observations: c.observations, coverage: coverage(scope, snapshot, partial ? 'partial' : data.notices.length ? 'complete' : 'empty', partial ? 'TED page is not whole-query completeness; keep pagination/timeout visible' : 'Bounded TED search response', data.notices.length, token)};
}

function parseProcurement(snapshot: AdmittedSnapshot, scope: AdapterScope): ParseResult {
 assertSnapshot(snapshot);
 if (!procurementCapabilityReceipt.sources.includes(scope.sourceId as 'procurement-bkms-opendata' | 'procurement-ted')) return {observations: [], coverage: coverage(scope, snapshot, 'not_applicable', 'Source is not family 9')};
 if (snapshot.bytes.length > 64 * 1024 * 1024) return {observations: [], coverage: coverage(scope, snapshot, 'held_quality', 'Compressed/input byte bound exceeded')};
 if (/html/i.test(snapshot.mimeType)) return {observations: [], coverage: coverage(scope, snapshot, 'blocked_access', 'HTML access/login/interstitial is not a native procurement export')};
 try {
  if (scope.sourceId === 'procurement-ted') return ted(obj(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(snapshot.bytes))), snapshot, scope);
  let observations: StructuredObservation[];
  if (snapshot.bytes[0] === 0x50 && snapshot.bytes[1] === 0x4b) {
   const members = readZip(snapshot.bytes);
   if (members.size === 0) return {observations: [], coverage: coverage(scope, snapshot, 'empty', 'Native empty export ZIP; no withdrawals inferred')};
   if (members.has('notice.csv')) observations = csvTables(members, snapshot, scope);
   else {observations = []; for (const [name, bytes] of members) {if (name.endsWith('/')) continue; if (name.endsWith('.json')) observations.push(...ocds(bytes, snapshot, scope, name)); else if (name.endsWith('.xml')) observations.push(...eforms(bytes, snapshot, scope, name)); else throw Error('Unexpected native archive member');}}
  } else if (/xml/i.test(snapshot.mimeType)) observations = eforms(snapshot.bytes, snapshot, scope, '');
  else if (/csv/i.test(snapshot.mimeType)) observations = csvTables(new Map([['notice.csv', snapshot.bytes]]), snapshot, scope);
  else observations = ocds(snapshot.bytes, snapshot, scope, '');
  if (observations.length > 50000) throw Error('Representation observation bound exceeded');
  const unique = new Map(observations.map(o => [o.id, o]));
  const noticeRows = new Set(observations.map(o => canonicalJson([o.nativeId, o.nativeVersion]))).size;
  return {observations: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)), coverage: coverage(scope, snapshot, observations.length ? 'complete' : 'empty', 'Parsed supplied native export only; observedRows counts notice/version rows, not universal procurement or municipality completeness', noticeRows)};
 } catch (error) {return {observations: [], coverage: coverage(scope, snapshot, 'held_quality', 'Native schema/format hold: ' + (error instanceof Error ? error.message : 'unknown'))};}
}

function berlinDay(timestamp: string): string {
 const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(timestamp));
 return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
}
export function createProcurementAdapter(options: {format?: 'ocds.zip' | 'eforms.zip' | 'csv.zip'; tedQuery?: string} = {}): StructuredAdapter {
 const format = options.format ?? 'ocds.zip';
 return {id: 'procurement', version: PROCUREMENT_MAPPING_VERSION, parse: parseProcurement,
  discover(snapshot, scope, cursor) {
   assertSnapshot(snapshot);
   try {
    if (scope.sourceId === 'procurement-ted') {
     if (!options.tedQuery) return {resources: [], coverage: coverage(scope, snapshot, 'not_checked', 'Explicit bounded TED query required; no title/name equality query')};
     const parsed = parseProcurement(snapshot, scope); if (parsed.coverage.state === 'held_quality' || parsed.coverage.state === 'blocked_access') return {resources: [], coverage: parsed.coverage};
     const token = cursor ?? parsed.coverage.nextCursor;
     if (!token) return {resources: [], coverage: parsed.coverage};
     const body = canonicalJson({query: options.tedQuery, fields: ['notice-identifier', 'notice-version', 'procedure-identifier', 'publication-number', 'publication-date'], limit: 100, scope: 'ALL', paginationMode: 'ITERATION', onlyLatestVersions: false, iterationNextToken: token});
     return {resources: [{url: procurementCapabilityReceipt.crossReference, nativeId: semanticHash({query: options.tedQuery, token}), parentId: snapshot.sourceVersion, method: 'POST', body, format: 'json'}], coverage: {...parsed.coverage, state: 'partial', nextCursor: token}};
    }
    if (scope.sourceId !== 'procurement-bkms-opendata') return {resources: [], coverage: coverage(scope, snapshot, 'not_applicable', 'Source is not family 9')};
    // The admitted API specification is the discovery seed; it is not a fabricated resource list.
    const spec = obj(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(snapshot.bytes)));
    const paths = obj(spec.paths); if (!paths['/api/notice-exports']) throw Error('Missing admitted export capability');
    const days = scope.observationWindow.split('/'); if (days.length > 2 || !days.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d).toISOString().slice(0, 10) === d)) throw Error('Publication scope must be a full day or inclusive day interval');
    const start = days[0]!, end = days[1] ?? start, day = cursor ?? start;
    if (start < '2022-12-01' || end < start || end >= berlinDay(snapshot.retrievedAt) || day < start || day > end || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('Only completed Europe/Berlin publication days are eligible');
    const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10), nextCursor = next <= end ? next : null;
    const url = procurementCapabilityReceipt.primary + '?pubDay=' + day + '&format=' + format;
    return {resources: [{url, nativeId: key('bkms', 'publication-day', day, format), parentId: snapshot.sourceVersion, method: 'GET', body: null, format}], coverage: coverage(scope, snapshot, nextCursor ? 'partial' : 'complete', 'Enumerated completed publication day, not downloaded/ingested', 1, nextCursor)};
   } catch (error) {return {resources: [], coverage: coverage(scope, snapshot, 'held_quality', error instanceof Error ? error.message : 'Invalid discovery snapshot')};}
  }};
}
export const procurementAdapter = createProcurementAdapter();

/** Explicit BT-701/BT-04 queries only; a title never establishes TED/federal equality. */
export function procurementTedReferences(result: ParseResult): ResourceReference[] {
 const identifiers = new Set(result.observations.filter(o => o.predicate === 'european_notice_identifier' || o.predicate === 'noticeIdentifier').map(o => required(o.value, 'BT-701')));
 return [...identifiers].sort().map(id => {if (!/^[A-Za-z0-9-]+$/.test(id)) throw Error('Unsupported explicit notice identifier encoding'); const query = 'notice-identifier = ' + id; return {url: procurementCapabilityReceipt.crossReference, nativeId: key('eu-eforms', 'notice', id), parentId: null, method: 'POST', format: 'json', body: canonicalJson({query, fields: ['notice-identifier', 'notice-version', 'procedure-identifier', 'publication-number', 'publication-date'], limit: 100, scope: 'ALL', paginationMode: 'ITERATION', onlyLatestVersions: false})};});
}
