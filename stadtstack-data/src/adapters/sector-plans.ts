import {load} from 'cheerio';
import type {CheerioAPI} from 'cheerio';
import type {AnyNode} from 'domhandler';
import {assertSnapshot, observation, semanticHash} from '../district-adapter-contract.ts';
import type {AdmittedSnapshot, AdapterCoverage, AdapterScope, DiscoveryResult, ParseResult, StructuredAdapter, StructuredObservation} from '../district-adapter-contract.ts';

export const SECTOR_PLANS_VERSION = 'sector-plans-html-v1';
export const SECTOR_PLAN_SOURCES = {
  'sep-mol': {type: 'school', district: '12064'},
  'sep-lup': {type: 'school', district: '13076'},
  'sep-rz-gap': {type: 'school', district: '01053'},
  'nvp-mol': {type: 'transport', district: '12064'},
  'rnvp-rz': {type: 'transport', district: '01053'},
  'rnvp-lup': {type: 'transport', district: '13076'},
} as const;
const LIMITS = {bytes: 4_000_000, links: 256, rows: 2000, cells: 32};
const LIMITATIONS = [
  'Distribution-specific rights remain unresolved; only externally admitted snapshots may enter this parser.',
  'District plan metadata is not assigned to every municipality; only explicit eight-digit AGS fields assign table geography.',
  'Forecast capacity, catchments and target service do not establish implemented seats, actual service, expenditure or outcomes.',
  'Native PDF tables require an isolated PDF preparation and PDF locator contract; HTML tables are not a substitute for those originals.',
  'Document URL identity is a source-document identity, not a counted project or verified facility identity.',
];
type SourceId = keyof typeof SECTOR_PLAN_SOURCES;
interface Link {url: string; title: string; rawTitle: string; path: string; withdrawn: boolean; context: string; contextPath: string}
interface Field {predicate: string; unit: string | null; numeric: boolean}
const SCHOOL_FIELDS: Record<string, Field> = {
  'plätze (prognose)': {predicate: 'forecast_capacity', unit: 'seats', numeric: true},
  'schülerprognose': {predicate: 'forecast_pupils', unit: 'pupils', numeric: true},
  'schuleinzugsbereich': {predicate: 'planned_catchment', unit: null, numeric: false},
};
const TRANSPORT_FIELDS: Record<string, Field> = {
  'zielangebot': {predicate: 'target_service', unit: null, numeric: false},
  'mindestbedienung': {predicate: 'target_service_standard', unit: null, numeric: false},
  'zieltakt (minuten)': {predicate: 'target_service_interval', unit: 'minutes', numeric: true},
};
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
function source(scope: AdapterScope) {
  if (!Object.hasOwn(SECTOR_PLAN_SOURCES, scope.sourceId)) throw Error('Unknown sector-plan source');
  return SECTOR_PLAN_SOURCES[scope.sourceId as SourceId];
}
function coverage(snapshot: AdmittedSnapshot, scope: AdapterScope, state: AdapterCoverage['state'], reason: string, rows = 0, nextCursor: string | null = null): AdapterCoverage {
  return {state, scope: `${scope.publisherId}/${scope.sourceId}/${scope.observationWindow}`, reason, checkedAt: snapshot.retrievedAt, nextCursor, observedRows: rows, limitations: LIMITATIONS};
}
function publicReference(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    // Acquisition owns origin/redirect/rights admission, including host checks.
    url.hash = '';
    return url.href;
  } catch {return null;}
}
function relevant(title: string, type: 'school' | 'transport'): boolean {
  return type === 'school' ? /schulentwicklungsplan(?:ung)?/i.test(title) : /(?:regional(?:er|en)?\s+)?nahverkehrsplan|\bRNVP\b/i.test(title);
}
function domPath($: CheerioAPI, element: AnyNode): string {
  const parts: string[] = [];
  let node = $(element);
  while (node.length) {
    const current = node.get(0);
    if (current?.type !== 'tag') break;
    const tag = current.name;
    const index = node.prevAll(tag).length + 1;
    parts.unshift(`${tag}:nth-of-type(${index})`);
    node = node.parent();
  }
  return parts.join(' > ');
}
function links($: CheerioAPI, snapshot: AdmittedSnapshot, scope: AdapterScope): Link[] {
  const result: Link[] = [];
  const type = source(scope).type;
  $('a[href]').each((_, element) => {
    const anchor = $(element);
    if (anchor.closest('nav,header,footer').length) return;
    const rawTitle = anchor.text();
    const title = normalized(rawTitle);
    if (!relevant(title, type)) return;
    const url = publicReference(anchor.attr('href')!, snapshot.url);
    if (!url) return;
    const paragraph = anchor.closest('p,li');
    const context = paragraph.length ? paragraph.text() : rawTitle;
    const unambiguousContext = paragraph.length && paragraph.find('a[href]').toArray().filter(el => relevant($(el).text(), type)).length === 1;
    result.push({url, rawTitle, title, path: domPath($, element), withdrawn: /\b(?:zurückgezogen|aufgehoben)\b/i.test(title), context: unambiguousContext ? context : rawTitle, contextPath: unambiguousContext ? domPath($, paragraph.get(0)!) : domPath($, element)});
  });
  return result;
}
function inspect(snapshot: AdmittedSnapshot, scope: AdapterScope): {html: CheerioAPI | null; hold: AdapterCoverage | null} {
  assertSnapshot(snapshot);
  const config = source(scope);
  if (!scope.ags.startsWith(config.district)) return {html: null, hold: coverage(snapshot, scope, 'not_applicable', 'Municipality scope is outside the catalog district.')};
  if (snapshot.bytes.length > LIMITS.bytes) return {html: null, hold: coverage(snapshot, scope, 'held_quality', 'Snapshot exceeds the bounded HTML byte limit.')};
  if (snapshot.mimeType.split(';')[0].trim().toLowerCase() !== 'text/html') return {html: null, hold: coverage(snapshot, scope, 'held_quality', 'Native PDF/other bytes cannot be represented by the pinned HTML structured locator; isolated preparation and PDF evidence binding are required.')};
  let text: string;
  try {text = new TextDecoder('utf-8', {fatal: true}).decode(snapshot.bytes);}
  catch {return {html: null, hold: coverage(snapshot, scope, 'held_quality', 'HTML encoding is not valid UTF-8; no replacement-character evidence.')};}
  const $ = load(text);
  if ($('input[type=password]').length || /captcha|access denied|zugriff verweigert/i.test($('title,h1').text())) return {html: null, hold: coverage(snapshot, scope, 'blocked_access', 'Snapshot is an access-control page, not an empty plan index.')};
  if (scope.sourceId === 'sep-rz-gap') return {html: null, hold: coverage(snapshot, scope, 'not_checked', 'Current Lauenburg school-development plan remains unlocated; contact page and historical agenda items are not a current plan.')};
  if (links($, snapshot, scope).length > LIMITS.links || $('tr').length > LIMITS.rows) return {html: null, hold: coverage(snapshot, scope, 'held_quality', 'Snapshot exceeds bounded link or table-row limits; no silent truncation.')};
  return {html: $, hold: null};
}
function nextPage($: CheerioAPI, snapshot: AdmittedSnapshot): string | null {
  const href = $('a[rel~=next],link[rel~=next]').first().attr('href');
  return href ? publicReference(href, snapshot.url) : null;
}
export function discoverSectorPlans(snapshot: AdmittedSnapshot, scope: AdapterScope, cursor: string | null = null): DiscoveryResult {
  assertSnapshot(snapshot);
  const config = source(scope);
  if (cursor !== null && cursor !== snapshot.url) return {resources: [], coverage: coverage(snapshot, scope, 'held_quality', 'Cursor must identify the supplied admitted page, not request a hidden network fetch.')};
  if (scope.ags.startsWith(config.district) && scope.sourceId !== 'sep-rz-gap' && snapshot.mimeType.split(';')[0].trim().toLowerCase() === 'application/pdf') {
    return {resources: [{url: snapshot.url, nativeId: snapshot.url, parentId: null, method: 'GET', body: null, format: 'pdf'}], coverage: coverage(snapshot, scope, 'partial', 'Admitted native PDF reference identified; table parsing remains held until isolated PDF preparation and PDF locators are available.', 1)};
  }
  const {html: $, hold} = inspect(snapshot, scope);
  if (hold || !$) return {resources: [], coverage: hold!};
  const found = links($, snapshot, scope);
  const resources = [...new Map(found.filter(item => !item.withdrawn).map(item => [item.url, {url: item.url, nativeId: item.url, parentId: snapshot.url, method: 'GET' as const, body: null, format: /\.pdf(?:$|[?&])/i.test(item.url) || /[?&]fid=[^&]*\.PDF(?:&|$)/i.test(item.url) ? 'pdf' : 'html'}])).values()];
  const next = nextPage($, snapshot);
  if (next) resources.push({url: next, nativeId: next, parentId: snapshot.url, method: 'GET', body: null, format: 'html'});
  return {resources, coverage: coverage(snapshot, scope, found.length || next ? 'partial' : 'empty', found.length ? 'Metadata references discovered; linked plan contents and archive completeness are not checked.' : 'No matching plan references on this supplied HTML page; this is not evidence of plan absence.', found.length, next)};
}
function calendarDate(raw: string): string | null {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
  if (!match) return null;
  const [, d, m, y] = match;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}
