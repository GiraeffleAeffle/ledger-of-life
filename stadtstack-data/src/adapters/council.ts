import {load} from 'cheerio';
import {parseOparlList, councilEventDate} from '../council-oparl.ts';
import {assertSnapshot, observation, semanticHash, ScopeSchema, StructuredLocatorSchema} from '../district-adapter-contract.ts';
import type {AdmittedSnapshot, AdapterScope, AdapterCoverage, StructuredAdapter, StructuredLocator, StructuredObservation, ResourceReference} from '../district-adapter-contract.ts';

export const COUNCIL_MAPPING_VERSION = 'council-native-v3';
const schemaHash = semanticHash({version: COUNCIL_MAPPING_VERSION, formats: ['OParl-1.0', 'OParl-1.1', 'ALLRIS', 'SessionNet'], people: false});
const limitations = ['Metadata only; agenda/paper/meeting dates do not establish adoption, permit, fulfillment or payment.', 'People, membership and contact fields are excluded.', 'Coverage describes this admitted snapshot, not the whole archive; rights are distribution-specific.', 'Meeting schedules and agenda links do not establish that a meeting was held; cancellation/state fields remain attributed, including contradictions.', 'Decision results are raw attributed source fields, not a legal-stage ladder or proof of adoption/in-force status. Administrative origin is not inferred proposer/faction/authority or verified legal identity.'];
const blockedSources: Record<string, string> = {
 'district-council-lup': 'Catalog-observed HTTP 404 at bis.kreis-lup.de; no bypass or live recheck.',
 'amt-maerkische-schweiz': 'Catalog-observed HTTP 403 at public root; unresolved access.',
 'council-hagenow': 'Catalog-observed login-only council; authentication is not authorized.',
};
const sourceRoots: Record<string, string> = {
 'council-strausberg': 'https://strausberg.allris.cloud/',
 'council-hoppegarten': 'https://ratsinfo.gemeinde-hoppegarten.de/',
 'council-ruedersdorf-bei-berlin': 'https://ratsinfo-online.net/ruedersdorf-bi/',
 'council-ratzeburg': 'https://session.ratzeburg.de/',
 'council-moelln': 'https://www.moelln.sitzung-online.de/',
 'council-schwarzenbek': 'https://sessionnet.owl-it.de/schwarzenbek/bi/',
 'council-ludwigslust': 'https://ris.ludwigslust.de/',
 'council-parchim': 'https://parchim.sitzung-mv.de/',
 'council-hagenow': 'https://hagenow.sitzung-mv.de/',
 'district-council-mol': 'https://www.ratsinfo-online.net/landkreis-mol-bi/',
 'district-council-rz': 'https://www.herzogtum-lauenburg.sitzung-online.de/',
 'district-council-lup': 'https://bis.kreis-lup.de/',
 'amt-maerkische-schweiz': 'https://amt-maerkische-schweiz.ratsinfomanagement.net/',
 'amt-lauenburgische-seen': 'https://www.lauenburgische-seen.sitzung-online.de/',
 'amt-ludwigslust-land': 'https://ludwigslustland.sitzung-mv.de/',
 'amt-buechen': 'https://sessionnet.amt-buechen.de/bi/',
 'amt-ms-oberbarnim': 'https://amt-maerkische-schweiz.ratsinfomanagement.net/oberbarnim/',
 'amt-ms-buckow': 'https://amt-maerkische-schweiz.ratsinfomanagement.net/buckow/',
 'amt-ms-rehfelde': 'https://amt-maerkische-schweiz.ratsinfomanagement.net/rehfelde/',
 'amt-ms-garzaugarzin': 'https://amt-maerkische-schweiz.ratsinfomanagement.net/garzaugarzin/',
 'amt-ms-waldsieversdorf': 'https://amt-maerkische-schweiz.ratsinfomanagement.net/waldsieversdorf/',
 'amt-ms-maerkischehoehe': 'https://amt-maerkische-schweiz.ratsinfomanagement.net/maerkischehoehe/',
};

/** A separately evidenced registry/body join, not the caller's requested municipality.
 * District and Amt bodies normally have null AGS. Five-digit prefixes are never padded.
 */
