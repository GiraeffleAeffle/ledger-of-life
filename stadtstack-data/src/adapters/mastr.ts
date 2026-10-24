import {load} from 'cheerio';
import {
  assertSnapshot, observation, ScopeSchema, semanticHash,
  type AdmittedSnapshot, type AdapterScope, type AdapterCoverage,
  type DiscoveryResult, type ParseResult, type StructuredAdapter, type StructuredObservation,
} from '../district-adapter-contract.ts';
import {readCsv, readSpreadsheetXml, type NativeTable, type NativeCell} from './structured-tables.ts';

export const MASTR_MAPPING_VERSION = 'mastr-public-export-v2';
export const MASTR_PILOT_AGS:Readonly<Record<string,string>> = Object.freeze({strausberg:'12064472',hoppegarten:'12064227','ruedersdorf-bei-berlin':'12064428',ratzeburg:'01053100',moelln:'01053090',schwarzenbek:'01053116',ludwigslust:'13076090',parchim:'13076108',hagenow:'13076060'});
export const MASTR_LIMITS = {bytes: 16 * 1024 * 1024, rows: 25_001, columns: 128, resources: 32} as const;
const HOST = 'www.marktstammdatenregister.de';
const LIMITATIONS = [
  'An export is a bounded register slice, not complete municipal coverage; current/extended exports cap at 5,000/25,000 rows.',
  'Registration may lag commissioning by one month and records may be unchecked, erroneous or duplicated.',
  'Registration, operating status and rated capacity do not establish municipal ownership, measured generation or heat-network operation.',
  'Operator assignments are attributed as observed, not verified currently valid relationships; unknown temporal bounds remain unknown.',
  'Only the approved nine-town solar/wind fields are mapped; no addresses, contacts, private persons, storage, registration or planning dates.',
  'This bounded CSV/XLS adapter is not a national bulk ZIP/XML reader; bulk input requires a separately reviewed streaming parser sandbox.',
];
const HEADERS = {
  id: 'MaStR-Nr. der Einheit', ags: 'Gemeindeschlüssel', status: 'Betriebs-Status',
  energy: 'Energieträger', gross: 'Bruttoleistung der Einheit', net: 'Nettonennleistung der Einheit',
  commissioning: 'Inbetriebnahmedatum der Einheit',
  actor: 'MaStR-Nr. des Anlagenbetreibers', organization: 'Name des Anlagenbetreibers (nur Org.)',
  system: 'System-Status',
} as const;
const emptyValue = (raw: string) => /^(?:|[-–—]|nicht (?:öffentlich|veröffentlicht|vorhanden)|vertraulich|datenschutz|geschwärzt|natürliche(?:r|n)? person|privatperson|private person)$/iu.test(raw.trim());
const normalizedHeader = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();