function adoption(context: string): {raw: string; date: string} | null {
  if (/nicht|noch|entwurf|vorschlag|soll|beabsichtigt|empf(?:iehlt|ohlen)|vorbehalt|aufgehoben|zurückgezogen/i.test(context)) return null;
  const match = /(?:vom|durch den|der)\s+Kreistag\b[^.!?]{0,120}?\bam\s+(\d{1,2}\.\d{1,2}\.\d{4})\s+(?:beschlossen|verabschiedet|angenommen)/i.exec(context);
  if (!match) return null;
  const date = calendarDate(match[1]);
  return date ? {raw: match[0], date} : null;
}
export function parseSectorPlans(snapshot: AdmittedSnapshot, scope: AdapterScope): ParseResult {
  const {html: $, hold} = inspect(snapshot, scope);
  if (hold || !$) return {observations: [], coverage: hold!};
  const config = source(scope);
  const observations: StructuredObservation[] = [];
  const emit = (nativeId: string, subject: string, predicate: string, value: string | number, raw: string, path: string, options: {unit?: string | null; date?: string | null; dateRole?: string | null; ags?: string | null; rowKey?: string; cells?: string[]; schema?: unknown; evidenceFields?: {path: string; raw: string}[]} = {}) => {
    const schemaHash = semanticHash(options.schema ?? {format: 'html', mapping: SECTOR_PLANS_VERSION, predicate});
    const evidence = [{path, raw}, ...(options.evidenceFields ?? [])].map(field => ({sourceSha256: snapshot.sourceSha256, format: 'html' as const, nativeId, path: field.path, sheet: null, rowKey: options.rowKey ?? null, cells: options.cells ?? [], rawValue: field.raw, schemaHash, mappingVersion: SECTOR_PLANS_VERSION}));
    observations.push(observation({publisherId: scope.publisherId, sourceId: scope.sourceId, nativeId, nativeVersion: snapshot.sourceVersion, kind: predicate === 'adopts_plan' ? 'Resolution' : config.type === 'school' ? 'SchoolDevelopmentPlanObservation' : 'TransportPlanObservation', subject, predicate, value, unit: options.unit ?? null, date: options.date ?? null, dateRole: options.dateRole ?? null, financialRole: 'none', geography: {ags: options.ags ?? null, basis: options.ags ? 'source_explicit' : 'unknown', role: options.ags ? 'administrative_area' : 'unknown'}, sourceReferenceDate: null, publishedAt: null, retrievedAt: snapshot.retrievedAt, evidence, limitations: LIMITATIONS}));
  };
  const found = links($, snapshot, scope);
  for (const link of found) {
    const titleFields = [{path: `${link.path}/@href`, raw: $(link.path).attr('href')!}];
    emit(link.url, link.url, link.withdrawn ? 'document_withdrawn' : 'plan_title', link.title, link.rawTitle, `${link.path}/text()`, {evidenceFields: titleFields});
    if (link.withdrawn) continue;
    const horizon = /\b\d{4}(?:\/\d{2})?\s*[–−-]\s*\d{4}(?:\/\d{2})?\b/.exec(link.title);
    if (horizon) emit(link.url, link.url, 'planning_horizon', horizon[0], link.rawTitle, `${link.path}/text()`, {dateRole: 'planning_horizon', evidenceFields: titleFields});
    const adopted = adoption(link.context);
    if (adopted) emit(link.url, link.url, 'adopts_plan', link.url, link.context, `${link.contextPath}/text()`, {date: adopted.date, dateRole: 'adoption', evidenceFields: titleFields});
  }
  let heldTable = false;
  let tableRows = 0;
  $('table').each((_, element) => {
    const table = $(element);
    // Tables must explicitly identify their plan locally; unrelated district statistics are not imported.
    const caption = normalized(table.find('caption').first().text());
    if (!relevant(caption, config.type)) return;
    if (/zurückgezogen|aufgehoben/i.test(caption)) return;
    const rows = table.find('tr');
    const header = rows.first().find('th,td');
    const names = header.toArray().map(cell => normalized($(cell).text()).toLowerCase());
    const keyHeader = config.type === 'school' ? 'schulnummer' : 'linie';
    const keyIndex = names.indexOf(keyHeader);
    const agsIndex = names.indexOf('ags');
    const periodIndex = names.indexOf(config.type === 'school' ? 'schuljahr' : 'planungszeitraum');
    const fields = config.type === 'school' ? SCHOOL_FIELDS : TRANSPORT_FIELDS;
    const mapped = names.flatMap((name, index) => fields[name] ? [{index, field: fields[name]}] : []);
    if (keyIndex < 0 || periodIndex < 0 || !mapped.length || names.length > LIMITS.cells || new Set(names).size !== names.length || table.find('[rowspan],[colspan]').length) {heldTable = true; return;}
    rows.slice(1).each((_, row) => {
      tableRows++;
      const cells = $(row).find('td,th');
      if (cells.length !== names.length) {heldTable = true; return;}
      const rawCells = cells.toArray().map(cell => $(cell).text());
      const key = normalized(rawCells[keyIndex]);
      const period = normalized(rawCells[periodIndex]);
      const ags = agsIndex < 0 ? null : normalized(rawCells[agsIndex]);
      if (!key || !period || (ags !== null && !/^\d{8}$/.test(ags))) {heldTable = true; return;}
      const nativeId = `${snapshot.url}#table=${encodeURIComponent(domPath($, element))}&${keyHeader}=${encodeURIComponent(key)}&period=${encodeURIComponent(period)}`;
      const subject = `${scope.publisherId}:${scope.sourceId}:${keyHeader}:${key}`;
      const rowObservations: Parameters<typeof emit>[] = [];
      for (const {index, field} of mapped) {
        const raw = rawCells[index];
        const value = normalized(raw);
        if (!value || /^(?:-|–|\.\.\.|k\.\s*A\.)$/i.test(value)) continue;
        // Counts and minute intervals use German integer notation, not decimal-point floats.
        const parsedValue = field.numeric ? Number(value.replaceAll('.', '')) : value;
        if (field.numeric && (!/^(?:\d+|[1-9]\d{0,2}(?:\.\d{3})+)$/.test(value) || !Number.isSafeInteger(parsedValue))) {heldTable = true; return;}
        const evidenceFields = [keyIndex, periodIndex, ...(agsIndex >= 0 ? [agsIndex] : [])].map(i => ({path: `${domPath($, cells.get(i)!)}/text()`, raw: rawCells[i]}));
        evidenceFields.push(...header.toArray().map(cell => ({path: `${domPath($, cell)}/text()`, raw: $(cell).text()})));
        evidenceFields.push({path: `${domPath($, element)} > caption/text()`, raw: table.find('caption').first().text()});
        rowObservations.push([nativeId, subject, field.predicate, parsedValue, raw, `${domPath($, cells.get(index)!)}/text()`, {unit: field.unit, ags, date: period, dateRole: 'planning_period', rowKey: key, cells: [names[index]], schema: names, evidenceFields}]);
      }
      for (const args of rowObservations) emit(...args);
    });
  });
  const next = nextPage($, snapshot);
  const unique = [...new Map(observations.map(item => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
  return {observations: unique, coverage: coverage(snapshot, scope, heldTable ? 'held_quality' : unique.length || next ? 'partial' : 'empty', heldTable ? 'Unrecognized/ambiguous table schema or invalid row; accepted metadata/rows do not imply complete table coverage.' : unique.length ? 'Deterministic native HTML metadata/table fields only; PDF contents and implemented outcomes remain unchecked.' : 'No supported sector-plan fields on this supplied page; no claim that the district has no plan.', tableRows + found.length, next)};
}
export const sectorPlansAdapter: StructuredAdapter = {id: 'sector-plans', version: SECTOR_PLANS_VERSION, discover: discoverSectorPlans, parse: parseSectorPlans};
export const sectorPlansCapabilityReceipt = {
  adapterId: sectorPlansAdapter.id, version: SECTOR_PLANS_VERSION, sourceIds: Object.keys(SECTOR_PLAN_SOURCES),
  nativeFormats: ['html', 'pdf'], implementedFormats: ['html'], parserNetwork: false,
  limits: LIMITS, pdfDisposition: 'held_quality', rzSchoolDisposition: 'not_checked',
  adoptionRequires: 'Explicit nonconditional Kreistag adoption statement with valid calendar date and exactly one locally linked plan.',
  tableMappings: {school: SCHOOL_FIELDS, transport: TRANSPORT_FIELDS},
  mappingValidation: 'Bounded synthetic native-HTML fixtures; source PDF table schemas have not been exercised.',
  limitations: LIMITATIONS,
} as const;