export interface CouncilBodyBinding {
 sourceId: string; tenant: string | null; bodyId: string; ags: string | null;
 evidence: StructuredLocator;
}
export interface CouncilAdapterOptions {bodyBindings?: readonly CouncilBodyBinding[]; maxBytes?: number; maxRecords?: number}
interface Field {path: string; raw: string | number | boolean | null; predicate: string; dateRole?: string}
interface RecordMetadata {id: string; kind: string; body: string | null; version: string | null; fields: Field[]; deleted: boolean; path: string; format: 'json' | 'html'}
interface Decoded {records: RecordMetadata[]; resources: ResourceReference[]; next: string | null; recognized: boolean; blocked: string | null}
const resource = (url: string, parentId: string | null, format: string): ResourceReference => ({url, nativeId: url, parentId, method: 'GET', body: null, format});
function safeUrl(raw: string, base: string): string {
 const u = new URL(raw, base);
 if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw Error('Unsafe council resource URL');
 return u.href;
}
function dateValue(raw: string): string | null {
 const german = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw.trim());
 const value = german ? `${german[3]}-${german[2]}-${german[1]}` : raw;
 return councilEventDate({id: 'date', date: value}, 'paper');
}
function nativeKind(url: string): string | null {
 const u = new URL(url), p = u.pathname.toLowerCase();
 if (/\/(?:si005(?:_e)?(?:\.asp)?|si0040?\.php|si0057\.php)$/.test(p)) return 'Meeting';
 if (/\/(?:vo005(?:_e)?(?:\.asp)?|vo0050\.php)$/.test(p)) return 'Paper';
 if (/\/(?:to020(?:_e)?(?:\.asp)?|to0050\.php)$/.test(p)) return 'AgendaItem';
 if (/\/(?:gr020(?:_e)?(?:\.asp)?|gr0040\.php)$/.test(p)) return 'Body';
 return null;
}
function decode(snapshot: AdmittedSnapshot, maxRecords: number): Decoded {
 const text = new TextDecoder('utf-8', {fatal: true}).decode(snapshot.bytes);
 const result: Decoded = {records: [], resources: [], next: null, recognized: false, blocked: null};
 if (/json/i.test(snapshot.mimeType)) {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Changed OParl envelope');
  const root = data as Record<string, unknown>;
  let objects: Record<string, unknown>[];
  if (Array.isArray(root.data)) {
   if (root.data.length > maxRecords) throw Error('Council record bound exceeded');
   if (!root.data.length) {
    // The empty native envelope still validates pagination, without guessing a body/type.
    const page = parseOparlList(root, snapshot.url, 'Body'); result.next = page.next; objects = [];
   } else {
    const first = root.data[0] as Record<string, unknown>;
    const kind = typeof first?.type === 'string' ? first.type.split('/').at(-1) : null;
    if (kind === 'Body' || kind === 'Paper' || kind === 'Meeting') {
     const page = parseOparlList(root, snapshot.url, kind); result.next = page.next; objects = page.records as Record<string, unknown>[];
    } else throw Error('Unsupported OParl list type; people are excluded');
   }
  } else objects = [root];
  result.recognized = true;
  const entries: {item: Record<string, unknown>; path: string; parentMeetingFields?: Field[]}[] = objects.map((item, i) => ({item, path: Array.isArray(root.data) ? `/data/${i}` : ''}));
  for (const entry of entries.slice()) {
   if (entry.item.deleted === true) continue;
   if (Array.isArray(entry.item.agendaItem)) {
    for (const [i, agenda] of entry.item.agendaItem.entries()) {
     if (!agenda || typeof agenda !== 'object' || Array.isArray(agenda)) throw Error('Changed embedded agenda schema');
     const parentMeetingFields: Field[] = [];
     if (typeof entry.item.cancelled === 'boolean') parentMeetingFields.push({path: `${entry.path}/cancelled`, raw: entry.item.cancelled, predicate: 'parent_meeting_cancelled'});
     if (typeof entry.item.meetingState === 'string') parentMeetingFields.push({path: `${entry.path}/meetingState`, raw: entry.item.meetingState, predicate: 'parent_meeting_state'});
     entries.push({item: agenda as Record<string, unknown>, path: `${entry.path}/agendaItem/${i}`, parentMeetingFields});
    }
   }
  }
  if (entries.length > maxRecords) throw Error('Council record bound exceeded');
  for (const {item, path, parentMeetingFields} of entries) {
   if (typeof item.id !== 'string' || typeof item.type !== 'string' || !/^https?:\/\/schema\.oparl\.org\/1\.[01]\/(System|Body|Organization|Meeting|Paper|AgendaItem|File)$/.test(item.type)) throw Error('Changed or excluded OParl object');
   const id = safeUrl(item.id, snapshot.url), kind = item.type.split('/').at(-1)!;
   const fields: Field[] = [...(parentMeetingFields ?? [])];
   let meetingDateRole = 'scheduled_meeting';
   if (kind === 'Meeting') {
    if (item.cancelled !== undefined && typeof item.cancelled !== 'boolean') throw Error('Changed Meeting.cancelled type');
    if (item.meetingState !== undefined && typeof item.meetingState !== 'string') throw Error('Changed Meeting.meetingState type');
    if (typeof item.cancelled === 'boolean') fields.push({path: `${path}/cancelled`, raw: item.cancelled, predicate: 'meeting_cancelled'});
    if (typeof item.meetingState === 'string') fields.push({path: `${path}/meetingState`, raw: item.meetingState, predicate: 'meeting_state'});
    // Preserve contradictory state/flag pairs without treating cancellation as a held event.
    // A false/absent cancellation flag does not establish that a meeting was held.
    meetingDateRole = item.cancelled === true || item.meetingState === 'cancelled' ? 'cancelled_meeting_schedule' : item.meetingState === 'held' ? 'meeting' : 'scheduled_meeting';
   }
   const mapping: Record<string, string> = {name: 'name', reference: 'reference', body: 'belongs_to_body', start: 'meeting_start', end: 'meeting_end', date: 'paper_date', created: 'source_created', modified: 'source_modified', meeting: 'agenda_meeting', paper: 'references_paper', number: 'agenda_number', resolutionText: 'resolution_text', resolutionFile: 'resolution_document'};
   for (const [key, predicate] of Object.entries(mapping)) {
    if (key === 'date' && kind !== 'Paper' || ['start', 'end'].includes(key) && kind !== 'Meeting') continue;
    const raw = item[key];
    if (typeof raw === 'string' || typeof raw === 'number') fields.push({path: `${path}/${key}`, raw, predicate, dateRole: key === 'start' || key === 'end' ? meetingDateRole : key === 'date' ? 'paper' : key === 'created' ? 'source_created' : key === 'modified' ? 'source_modified' : undefined});
   }
   if (kind === 'AgendaItem' && item.result !== undefined) {
    if (typeof item.result !== 'string') throw Error('Changed AgendaItem.result type');
    if (item.result.trim()) fields.push({path: `${path}/result`, raw: item.result, predicate: 'decision_result'});
   }
   if (kind === 'Paper' && item.originatorOrganization !== undefined) {
    if (!Array.isArray(item.originatorOrganization)) throw Error('Changed Paper.originatorOrganization type');
    for (const [i, raw] of item.originatorOrganization.entries()) {
     if (typeof raw !== 'string') throw Error('Changed Paper.originatorOrganization reference');
     if (raw.trim()) fields.push({path: `${path}/originatorOrganization/${i}`, raw, predicate: 'administrative_origin_organization'});
    }
   }
   if (Array.isArray(item.organization)) {
    for (const [i, raw] of item.organization.entries()) {
     if (typeof raw !== 'string') throw Error('Changed council organization reference');
     fields.push({path: `${path}/organization/${i}`, raw, predicate: 'meeting_organization'});
    }
   }
   result.records.push({id, kind, body: kind === 'Body' ? id : typeof item.body === 'string' ? item.body : null, version: typeof item.modified === 'string' ? item.modified : snapshot.sourceVersion, fields, deleted: item.deleted === true, path, format: 'json'});
   if (item.deleted === true) continue;
   for (const key of kind === 'System' ? ['body'] : kind === 'Body' ? ['meeting', 'paper', 'organization'] : ['meeting', 'downloadUrl']) {
    if (typeof item[key] === 'string') result.resources.push(resource(safeUrl(item[key], snapshot.url), id, 'json'));
   }
   const files = [{file: item.mainFile, path: `${path}/mainFile`}, {file: item.resolutionFile, path: `${path}/resolutionFile`}, ...(Array.isArray(item.auxiliaryFile) ? item.auxiliaryFile.map((file, i) => ({file, path: `${path}/auxiliaryFile/${i}`})) : [])];
   for (const {file, path: filePath} of files) {
    if (file && typeof file === 'object' && 'downloadUrl' in file && typeof file.downloadUrl === 'string') {
     result.resources.push(resource(safeUrl(file.downloadUrl, snapshot.url), id, 'document'));
     fields.push({path: `${filePath}/downloadUrl`, raw: file.downloadUrl, predicate: 'references_document'});
    }
   }
  }
 } else if (/html/i.test(snapshot.mimeType)) {
  const $ = load(text);
  if ($('input[type=password]').length || /\/ratsinfo\/logon/i.test(snapshot.url)) {result.blocked = 'Public snapshot contains a login gate'; return result;}
  result.recognized = /ALLRIS|SessionNet|Sitzungskalender|Sitzungsübersicht/i.test($('title,h1,h2').text());
  $('a[href]').each((i, element) => {
   const a = $(element), href = a.attr('href')!;
   let url: string; try {url = safeUrl(href, snapshot.url);} catch {return;}
   if (/login|logon|person|pe0\d|kp0\d|logout/i.test(url)) return;
   if ((a.attr('rel') ?? '').split(/\s+/).includes('next')) {if (result.next && result.next !== url) throw Error('Ambiguous council pagination'); result.next = url; return;}
   const pathname = new URL(url).pathname;
   const pdf = /\.pdf$/i.test(pathname) || /application\/pdf/i.test(a.attr('type') ?? '');
   const nativeDownload = /\/(?:getfile\.php|loadDocument\.(?:php|phtml)|download\.php)$/i.test(pathname);
   if (pdf || nativeDownload) {
    result.resources.push(resource(url, snapshot.url, pdf ? 'pdf' : 'document')); result.recognized = true; return;
   }
   const kind = nativeKind(url);
   if (!kind || new URL(url).origin !== new URL(snapshot.url).origin) return;
   result.recognized = true;
   result.resources.push(resource(url, snapshot.url, 'html'));
   const fields: Field[] = [{path: `a[href][${i}]/@href`, raw: href, predicate: 'native_resource'}, {path: `a[href][${i}]/text()`, raw: a.text(), predicate: 'link_label'}];
   const bodyLinks: {url: string; raw: string; path: string}[] = [];
   a.closest('tr').find('a[href]').each((_, bodyElement) => {
    const raw = $(bodyElement).attr('href')!;
    let bodyUrl: string; try {bodyUrl = safeUrl(raw, snapshot.url);} catch {return;}
    if (nativeKind(bodyUrl) === 'Body') bodyLinks.push({url: bodyUrl, raw, path: `a[href][${$('a[href]').index(bodyElement)}]/@href`});
   });
   const body = kind === 'Body' ? url : bodyLinks.length === 1 ? bodyLinks[0].url : null;
   if (kind !== 'Body' && bodyLinks.length === 1) fields.push({path: bodyLinks[0].path, raw: bodyLinks[0].raw, predicate: 'belongs_to_body'});
   result.records.push({id: url, kind, body, version: snapshot.sourceVersion, fields, deleted: false, path: `a[href][${i}]`, format: 'html'});
  });
  const kind = nativeKind(snapshot.url);
  if (kind) {
   const fields: Field[] = [];
   let body: string | null = kind === 'Body' ? snapshot.url : null;
   const labels: Record<string, [string, string?]> = {'Beschlussdatum': ['resolution_date', 'resolution'], 'Beschlussnummer': ['resolution_reference'], 'Sitzungsdatum': ['meeting_date', 'scheduled_meeting'], 'Vorlage': ['paper_reference']};
   if (kind === 'Meeting' || kind === 'Paper') labels.Datum = [kind === 'Meeting' ? 'meeting_date' : 'paper_date', kind === 'Meeting' ? 'scheduled_meeting' : 'paper'];
   if (kind === 'Paper' || kind === 'AgendaItem') {
    labels.Beschluss = ['decision_result'];
    labels.Ergebnis = ['decision_result'];
    labels.Fraktion = ['proposing_faction'];
    labels['Antragsteller (Fraktion)'] = ['proposing_faction'];
    labels['Antragsteller (Organisation)'] = ['proposing_organization'];
   }
   $('tr').each((i, element) => {
    const cells = $(element).children('th,td'); if (cells.length !== 2) return;
    const label = cells.eq(0).text().trim().replace(/:$/, ''), mapping = labels[label];
    if (label === 'Antragsteller' && (kind === 'Paper' || kind === 'AgendaItem')) {
     // Do not import a plain personal name under this ambiguous native label.
     // A faction is explicit only in the source value; an organization link supplies
     // organization semantics but never turns that organization into a faction.
     const raw = cells.eq(1).text();
     const links = cells.eq(1).find('a[href]');
     let organizationLink = false;
     if (links.length === 1) {
      const href = links.attr('href')!;
      try {organizationLink = nativeKind(safeUrl(href, snapshot.url)) === 'Body';} catch { /* Retain no ambiguous proposer. */ }
     }
     const explicitFaction = (links.length === 0 || organizationLink) && (/^Fraktion\s+\S/.test(raw.trim()) || /^\S+-Fraktion$/.test(raw.trim()));
     if (explicitFaction) fields.push({path: `tr[${i}]/td-or-th[1]/text()`, raw, predicate: 'proposing_faction'});
     else if (organizationLink && links.text().trim()) fields.push({path: `tr[${i}]/td-or-th[1]/a/text()`, raw: links.text(), predicate: 'proposing_organization'});
    }
    if (label === 'Gremium') {
     const links = cells.eq(1).find('a[href]');
     if (links.length === 1) {
      const raw = links.attr('href')!, url = safeUrl(raw, snapshot.url);
      if (nativeKind(url) === 'Body') {
       body = url;
       fields.push({path: `tr[${i}]/td-or-th[1]/a/@href`, raw, predicate: 'belongs_to_body'});
      }
     }
    }
    if (mapping) {
     const raw = cells.eq(1).text();
     const proposer = mapping[0] === 'proposing_faction' || mapping[0] === 'proposing_organization';
     const personLink = cells.eq(1).find('a[href]').toArray().some(element => /person|pe0\d|kp0\d/i.test($(element).attr('href') ?? ''));
     if (raw.trim() && (!proposer || !personLink)) fields.push({path: `tr[${i}]/td-or-th[1]/text()`, raw, predicate: mapping[0], dateRole: mapping[1]});
    }
   });
   result.records.push({id: snapshot.url, kind, body, version: snapshot.sourceVersion, fields, deleted: false, path: '/', format: 'html'});
   result.recognized = true;
  }
 } else throw Error('Unsupported council native MIME');
 if (result.records.length > maxRecords || result.resources.length > maxRecords) throw Error('Council record bound exceeded');
 if (result.next && new URL(result.next).origin !== new URL(snapshot.url).origin) throw Error('Cross-origin council pagination');
 return result;
}