function coverage(snapshot: AdmittedSnapshot, scope: AdapterScope, state: AdapterCoverage['state'], reason: string, rows = 0, nextCursor: string | null = null, extra: string[] = []): AdapterCoverage {
  return {state, scope: `${scope.sourceId}:${scope.ags}:${scope.observationWindow}`, reason, checkedAt: snapshot.retrievedAt, nextCursor, observedRows: rows, limitations: [...LIMITATIONS, ...extra]};
}
function prepare(snapshot: AdmittedSnapshot, scope: AdapterScope): void {
  ScopeSchema.parse(scope);
  if (snapshot.bytes.byteLength > MASTR_LIMITS.bytes) throw Error('MaStR snapshot exceeds byte bound');
  assertSnapshot(snapshot);
  const url = new URL(snapshot.url);
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.username || url.password) throw Error('MaStR requires an admitted official HTTPS snapshot');
}
function accessBlocked(html: string): boolean {
  const $ = load(html);
  return $('input[type="password"]').length > 0 || /(?:access denied|zugriff verweigert|captcha|403 forbidden)/iu.test($('body').text());
}
function parseDate(raw: string): string {
  const value = raw.trim();
  const german = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+\d{2}:\d{2}(?::\d{2})?(?:\s+Uhr)?)?$/u.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/u.exec(value);
  if (!german && !iso) throw Error('Unrecognized MaStR calendar date');
  const year = Number(german ? german[3] : iso![1]);
  const month = Number(german ? german[2] : iso![2]);
  const day = Number(german ? german[1] : iso![3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw Error('Invalid MaStR calendar date');
  return date.toISOString().slice(0, 10);
}
function cellDate(cell: NativeCell): string {
  if (cell.type === 'number') throw Error('Numeric XLS dates require original number-format and workbook date-system evidence; use a native calendar-string or DateTime cell');
  return parseDate(cell.raw);
}
function capacity(cell: NativeCell, defaultUnit: string): {value: number; unit: string} {
  const match = /^(.*?)\s*(kWp|kW|kWh)?$/u.exec(cell.raw.trim())!;
  const rawNumber = match[1].trim();
  const unit = match[2] || defaultUnit;
  if (unit !== defaultUnit) throw Error('Unexpected MaStR capacity unit');
  const numeric = cell.type === 'number' ? /^\d+(?:\.\d+)?$/u : /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/u;
  if (!numeric.test(rawNumber)) throw Error('Invalid native MaStR capacity');
  const value = Number(cell.type === 'number' ? rawNumber : rawNumber.replaceAll('.', '').replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) throw Error('Invalid MaStR capacity');
  return {value, unit};
}

export function discoverMastr(snapshot: AdmittedSnapshot, scope: AdapterScope, cursor: string | null): DiscoveryResult {
  prepare(snapshot, scope);
  if(scope.sourceId!=='mastr'||MASTR_PILOT_AGS[scope.municipalityId]!==scope.ags)return {resources:[],coverage:coverage(snapshot,scope,'not_applicable','Outside the approved nine-town MaStR source scope')};
  if (/\/MaStRApi(?:\/|$)|\/soap(?:\/|$)/iu.test(new URL(snapshot.url).pathname)) return {resources: [], coverage: coverage(snapshot, scope, 'blocked_access', 'Authenticated SOAP route is excluded')};
  if (!/html/iu.test(snapshot.mimeType)) return {resources: [], coverage: coverage(snapshot, scope, 'not_checked', 'A data export is not a discovery landing')};
  const html = new TextDecoder('utf-8', {fatal: true}).decode(snapshot.bytes);
  if (accessBlocked(html)) return {resources: [], coverage: coverage(snapshot, scope, 'blocked_access', 'Landing requires authentication or denies access')};
  const $ = load(html);
  const links = new Map<string, {url: string; nativeId: string; parentId: string | null; method: 'GET'; body: null; format: string}>();
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href')!;
    const url = new URL(href, snapshot.url);
    if (url.protocol !== 'https:' || url.hostname !== HOST || url.username || url.password || /\/MaStRApi(?:\/|$)/iu.test(url.pathname)) return;
    const extension = /\.(csv|xls)$/iu.exec(url.pathname)?.[1].toLowerCase();
    const bulk=snapshot.url==='https://www.marktstammdatenregister.de/MaStR/Datendownload'&&/\.zip$/iu.test(url.pathname)&&/gesamtdatenexport/iu.test($(element).text()+' '+url.pathname);
    const overview = /^\/MaStR\/Einheit\/Einheiten\/(?:ErweiterteOeffentlicheEinheitenuebersicht|OeffentlicheEinheitenuebersicht|GeloeschteUndDeaktivierteEinheitenuebersicht)$/u.test(url.pathname);
    if (!extension && !overview && !bulk) return;
    url.hash = '';
    if (url.href === snapshot.url) return;
    links.set(url.href, {url: url.href, nativeId: url.pathname + url.search, parentId: snapshot.url, method: 'GET', body: null, format: extension || (bulk?'zip':'html')});
  });
  const resources = [...links.values()].sort((left, right) => left.url < right.url ? -1 : left.url > right.url ? 1 : 0);
  const binding = semanticHash({sourceSha256: snapshot.sourceSha256, scope});
  let offset = 0;
  if (cursor !== null) {
    const match = /^mastr:([a-f0-9]{64}):(\d+)$/u.exec(cursor);
    if (!match || match[1] !== binding || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > resources.length) throw Error('Invalid or foreign MaStR discovery cursor');
    offset = Number(match[2]);
  }
  const next = offset + MASTR_LIMITS.resources < resources.length ? `mastr:${binding}:${offset + MASTR_LIMITS.resources}` : null;
  return {resources: resources.slice(offset, offset + MASTR_LIMITS.resources), coverage: coverage(snapshot, scope, resources.length ? 'partial' : 'not_checked', resources.length ? 'Observed official landing links only; export selector/session, municipal filtering and caps remain unverified' : 'No directly advertised licensed export link; interactive CSV control is not a GET download endpoint', resources.length, next)};
}

