import {
  assertSnapshot, canonicalJson, observation, ScopeSchema, semanticHash,
  type AdmittedSnapshot, type AdapterCoverage, type AdapterScope,
  type DiscoveryResult, type ParseResult, type ResourceReference, type StructuredAdapter,
} from '../district-adapter-contract.ts';
import {readCsv, readZip} from './structured-tables.ts';
import {load} from 'cheerio';

export interface GenesisTableDefinition {level: 'GE' | 'KR'; referenceDay: string; statistic: string; requestName?: '12411-02-03-5'}
export type GenesisTables = Readonly<Record<string, GenesisTableDefinition>>;

export const GENESIS_VERSION = 'regionalstatistik-datencsv-v3';
export const GENESIS_BASE = 'https://www.regionalstatistik.de/genesisws/rest/2020/';
export const GENESIS_TABLES = {
  '12411-06-01': {level: 'GE', referenceDay: '06-30', statistic: 'population'},
  '12411-02-03': {level: 'GE', referenceDay: '12-31', statistic: 'population_by_age', requestName: '12411-02-03-5'},
  '31231-02-01': {level: 'GE', referenceDay: '12-31', statistic: 'housing_stock'},
} as const;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_COLUMNS = 128;
const MAX_OBSERVATIONS = 10000;
const LIMITATIONS = [
  'GAST headers are documented, not exercised; acquisition must supply credentials and policy admission.',
  'A parsed slice is not complete municipal/table coverage. No collection has been performed.',
  'Statistics are context, never evidence of project completion, ownership, operators or causal impact.',
  'GE and KR remain separate; district totals are not assigned to a town.',
  'Boundary vintage and table publication date are unknown unless separately evidenced.',
];
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Changed native JSON schema');
  return value as Json;
}
function coverage(snapshot: AdmittedSnapshot, scope: AdapterScope, state: AdapterCoverage['state'], reason: string, observedRows = 0, nextCursor: string | null = null): AdapterCoverage {
  return {state, reason, scope: `${scope.sourceId}:${scope.ags}:${scope.observationWindow}`, checkedAt: snapshot.retrievedAt, nextCursor, observedRows, limitations: LIMITATIONS};
}
function text(snapshot: AdmittedSnapshot, scope: AdapterScope, sourceId = 'regionalstatistik-genesis'): {content: string; member: string | null} {
  assertSnapshot(snapshot);
  ScopeSchema.parse(scope);
  if (scope.sourceId !== sourceId) throw Error('Wrong catalog source');
  if (snapshot.bytes.byteLength > MAX_BYTES) throw Error('Snapshot exceeds bounded parser size');
  const url = new URL(snapshot.url);
  if (url.origin !== 'https://www.regionalstatistik.de' || !url.pathname.startsWith('/genesisws/rest/2020/')) throw Error('Unexpected publisher endpoint');
  let bytes = snapshot.bytes, member: string | null = null;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const archive = readZip(bytes);
    const candidates = [...archive].filter(([name]) => /\.csv$/i.test(name));
    if (candidates.length !== 1) throw Error('ZIP tablefile must have exactly one unambiguous CSV member');
    [member, bytes] = candidates[0];
    if (bytes.byteLength > MAX_BYTES) throw Error('Expanded CSV member exceeds parser size');
  }
  return {content: new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/^\uFEFF/, ''), member};
}
function nativeFailure(root: Json): string | null {
  const status = object(root.Status);
  if ((status.Code === 0 || status.Code === '0') && status.Type !== 'Error') return null;
  return typeof status.Content === 'string' ? status.Content : 'Native service reported failure';
}
function failureState(reason: string): AdapterCoverage['state'] {
  if (/anmeld|auth|passwort|zugang|berechtigung|login|credential|captcha|gesperrt/i.test(reason)) return 'blocked_access';
  // Disappearance is not a tombstone: do not retract earlier observations.
  return 'held_quality';
}
function knownTable(code: unknown, tables: GenesisTables = GENESIS_TABLES): string {
  if (typeof code !== 'string') throw Error('Unknown or changed table identifier');
  if (Object.hasOwn(tables, code)) return code;
  for (const catalogId in tables) {
    if (Object.hasOwn(tables, catalogId) && tables[catalogId].requestName === code) return catalogId;
  }
  throw Error('Unknown or changed table identifier');
}
function request(path: string, table: string, params: Record<string, string>, parent: string): ResourceReference {
  return {url: `${GENESIS_BASE}${path}`, nativeId: `${table}:${path}`, parentId: parent, method: 'POST', body: new URLSearchParams({name: table, area: 'free', language: 'de', ...params}).toString(), format: path.endsWith('tablefile') ? 'csv' : 'json'};
}
function page(resources: ResourceReference[], snapshot: AdmittedSnapshot, scope: AdapterScope, cursor: string | null): DiscoveryResult {
  const binding = semanticHash({source: snapshot.sourceSha256, scope, resources});
  let offset = 0;
  if (cursor !== null) {
    const decoded = object(JSON.parse(cursor));
    if (decoded.binding !== binding || typeof decoded.offset !== 'number' || !Number.isInteger(decoded.offset) || decoded.offset < 0 || decoded.offset >= resources.length) throw Error('Invalid or cross-snapshot discovery cursor');
    offset = decoded.offset;
  }
  const next = offset + 1 < resources.length ? canonicalJson({binding, offset: offset + 1}) : null;
  return {resources: resources.slice(offset, offset + 1), coverage: coverage(snapshot, scope, 'partial', 'Bounded request references only; neither fetch nor GAST query has been exercised', 0, next)};
}
function regionVariable(native: Json, level: 'GE' | 'KR'): string {
  const rows = object(native.Structure).Rows;
  if (!Array.isArray(rows)) throw Error('Native table metadata lacks Rows');
  const regions = rows.map(object).filter(row => /Gemeind|Kreise/i.test(String(row.Content)));
  if (regions.length !== 1 || typeof regions[0].Code !== 'string' || !/^[A-Za-z0-9]{1,6}$/.test(regions[0].Code)) throw Error('Geographic variable is not unambiguously documented by native metadata');
  if ((/Gemeind/i.test(String(regions[0].Content)) ? 'GE' : 'KR') !== level) throw Error('Native metadata geography conflicts with catalog level');
  return regions[0].Code;
}
function discover(snapshot: AdmittedSnapshot, scope: AdapterScope, cursor: string | null, sourceId = 'regionalstatistik-genesis', tables: GenesisTables = GENESIS_TABLES): DiscoveryResult {
  try {
    const {content: source} = text(snapshot, scope, sourceId);
    if (source.trimStart().startsWith('<')) {
      if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw Error('XML entities are not permitted');
      // Only admitted publisher WADL, not an invented normalized discovery feed.
      const $ = load(source, {xmlMode: true});
      if ($('application').attr('xmlns') !== 'http://wadl.dev.java.net/2009/02') throw Error('Changed WADL namespace');
      const resources = $('application > resources');
      if (resources.length !== 1 || resources.attr('base') !== GENESIS_BASE) throw Error('Changed WADL publisher base');
      for (const [service, method] of [['metadata', 'table'], ['data', 'table'], ['data', 'tablefile']]) {
        const operation = resources.children('resource').filter((_, element) => $(element).attr('path') === `/${service}`).children('resource').filter((_, element) => $(element).attr('path') === `/${method}`);
        if (operation.length !== 1 || operation.children('method').filter((_, element) => $(element).attr('name') === 'POST').length !== 1) throw Error('Changed WADL POST capabilities');
      }
      return page(Object.entries(tables).map(([table, definition]) => request('metadata/table', definition.requestName ?? table, {}, snapshot.url)), snapshot, scope, cursor);
    }
    const root = object(JSON.parse(source));
    const failure = nativeFailure(root);
    if (failure) return {resources: [], coverage: coverage(snapshot, scope, failureState(failure), failure)};
    const ident = object(root.Ident);
    if (ident.Service !== 'metadata' || ident.Method !== 'table') throw Error('Discovery expects WADL or native metadata/table response');
    const native = object(root.Object);
    const table = knownTable(native.Code, tables);
    const regionalvariable = regionVariable(native, tables[table].level);
    // A single explicit year makes requests bounded. The observation window is not a data release date.
    const year = /^(19\d{2}|20\d{2}|2100)(?:$|-)/.exec(scope.observationWindow)?.[1];
    if (!year) throw Error('Discovery requires a year or ISO-date observation window');
    const params = {regionalvariable, regionalkey: tables[table].level === 'GE' ? scope.ags : scope.ags.slice(0, 5), startyear: year, endyear: year, compress: 'false', transpose: 'false', job: 'false'};
    const requestName = tables[table].requestName ?? table;
    const dataParams=table==='31231-02-01'?{...params,format:'datencsv',quality:'on'}:params;
    return page([request('data/table', requestName, dataParams, `${table}:metadata/table`), request('data/tablefile', requestName, {...params, format: 'datencsv', quality: 'on'}, `${table}:metadata/table`)], snapshot, scope, cursor);
  } catch (error) {
    return {resources: [], coverage: coverage(snapshot, scope, 'held_quality', error instanceof Error ? error.message : 'Invalid native discovery snapshot')};
  }
}
function csv(source: string): string[][] {
  const rows = readCsv(new TextEncoder().encode(source), {delimiter: ';'}).rows;
  if (rows.length > MAX_ROWS || rows.some(row => row.length > MAX_COLUMNS)) throw Error('Native CSV row/column bound exceeded');
  return rows.map(row => row.map(cell => cell.raw));
}
function cellValue(raw: string): number | null {
  const value = raw.trim();
  // '-' is the publisher's exact-zero sign; suppression/missing signs are not zero.
  if (value === '-') return 0;
  if (['', '.', '...', '…', '/', 'x', 'X'].includes(value)) return null;
  if (!/^[+-]?\d+(?:,\d+)?$/.test(value)) throw Error(`Unknown native value/quality encoding: ${value}`);
  const result = Number(value.replace(',', '.'));
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) throw Error('Unsafe native numeric value');
  return result;
}
function referenceDate(parts: string[], definition: GenesisTableDefinition): string {
  const dates = parts.flatMap(part => [...part.matchAll(/\b(\d{2})\.(\d{2})\.((?:19|20)\d{2}|2100)\b/g)].map(match => `${match[3]}-${match[2]}-${match[1]}`));
  const unique = [...new Set(dates)];
  if (unique.length > 1) throw Error('Ambiguous source reference dates');
  if (unique.length === 1) {
    if (unique[0].slice(5) !== definition.referenceDay) throw Error('Reference date conflicts with catalog table semantics');
    return unique[0];
  }
  const years = [...new Set(parts.filter(part => /^(?:19|20)\d{2}$|^2100$/.test(part.trim())).map(part => part.trim()))];
  if (years.length !== 1) throw Error('Missing or ambiguous source reference year');
  return `${years[0]}-${definition.referenceDay}`;
}
export function parseGenesisTable(snapshot: AdmittedSnapshot, scope: AdapterScope, sourceId = 'regionalstatistik-genesis', tables: GenesisTables = GENESIS_TABLES): ParseResult {
  try {
    const {content: source, member} = text(snapshot, scope, sourceId);
    let content = source, root: Json | null = null, native: Json | null = null;
    if (source.trimStart().startsWith('{')) {
      root = object(JSON.parse(source));
      const failure = nativeFailure(root);
      if (failure) return {observations: [], coverage: coverage(snapshot, scope, failureState(failure), failure)};
      const ident = object(root.Ident);
      if (ident.Service !== 'data' || ident.Method !== 'table') throw Error('Expected native data/table response');
      native = object(root.Object);
      if (typeof native.Content !== 'string') throw Error('Missing native Object.Content');
      content = native.Content;
    }
    // An invalid present title is not an absent title: never silently replace it
    // with Parameter.name, or truncate an unknown depth suffix.
    const titles = content.match(/^[ \t]*(?:GENESIS-)?Tabelle\b[^\r\n]*/gm) ?? [];
    if (titles.length > 1) throw Error('Ambiguous native table titles');
    const title = titles[0];
    const tableMatch = title === undefined ? null : /^((?:GENESIS-)?Tabelle):[ \t]*([^\s;]+)[ \t]*$/.exec(title);
    if (titles.length && !tableMatch) throw Error('Malformed native table title');
    const parameters = root ? object(root.Parameter) : null;
    const table = knownTable(tableMatch?.[2] ?? parameters?.name, tables);
    if (parameters && knownTable(parameters.name, tables) !== table) throw Error('Content/Parameter table mismatch');
    const rows = csv(content);
    const footer = rows.findIndex(row => row[0].startsWith('__________'));
    if (footer < 0) throw Error('Missing native table terminator; possibly truncated export');
    // FrontColumnsNumber is a documented data/table field, not our own row schema.
    const layout = native?.TableLayout ? object(native.TableLayout) : null;
    const metadata = [
      'Bevölkerung nach Geschlecht und Altersgruppen (17) -',
      'Stichtag 31.12. - regionale Tiefe: Gemeinden',
      'Fortschreibung des Bevölkerungsstandes',
      'Bevölkerungsstand (Anzahl)',
    ];
    // Detect the municipal candidate independently of header/layout validity.
    // A malformed candidate must never escape into the generic explicit-layout path.
    const municipalDatencsv = table === '12411-02-03' && tableMatch?.[1] === 'Tabelle' &&
      metadata.some((label, index) => rows[index + 1]?.[0] === label);
    const front = layout ? Number(layout.FrontColumnsNumber) : municipalDatencsv ? 4 : 2;
    if (!Number.isInteger(front) || front < 1 || front > 8) throw Error('Changed native front-column layout');
    const selection = typeof parameters?.regionalkey === 'string' && /^\d{8}$|^\d{5}$/.test(parameters.regionalkey) ? parameters.regionalkey : null;
    const structure = native?.Structure ? object(native.Structure) : null;
    const regionRows = Array.isArray(structure?.Rows) ? structure.Rows.map(object).filter(row => /Gemeind|Kreise/i.test(String(row.Content))) : [];
    const selectedRegion = regionRows.length === 1 && regionRows[0].Code === parameters?.regionalvariable && String(regionRows[0].Selected) === '1' ? regionRows[0] : null;
    const municipalHousing=table==='31231-02-01',housingYear=/^((?:19|20)\d{2}|2100)(?:$|-)/.exec(scope.observationWindow)?.[1];
    if(municipalHousing&&(!housingYear||tables[table].level!=='GE'||root&&(parameters?.format!=='datencsv'||parameters.regionalvariable!=='GEMEIN'||selection!==scope.ags||!selectedRegion||!/Gemeind/i.test(String(selectedRegion.Content)))))throw Error('Housing stock requires the exact evidenced municipal GEMEIN selection, reference year and datencsv format');
    if (municipalDatencsv) {
      if (tables[table].level !== 'GE' || front !== 4 ||
          rows[0]?.length !== 1 || rows[0][0] !== tableMatch?.[0] ||
          metadata.some((label, index) => rows[index + 1]?.length !== 7 || rows[index + 1][0] !== label || rows[index + 1].slice(1).some(Boolean)) ||
          canonicalJson(rows[5] ?? []) !== canonicalJson(['', '', '', '', 'Insgesamt', 'männlich', 'weiblich'])) {
        throw Error('Unrecognized municipal datencsv header/layout');
      }
      if (root && (parameters?.format !== 'datencsv' || parameters.regionalvariable !== 'GEMEIN' ||
          !selection || selection.length !== 8 || !selectedRegion || selectedRegion.Code !== 'GEMEIN')) {
        throw Error('Municipal datencsv requires evidenced GEMEIN single selection');
      }
    }
    const header: string[][] = [];
    const observations: ParseResult['observations'] = [];
    let observedRows = 0, started = false;
    let schemaHash: string | null = null;
    let headerWidth = 0;
    for (let r = 1; r < footer; r++) {
      const row = rows[r];
      if (municipalDatencsv && r >= 6 &&
          (row.length !== 7 || !/^\d{2}\.\d{2}\.(?:(?:19|20)\d{2}|2100)$/.test(row[0]) ||
           !/^\d{8}$/.test(row[1]) || !row[2].trim() ||
           !/^(?:unter \d+ Jahre|\d+ bis unter \d+ Jahre|\d+ Jahre und mehr|Insgesamt)$/.test(row[3]) ||
           selection !== null && row[1] !== selection)) {
        throw Error('Changed municipal datencsv dimensions or selection mismatch');
      }
      const leading = row.slice(0, front);
      const code = leading.find(value => /^\d{8}$|^\d{5}$/.test(value.trim()))?.trim();
      const hasFront = leading.some(value => value.trim() !== '');
      const values = row.slice(front);
      const numericCells = values.length > 0 && values.every(value => /^[+-]?\d+(?:,\d+)?$|^[-.\/xX…]$|^\.\.\.$|^$/.test(value.trim()));
      if (code && !numericCells) throw Error('Changed native value columns');
      if (!started && !(hasFront && numericCells && (code || selectedRegion && values.some(value => value.trim() !== '')))) {header.push(row); continue;}
      if (!hasFront && row.every(value => !value.trim())) continue;
      if (!numericCells || !hasFront) throw Error('Changed or incomplete native data row');
      if (!headerWidth) headerWidth = Math.max(...header.map(line => line.length));
      if (row.length !== headerWidth) throw Error('Native row/header column-count mismatch');
      started = true; observedRows++;
      schemaHash ??= semanticHash({table, front, structure, header, tables, mapping: GENESIS_VERSION});
      if (!code && !selectedRegion) throw Error('Uncoded multi-region rows require evidenced native selection');
      const activeCode = code ?? selection;
      if (!activeCode) throw Error('No evidenced native administrative-area code');
      const level = activeCode.length === 8 ? 'GE' : 'KR';
      if(municipalHousing&&level!=='GE')throw Error('Municipal housing stock cannot admit a district aggregate');
      if (!code && selectedRegion && (/Kreise/i.test(String(selectedRegion.Content)) ? 'KR' : 'GE') !== level) throw Error('Native region level/key mismatch');
      if (level === 'GE' && activeCode !== scope.ags) continue;
      if (level === 'KR' && activeCode !== scope.ags.slice(0, 5)) continue;
      for (let c = front; c < row.length; c++) {
        if (observations.length >= MAX_OBSERVATIONS) throw Error('Native observation output bound exceeded');
        const column = header.map(line => line[c] ?? '').filter(Boolean);
        const all = [...leading, ...column, ...header.filter(line => line.slice(1).every(value => !value)).map(line => line[0])];
        const date = referenceDate(all, tables[table]);
        if(municipalHousing&&date.slice(0,4)!==housingYear)throw Error('Housing stock reference year differs from the requested observation window');
        const units = [...new Set(all.flatMap(value => [...value.matchAll(/\((Anzahl|1000 m²|1 000 m²|m²|qm|%)\)/g)].map(match => match[1])))];
        if (units.length !== 1) throw Error('Missing or ambiguous native unit');
        const rawValue = row[c];
        const value = cellValue(rawValue);
        const dimensions = {front: leading, column};
        const nativeId = `${table}:${level}:${activeCode}:${date}:${semanticHash(dimensions)}`;
        const cells = [...leading.map((_, index) => `r${r + 1}c${index + 1}`), `r${r + 1}c${c + 1}`];
        const pathPrefix = root ? '$.Object.Content/' : member ? `archive/${member}/` : '';
        const locator = {sourceSha256: snapshot.sourceSha256, format: root ? 'json' as const : 'csv' as const, nativeId, path: `${pathPrefix}r${r + 1}c${c + 1}`, sheet: member, rowKey: canonicalJson({table, region: activeCode, date, dimensions}), cells, rawValue, schemaHash, mappingVersion: GENESIS_VERSION};
        const headerEvidence = header.flatMap((line, index) => {
          const columnRaw = line[c];
          const globalRaw = line.slice(1).every(value => !value) ? line[0] : null;
          return [[columnRaw, c], [globalRaw, 0]].filter(([raw]) => typeof raw === 'string' && raw !== '').map(([raw, columnIndex]) => ({...locator, path: `${pathPrefix}r${index + 2}c${Number(columnIndex) + 1}`, cells: [`r${index + 2}c${Number(columnIndex) + 1}`], rawValue: String(raw)}));
        });
        const regionEvidence = !code && parameters ? [{...locator, path: '$.Parameter.regionalkey', cells: ['regionalkey'], rawValue: activeCode}] : [];
        const frontEvidence = leading.map((raw, index) => ({...locator, path: `${pathPrefix}r${r + 1}c${index + 1}`, cells: [`r${r + 1}c${index + 1}`], rawValue: raw}));
        observations.push(observation({publisherId: scope.publisherId, sourceId: scope.sourceId, nativeId, nativeVersion: snapshot.sourceVersion, kind: 'StatisticalObservation', subject: `regionalstatistik:${level}:${activeCode}`, predicate: `describes:${tables[table].statistic}`, value, unit: units[0], date, dateRole: 'statistical_reference_date', financialRole: 'none', geography: {ags: level === 'GE' ? activeCode : null, basis: 'source_explicit', role: 'administrative_area'}, sourceReferenceDate: date, publishedAt: null, retrievedAt: snapshot.retrievedAt, evidence: [locator, ...frontEvidence, ...headerEvidence, ...regionEvidence], limitations: [...LIMITATIONS, `native_geography_level=${level};native_region_code=${activeCode}`, 'Reference dates from year-only cells use the Regio-Stat 2026 table-specific day.', ...(value === null ? [`Missing/suppressed/non-applicable source cell retained: ${rawValue}`] : [])]}));
      }
    }
    if (!started && !municipalDatencsv) {
      const lastHeader = header.filter(row => row.some(value => value.trim())).at(-1);
      if (!lastHeader || lastHeader.slice(0, front).some(value => value.trim()) || !lastHeader.slice(front).some(value => /\d{4}/.test(value))) throw Error('Unrecognized rows cannot establish an empty result');
    }
    return {observations, coverage: coverage(snapshot, scope, observations.length ? 'partial' : 'empty', observations.length ? 'Parsed attributed native cells; full table/municipality coverage remains unverified' : 'No matching cells in this bounded terminated slice; not evidence of absence or withdrawal', observedRows)};
  } catch (error) {
    return {observations: [], coverage: coverage(snapshot, scope, 'held_quality', error instanceof Error ? error.message : 'Invalid native table snapshot')};
  }
}
export function createGenesisAdapter(sourceId: string, tables: GenesisTables): StructuredAdapter {
  // Freeze the mapping at construction; caller edits cannot silently change replay semantics.
  const definitions: GenesisTables = Object.freeze(Object.fromEntries(Object.entries(tables).map(([code, definition]) => {
    if (!/^\d{5}-\d{2}-\d{2}$/.test(code) || !/^\d{2}-\d{2}$/.test(definition.referenceDay) || !['GE', 'KR'].includes(definition.level)) throw Error('Invalid catalog GENESIS mapping');
    if (definition.requestName !== undefined && (code !== '12411-02-03' || definition.requestName !== '12411-02-03-5' || definition.level !== 'GE')) throw Error('Invalid explicit GENESIS request-name mapping');
    return [code, Object.freeze({...definition})];
  })));
  return {id: sourceId, version: GENESIS_VERSION, discover: (snapshot, scope, cursor) => discover(snapshot, scope, cursor, sourceId, definitions), parse: (snapshot, scope) => parseGenesisTable(snapshot, scope, sourceId, definitions)};
}
export const genesisAdapter = createGenesisAdapter('regionalstatistik-genesis', GENESIS_TABLES);