export function createCouncilAdapter(options: CouncilAdapterOptions = {}): StructuredAdapter {
 const maxBytes = options.maxBytes ?? 2_000_000, maxRecords = options.maxRecords ?? 1_000;
 if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxRecords) || maxRecords < 0) throw Error('Council bounds must be nonnegative safe integers');
 const bindings = options.bodyBindings ?? [];
 for (const binding of bindings) {if (binding.ags !== null && !/^\d{8}$/.test(binding.ags)) throw Error('Body AGS must be eight digits'); StructuredLocatorSchema.parse(binding.evidence);}
 function prepare(snapshot: AdmittedSnapshot, scope: AdapterScope): Decoded {
  assertSnapshot(snapshot); ScopeSchema.parse(scope);
  const root = sourceRoots[scope.sourceId];
  if (!root) throw Error('Uncatalogued council source');
  const admittedUrl = new URL(safeUrl(snapshot.url, snapshot.url)), sourceRoot = new URL(root);
  if (admittedUrl.origin !== sourceRoot.origin || !admittedUrl.pathname.startsWith(sourceRoot.pathname)) throw Error('Council source/tenant URL binding mismatch');
  const blocked = blockedSources[scope.sourceId] ?? (scope.sourceId.startsWith('amt-ms-') ? 'Märkische Schweiz tenant held behind unresolved catalog-observed HTTP 403 root' : null);
  if (blocked) return {records: [], resources: [], next: null, recognized: false, blocked};
  if (snapshot.bytes.byteLength > maxBytes) throw Error('Council byte bound exceeded');
  const data = decode(snapshot, maxRecords);
  for (const record of data.records) {
   for (const value of [record.id, record.body].filter((value): value is string => value !== null)) {
    const url = new URL(safeUrl(value, snapshot.url));
    if (url.origin !== sourceRoot.origin || !url.pathname.startsWith(sourceRoot.pathname)) throw Error('Council native identity leaves source tenant');
   }
  }
  for (const ref of data.resources.filter(r => r.format === 'html' || r.format === 'json')) {
   const url = new URL(ref.url);
   if (url.origin !== sourceRoot.origin || !url.pathname.startsWith(sourceRoot.pathname)) throw Error('Council resource leaves source tenant');
  }
  if (data.next && !new URL(data.next).pathname.startsWith(sourceRoot.pathname)) throw Error('Council pagination leaves tenant');
  return data;
 }
 function coverage(snapshot: AdmittedSnapshot, scope: AdapterScope, data: Decoded, failed?: string): AdapterCoverage {
  return {state: data.blocked ? 'blocked_access' : failed || !data.recognized ? 'held_quality' : data.next ? 'partial' : data.records.length || data.resources.length ? 'partial' : 'empty', scope: `${scope.sourceId}:${scope.tenant ?? ''}:${scope.observationWindow}`, reason: data.blocked ?? failed ?? (data.next ? 'Native next page remains' : data.recognized ? 'Bounded native snapshot checked; archive completeness not asserted' : 'Council native schema not recognized'), checkedAt: snapshot.retrievedAt, nextCursor: data.next, observedRows: data.records.length, limitations};
 }
 const empty: Decoded = {records: [], resources: [], next: null, recognized: false, blocked: null};
 return {
  id: 'council', version: COUNCIL_MAPPING_VERSION,
  discover(snapshot, scope, cursor) {
   if (cursor !== null && cursor !== snapshot.url) throw Error('Cursor must bind the admitted page URL');
   assertSnapshot(snapshot); ScopeSchema.parse(scope);
   try {
    const data = prepare(snapshot, scope);
    const resources = [...new Map(data.resources.map(r => [r.url, r])).values()].sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
    if (data.next) resources.push(resource(data.next, snapshot.url, /json/i.test(snapshot.mimeType) ? 'json' : 'html'));
    return {resources, coverage: coverage(snapshot, scope, data)};
   } catch (error) {return {resources: [], coverage: coverage(snapshot, scope, empty, String(error))};}
  },
  parse(snapshot, scope) {
   assertSnapshot(snapshot); ScopeSchema.parse(scope);
   try {
    const data = prepare(snapshot, scope), observations: StructuredObservation[] = [];
    for (const record of data.records) {
     const matches = bindings.filter(b => b.sourceId === scope.sourceId && b.tenant === scope.tenant && (b.bodyId === record.body || b.bodyId === record.id));
     if (matches.length > 1) throw Error('Conflicting council body bindings');
     const binding = matches[0];
     const fields: Field[] = record.deleted ? [{path: `${record.path}/deleted`, raw: true, predicate: 'withdrawn'}] : record.fields;
     for (const field of fields) {
      const date = field.dateRole && typeof field.raw === 'string' ? dateValue(field.raw.trim()) : null;
      const evidence: StructuredLocator = {sourceSha256: snapshot.sourceSha256, format: record.format, nativeId: record.id, path: field.path, sheet: null, rowKey: record.id, cells: [], rawValue: field.raw, schemaHash, mappingVersion: COUNCIL_MAPPING_VERSION};
      observations.push(observation({publisherId: scope.publisherId, sourceId: scope.sourceId, nativeId: record.id, nativeVersion: record.version, kind: record.kind, subject: `${scope.publisherId}:${scope.sourceId}:${scope.tenant ?? ''}:${record.id}`, predicate: field.predicate, value: date ?? field.raw, unit: null, date, dateRole: field.dateRole ?? null, financialRole: 'none', geography: {ags: binding?.ags ?? null, basis: binding?.ags ? 'verified_join' : 'unknown', role: 'administrative_area'}, sourceReferenceDate: date, publishedAt: null, retrievedAt: snapshot.retrievedAt, evidence: [evidence], supportingEvidence: binding ? [{role: 'municipality_join', locator: binding.evidence}] : [], limitations: [...limitations, ...(binding ? [] : ['Body/tenant municipality join unresolved; requested scope AGS is not assigned to council records.'])]}));
     }
    }
    const unique = [...new Map(observations.map(o => [o.id, o])).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return {observations: unique, coverage: coverage(snapshot, scope, data)};
   } catch (error) {return {observations: [], coverage: coverage(snapshot, scope, empty, String(error))};}
  },
 };
}
export const councilAdapter = createCouncilAdapter();
export function councilCapabilityReceipt() {
 return {adapterId: 'council', version: COUNCIL_MAPPING_VERSION, schemaHash, sourceIds: Object.keys(sourceRoots).sort(), nativeFormats: ['OParl 1.0/1.1 where admitted and observed', 'ALLRIS public HTML', 'SessionNet public HTML'], peopleImport: false, network: false, collection: 'not_run', rights: 'held_until_distribution_admission', blockedSources, limitations};
}