/** Parse admitted native export bytes only. No networking, subprocess or clock access. */
export function parseMastr(snapshot: AdmittedSnapshot, scope: AdapterScope): ParseResult {
  prepare(snapshot, scope);
  if(scope.sourceId!=='mastr'||MASTR_PILOT_AGS[scope.municipalityId]!==scope.ags)return {observations:[],coverage:coverage(snapshot,scope,'not_applicable','Outside the approved nine-town MaStR source scope')};
  if (/\/MaStRApi(?:\/|$)|\/soap(?:\/|$)/iu.test(new URL(snapshot.url).pathname)) return {observations: [], coverage: coverage(snapshot, scope, 'blocked_access', 'Authenticated SOAP route is excluded')};
  if (/html/iu.test(snapshot.mimeType)) {
    const html = new TextDecoder('utf-8', {fatal: true}).decode(snapshot.bytes);
    return {observations: [], coverage: coverage(snapshot, scope, accessBlocked(html) ? 'blocked_access' : 'not_checked', 'HTML is a discovery landing, not an admitted unit export')};
  }
  const xls = /\.xls$/iu.test(new URL(snapshot.url).pathname) || /ms-excel/iu.test(snapshot.mimeType);
  if (!xls && (/zip|xml/iu.test(snapshot.mimeType) || /\.(?:zip|xml)$/iu.test(new URL(snapshot.url).pathname))) return {observations: [], coverage: coverage(snapshot, scope, 'held_quality', 'National bulk ZIP/XML requires a separately reviewed streaming parser sandbox; it is not a bounded CSV/XLS export')};
  let tables: NativeTable[];
  try {
    tables = readMastrTables(snapshot);
  } catch (error) {
    return {observations: [], coverage: coverage(snapshot, scope, 'held_quality', error instanceof Error ? error.message : 'Malformed export')};
  }
  const observations: StructuredObservation[] = [];
  const seen = new Set<string>();
  let observedRows = 0;
  let inScope = 0;
  let unknownGeography = 0;
  try {
    for (const table of tables) {
      if (table.rows.length > MASTR_LIMITS.rows || table.rows.some(row => row.length > MASTR_LIMITS.columns)) throw Error('MaStR table exceeds row/column bounds');
      const headerIndex = table.rows.findIndex(row => row?.some(cell => normalizedHeader(cell.raw) === HEADERS.id));
      if (headerIndex < 0 || headerIndex > 10) throw Error('Changed MaStR schema: native unit header missing');
      const headers = table.rows[headerIndex].map(cell => normalizedHeader(cell.raw));
      if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) throw Error('Duplicate MaStR header');
      const index = (key: keyof typeof HEADERS) => headers.indexOf(HEADERS[key]);
      const withdrawn = index('system') >= 0 && headers.includes('Letzter Betriebsstatus');
      if (!withdrawn && (index('ags') < 0 || index('status') < 0 || index('commissioning') < 0 || index('energy') < 0)) throw Error('Changed MaStR schema: required geography/status/commissioning/energy header missing');
      const schemaHash = semanticHash({headers, format: table.format, sheet: table.sheet});
      for (const row of table.rows.slice(headerIndex + 1).filter(Boolean)) {
        if (row.every(cell => emptyValue(cell.raw))) continue;
        if (++observedRows > 25_000) throw Error('MaStR export exceeds 25,000 native rows');
        const get = (key: keyof typeof HEADERS) => row[index(key)];
        const idCell = get('id');
        const nativeId = idCell?.raw.trim();
        if (!nativeId || !/^SEE\d{12}$/u.test(nativeId)) throw Error('Invalid or unsupported MaStR electricity-unit native ID');
        const ags = get('ags')?.raw.trim();
        if (!ags || emptyValue(ags)) {unknownGeography++; continue;}
        if (!/^\d{8}$/u.test(ags) || get('ags')!.type === 'number') throw Error('MaStR AGS must remain an eight-digit native string');
        if (ags !== scope.ags) continue;
        const energy = get('energy');
        if(!energy||!/^(?:Solare Strahlungsenergie|Solar|Wind|Windenergie)$/iu.test(energy.raw.trim()))continue;
        if (seen.has(nativeId)) throw Error('Duplicate MaStR native unit in export');
        seen.add(nativeId);
        inScope++;
        const subject = `mastr:unit:${nativeId}`;
        // Record-update, registration and contact cells are outside this approval.
        // Retrieval/version metadata never establishes an operator validity interval.
        const nativeVersion = snapshot.sourceVersion;
        const emit = (cell: NativeCell, predicate: string, value: string | number | null, options: {unit?: string; date?: string; dateRole?: string; subject?: string; kind?: string; extra?: string[]; evidenceCells?: NativeCell[]} = {}) => {
          const evidenceCells = [idCell!, get('ags')!, cell, ...(options.evidenceCells || [])];
          observations.push(observation({publisherId: scope.publisherId, sourceId: scope.sourceId, nativeId, nativeVersion, kind: options.kind || 'EnergyUnitObservation', subject: options.subject || subject, predicate, value, unit: options.unit || null, date: options.date || null, dateRole: options.dateRole || null, financialRole: 'none', geography: {ags, basis: 'source_explicit', role: 'project_location'}, sourceReferenceDate: options.date || null, publishedAt: null, retrievedAt: snapshot.retrievedAt,
            evidence: [...new Map(evidenceCells.map(item => [item.address, item])).values()].map(item => ({sourceSha256: snapshot.sourceSha256, format: table.format, nativeId, path: `${table.sheet || 'export'}/${item.address}`, sheet: table.sheet, rowKey: nativeId, cells: [item.address], rawValue: item.raw, schemaHash, mappingVersion: MASTR_MAPPING_VERSION})), limitations: [...LIMITATIONS, ...(options.extra || [])]}));
        };
        emit(idCell!, 'native_identifier', nativeId);
        emit(get('ags')!, 'located_in', `ags:${ags}`);
        const status = get('status');
        if (status && !emptyValue(status.raw)) emit(status, 'registered_operating_status', status.raw.trim());
        if (energy && !emptyValue(energy.raw)) emit(energy, 'registered_energy_carrier', energy.raw.trim());
        const commissioning=get('commissioning');
        if(commissioning&&!emptyValue(commissioning.raw)){const date=cellDate(commissioning);emit(commissioning,'commissioning_date',date,{date,dateRole:'commissioning'});}
        for (const [key, predicate, defaultUnit] of [['gross', 'gross_rated_capacity', /^(?:Solare Strahlungsenergie|Solar)$/iu.test(energy.raw.trim()) ? 'kWp' : 'kW'], ['net', 'net_rated_capacity', 'kW']] as const) {
          const cell = get(key);
          if (cell && !emptyValue(cell.raw)) {const parsed = capacity(cell, defaultUnit); emit(cell, predicate, parsed.value, {unit: parsed.unit, evidenceCells: key === 'gross' && energy ? [energy] : []});}
        }
        const actor = get('actor');
        const name = get('organization');
        if (actor && !emptyValue(actor.raw) && name && !emptyValue(name.raw)) {
          if (!/^ABR\d{12}$/u.test(actor.raw.trim())) throw Error('Invalid publicly disclosed operator identifier');
          emit(actor, 'registered_operator_identifier', actor.raw.trim(), {evidenceCells: [name], extra: ['A disclosed organization actor ID is not municipal ownership or a verified legal-entity registry identity.']});
          emit(name, 'registered_organization_name', name.raw.trim(), {subject: `mastr:actor:${actor.raw.trim()}`, kind: 'OrganizationObservation', evidenceCells: [actor]});
          // The ID and explicit organization-only field establish a source-attributed role, not current validity.
          emit(actor, 'operates', subject, {subject: `mastr:actor:${actor.raw.trim()}`, kind: 'RegisteredOperatorAssignment', evidenceCells: [name]});
        } else {
          // ID-only disclosure can identify a private person pseudonymously; do not expose it even as cell evidence.
          emit(idCell!, 'operator_disclosure', null, {extra: ['Operator is unknown/redacted; no actor ID, organization or operates relation is published without explicit organization disclosure.']});
        }
      }
    }
  } catch (error) {
    return {observations: [], coverage: coverage(snapshot, scope, 'held_quality', error instanceof Error ? error.message : 'Invalid export', observedRows)};
  }
  return {observations, coverage: coverage(snapshot, scope, observedRows === 0 ? 'empty' : 'partial', observedRows === 0 ? 'Valid header-only export; empty applies to these bytes, not all municipal units' : `Parsed native export slice: ${inScope} scoped units; ${unknownGeography} rows lack municipality assignment`, observedRows, null, unknownGeography ? ['Rows without explicit AGS, including native withdrawn-unit exports, cannot be assigned to a town without an admitted prior-version join.'] : [])};
}

function readMastrTables(snapshot: AdmittedSnapshot): NativeTable[] {
  if (/\.xls$/iu.test(new URL(snapshot.url).pathname) || /ms-excel/iu.test(snapshot.mimeType)) {
    if (snapshot.bytes[0] === 0xd0 && snapshot.bytes[1] === 0xcf) throw Error('Binary BIFF XLS profile is unexercised and unsupported; use the documented native CSV export');
    return readSpreadsheetXml(snapshot.bytes);
  }
  if (!/csv|text\/plain/iu.test(snapshot.mimeType) && !/\.csv$/iu.test(new URL(snapshot.url).pathname)) throw Error('Unsupported MaStR export media type');
  const encoding = /charset\s*=\s*(?:windows-1252|iso-8859-1)/iu.test(snapshot.mimeType) ? 'windows-1252' : 'utf-8';
  return [readCsv(snapshot.bytes, {delimiter: ';', encoding})];
}

export const mastrAdapter: StructuredAdapter = {id: 'mastr', version: MASTR_MAPPING_VERSION, discover: discoverMastr, parse: parseMastr};
