import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'cheerio';
import { z } from 'zod';
import { MAX_DOCUMENT_BYTES, runDocumentCommand, type DocumentCommand } from './district-document.ts';

export const DOCUMENT_ORIGIN_CLASSIFIER_VERSION = 'document-origin-rules-v1';
const MAX_PAGE_TEXT = 32 * 1024;
const MAX_METADATA = 64 * 1024;
const MAX_CONTEXT = 4096;
const MAX_HTML = 128 * 1024;

export const DocumentOriginSchema = z.object({
  classification: z.enum(['official_work', 'third_party', 'mixed', 'unknown']),
  method: z.literal('rules'),
  classifierVersion: z.string().min(1).max(80),
  url: z.url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  classifiedAt: z.iso.datetime(),
  evidence: z.array(z.object({ locator: z.string().min(1).max(100), value: z.string().min(1).max(160) }).strict()).max(64),
}).strict();
export type DocumentOriginClassification = z.infer<typeof DocumentOriginSchema>;
export interface DocumentOriginInput {
  url: string;
  mimeType: string;
  bytes: Uint8Array;
  title?: string;
  linkText?: string;
  municipalityName?: string;
  /** Factual issuer/authorship context supplied by the source adapter, never an official-host assertion. */
  administrativeOriginEvidence?: string | string[];
}

type Observation = { locator: string; text: string };
class InspectionFailure extends Error {}
const normalize = (text: string) => text.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
const formalWork = /\b(?:beschlussvorlage|verwaltungsvorlage|sitzungsvorlage|ratsvorlage|beschluss|satzung|verordnung|niederschrift|sitzungsprotokoll|amtliche\s+bekanntmachung|administrative\s+submission|ordinance)\b/iu;
const administrativeNavigation = /\b(?:ratsinformationssystem|b[üu]rgerinformationssystem|sitzungskalender|sitzungstermine|sitzungs[üu]bersicht|gremien[üu]bersicht|tagesordnung|council\s+(?:calendar|agenda))\b/iu;
const oparlContainerType = /^https?:\/\/schema\.oparl\.org\/1\.[01]\/(?:System|Body|Meeting|AgendaItem|Paper|Organization|LegislativeTerm)$/;
const thirdPartyRules: readonly [string, RegExp][] = [
  ['consultant_or_study_material', /\b(?:gutachten|fachgutachten|studie|studien|machbarkeitsstudie|verkehrsuntersuchung|schalltechnische\s+untersuchung|umweltbericht|consultant|consultancy|feasibility\s+study)\b/iu],
  ['press_or_photographic_material', /\b(?:presseartikel|pressebericht|pressemitteilung|zeitungsartikel|zeitungsbericht|pressefoto|fotografie|photograph|photo\s+credit|bildnachweis|fotonachweis)\b|\bfoto\s*:/iu],
  ['copyright_notice', /©|\(c\)|\bcopyright\b|\balle\s+rechte\s+vorbehalten\b|\ball\s+rights\s+reserved\b/iu],
  ['external_author_or_cartography', /\b(?:verfasser|autor(?:in)?|author|erstellt\s+(?:von|durch)|bearbeitung|planung|kartografie|kartographie|kartengrundlage|geodaten|kartenmaterial|kartenhersteller)\s*:\s*[^\n]{0,140}\b(?:gmbh|ag|kg|gbr|inc|ltd|planungsb[üu]ro|ingenieurb[üu]ro|consult|openstreetmap|google|esri)\b/iu],
  ['consultancy_authorship', /\b(?:planungsb[üu]ro|ingenieurb[üu]ro|architekturb[üu]ro|unternehmensberatung)\b/iu],
  ['vendor_cartography', /\b(?:google\s+maps|openstreetmap)\b|\b(?:karte|karten|stadtplan|maps?|kartengrundlage)\b[^\n]{0,100}\b(?:esri|here|tomtom|mapbox)\b/iu],
];
const company = /\b(?:gmbh|gbr|ohg|kg|ag|inc|ltd|llc|consulting|consultants?|planungsb[üu]ro|ingenieurb[üu]ro|architekturb[üu]ro|verlag|corporation|company)\b/iu;
const institution = /^(?:stadt|(?:landes?haupt|kreis)stadt|gemeinde|landkreis|stadtverwaltung|gemeindeverwaltung|kreisverwaltung|bezirksamt|landratsamt|senatsverwaltung|ministerium)\s+[\p{L}][\p{L}\p{N} .()\/-]{1,100}$/iu;
const administrativeOffice = /^(?:stadtverwaltung|gemeindeverwaltung|kreisverwaltung|bezirksamt|landratsamt|senatsverwaltung|ministerium)\s+[\p{L}][\p{L}\p{N} .()\/-]{1,100}$/iu;

function administrativeOrigin(text: string, metadata = false): boolean {
  if (metadata && institution.test(text) && !company.test(text)) return true;
  // A place name, website footer, commissioner, or mention of a council is not authorship.
  return text.split('\n').some(line => {
    const value = line.trim();
    if (company.test(value)) return false;
    if (administrativeOffice.test(value)) return true;
    const attributed = /^(?:herausgeber(?:in)?|verfasser(?:in)?|autor(?:in)?|author|federf[üu]hrung|einreicher(?:in)?|erstellt\s+(?:von|durch))\s*:\s*(.+)$/iu.exec(value);
    if (attributed && institution.test(attributed[1])) return true;
    return /^(?:der|die)\s+(?:oberb[üu]rgermeister(?:in)?|b[üu]rgermeister(?:in)?|landr[äa]t(?:in)?)\s+(?:der\s+)?(?:stadt|gemeinde|des\s+landkreises)\s+[\p{L}][\p{L} .-]{1,100}$/iu.test(value);
  });
}

async function inspectPdf(bytes: Uint8Array, command: DocumentCommand): Promise<{ text: string; author: string; producer: string; title: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'stadtstack-origin-'));
  try {
    const path = join(directory, 'source.pdf');
    await writeFile(path, bytes, { mode: 0o600 });
    const info = await command('pdfinfo', ['-enc', 'UTF-8', path]);
    if (Buffer.byteLength(info) > MAX_METADATA) throw new InspectionFailure('metadata_size_limit');
    const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1]);
    if (!Number.isInteger(pages) || pages < 1) throw new InspectionFailure('page_count_unavailable');
    if (pages > 80) throw new InspectionFailure('page_count_limit');
    if (/^Encrypted:\s+yes\b/im.test(info)) throw new InspectionFailure('encrypted_pdf');
    const text = await command('pdftotext', ['-f', '1', '-l', '1', '-enc', 'UTF-8', path, '-']);
    if (Buffer.byteLength(text) > MAX_PAGE_TEXT) throw new InspectionFailure('first_page_size_limit');
    const field = (name: string) => normalize(new RegExp(`^${name}:[ \\t]*([^\\r\\n]*)`, 'm').exec(info)?.[1] ?? '');
    const author = field('Author'), producer = field('Producer'), title = field('Title');
    if ([author, producer, title].some(value => value.length > MAX_CONTEXT)) throw new InspectionFailure('metadata_field_limit');
    return { text: normalize(text.replace(/\f/g, '\n')), author, producer, title };
  } finally {
    // Only our private, ephemeral inspection directory; never a fetch/CAS cache.
    await rm(directory, { recursive: true, force: true });
  }
}

/** Local, bounded origin triage. This is operational classification, not legal certification. */
export async function classifyDocumentOrigin(input: DocumentOriginInput, command: DocumentCommand = runDocumentCommand): Promise<DocumentOriginClassification> {
  const evidence: DocumentOriginClassification['evidence'] = [];
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const finish = (classification: DocumentOriginClassification['classification']): DocumentOriginClassification => DocumentOriginSchema.parse({
    classification, method: 'rules', classifierVersion: DOCUMENT_ORIGIN_CLASSIFIER_VERSION,
    url: input.url, sha256, classifiedAt: new Date().toISOString(), evidence,
  });
  const observe = (locator: string, value: string) => {
    if (!evidence.some(item => item.locator === locator && item.value === value)) evidence.push({ locator, value });
  };
  const unknown = (reason: string) => { observe('inspection', reason); return finish('unknown'); };
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_DOCUMENT_BYTES) return unknown('source_size_limit');
  const admin = typeof input.administrativeOriginEvidence === 'string' ? [input.administrativeOriginEvidence] : input.administrativeOriginEvidence ?? [];
  if (admin.length > 8 || [input.title, input.linkText, input.municipalityName, ...admin].some(value => value !== undefined && value.length > MAX_CONTEXT)) return unknown('context_size_limit');
  const observations: Observation[] = [];
  if (input.title) observations.push({ locator: 'title', text: normalize(input.title) });
  if (input.linkText) observations.push({ locator: 'link_text', text: normalize(input.linkText) });
  let author = '', producer = '', text: string, containerRole = false, containerOrigin = false;
  try {
    const mime = input.mimeType.split(';', 1)[0].trim().toLowerCase();
    if (mime === 'application/pdf') {
      const pdf = await inspectPdf(input.bytes, command);
      text = pdf.text; author = pdf.author; producer = pdf.producer;
      if (pdf.title) observations.push({ locator: 'pdf.title', text: pdf.title });
      observations.push({ locator: 'pdf.page.1', text });
    } else if (mime === 'text/html' || mime === 'application/xhtml+xml') {
      if (input.bytes.byteLength > MAX_HTML) return unknown('html_size_limit');
      const html = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
      const $ = load(html);
      const title = $('title').first().text();
      if (title.length > MAX_CONTEXT) return unknown('context_size_limit');
      if (title) observations.push({ locator: 'html.title', text: normalize(title) });
      // Publisher metadata is explicit attribution, unlike a footer or a municipal hostname.
      const publishers = $('meta[name="publisher"],meta[name="author"]').toArray();
      if (publishers.length > 8) return unknown('context_size_limit');
      for (const node of publishers) {
        const publisher = normalize($(node).attr('content') ?? '');
        if (publisher.length > MAX_CONTEXT) return unknown('context_size_limit');
        if (institution.test(publisher) && !company.test(publisher)) {
          containerOrigin = true; observe('html.publisher', 'administrative_institution');
        } else if (company.test(publisher)) observations.push({ locator: 'html.publisher', text: `Author: ${publisher}` });
      }
      $('script,style,noscript,svg,nav,footer,header,aside').remove();
      const main = $('main,article,[role="main"]').first();
      const body = main.length ? main : $('body');
      body.find('br,p,div,section,h1,h2,h3,tr,li').each((_, node) => { $(node).prepend('\n'); });
      text = normalize(body.text());
      observations.push({ locator: 'html.content', text });
      containerRole = observations.some(item => administrativeNavigation.test(item.text));
      for (const observation of observations) {
        if (observation.locator !== 'html.title' && observation.locator !== 'html.content') continue;
        const namedService = /(?:ratsinformationssystem|b[üu]rgerinformationssystem|sitzungskalender|sitzungs[üu]bersicht)\s+(?:der|des|f[üu]r\s+die)\s+([^\n]{1,120})/iu.exec(observation.text);
        if (namedService && institution.test(namedService[1].trim()) && !company.test(namedService[1])) {
          containerOrigin = true; observe(observation.locator, 'named_municipal_administrative_service');
        }
      }
    } else if (mime === 'application/json' || mime === 'application/ld+json') {
      if (input.bytes.byteLength > MAX_PAGE_TEXT) return unknown('json_size_limit');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
      const parsed: unknown = JSON.parse(source);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unknown('unsupported_json_structure');
      const root = parsed as Record<string, unknown>;
      const records = Array.isArray(root.data) ? root.data : [root];
      if (!records.length || records.length > 100 || !records.every(record =>
        record && typeof record === 'object' && !Array.isArray(record) &&
        typeof record.type === 'string' && oparlContainerType.test(record.type) &&
        typeof record.id === 'string' && /^https?:\/\//.test(record.id)
      )) return unknown('unsupported_json_structure');
      containerRole = true;
      // A typed municipal Body (or an explicitly named publisher) is positive origin;
      // a System/Meeting type or body URL by itself is not. File objects are never containers.
      let identifiedPublishers = 0;
      for (const record of records as Record<string, unknown>[]) {
        const issuer = /\/Body$/.test(record.type as string) ? record.name : record.publisher;
        if (typeof issuer === 'string' && institution.test(normalize(issuer)) && !company.test(issuer)) {
          observe('oparl.publisher', 'administrative_institution');
          identifiedPublishers++;
        }
        if (typeof issuer === 'string' && company.test(issuer)) observations.push({ locator: 'oparl.publisher', text: `Author: ${issuer}` });
      }
      containerOrigin = identifiedPublishers === records.length;
      const strings: string[] = [];
      let nodes = 0;
      const inspect = (value: unknown, depth: number): void => {
        if (++nodes > 2048 || depth > 16) throw new InspectionFailure('json_structure_limit');
        if (typeof value === 'string') strings.push(normalize(value));
        else if (value && typeof value === 'object') for (const child of Object.values(value)) inspect(child, depth + 1);
      };
      inspect(parsed, 0);
      text = strings.join('\n');
      observations.push({ locator: 'oparl.content', text });
    } else if (mime === 'text/plain') {
      // A form-feed delimits the first page; otherwise the entire bounded text is inspected.
      const boundary = input.bytes.indexOf(12);
      const page = boundary < 0 ? input.bytes : input.bytes.subarray(0, boundary);
      if (page.byteLength > MAX_PAGE_TEXT) return unknown('first_page_size_limit');
      text = normalize(new TextDecoder('utf-8', { fatal: true }).decode(page));
      observations.push({ locator: 'text.page.1', text });
    } else return unknown('unsupported_mime_type');
  } catch (error) {
    // No parser diagnostics, document text, paths, personal metadata or subprocess errors are exported.
    return unknown(error instanceof InspectionFailure ? error.message : 'parse_or_tool_failure');
  }
  if (Buffer.byteLength(text) > MAX_PAGE_TEXT) return unknown('first_page_size_limit');
  if ((text.match(/[\p{L}\p{N}]/gu) ?? []).length < 40) return unknown('first_page_insufficient_text');

  let formal = false, officialOrigin = false, thirdParty = false, unresolvedAuthor = false;
  if (containerRole) observe('document_role', 'administrative_navigation_container');
  for (const { locator, text: value } of observations) {
    if (formalWork.test(value)) { formal = true; observe(locator, 'formal_act_or_administrative_submission'); }
    if (['title', 'link_text', 'pdf.title', 'html.title'].includes(locator) && company.test(value)) {
      thirdParty = true; observe(locator, 'external_company_title');
    }
    // Titles/link labels describe document kind, but alone do not establish its issuer.
    if (!['title', 'link_text', 'pdf.title', 'html.title', 'oparl.content'].includes(locator) && administrativeOrigin(value)) {
      officialOrigin = true; observe(locator, 'explicit_administrative_origin');
    }
    for (const [signal, pattern] of thirdPartyRules) {
      if (pattern.test(value)) { thirdParty = true; observe(locator, signal); }
    }
  }
  for (const value of admin) {
    if (administrativeOrigin(normalize(value), true)) { officialOrigin = true; observe('administrative_origin_evidence', 'explicit_administrative_origin'); }
    for (const [signal, pattern] of thirdPartyRules) {
      if (pattern.test(value)) { thirdParty = true; observe('administrative_origin_evidence', signal); }
    }
  }
  if (author) {
    if (administrativeOrigin(author, true)) { officialOrigin = true; observe('pdf.author', 'administrative_institution'); }
    else if (company.test(author) || thirdPartyRules.some(([, pattern]) => pattern.test(author))) {
      thirdParty = true; observe('pdf.author', 'external_author_indicator');
    } else { unresolvedAuthor = true; observe('pdf.author', 'unresolved_author_identity'); }
  }
  // Producer is an application/vendor field, NOT evidence of document authorship.
  if (producer) observe('pdf.producer', 'producer_present_not_authorship');
  const official = formal && officialOrigin || containerRole && (officialOrigin || containerOrigin);
  if (thirdParty) return finish(official ? 'mixed' : 'third_party');
  if (official && !unresolvedAuthor) return finish('official_work');
  return unknown(unresolvedAuthor ? 'author_origin_unresolved' : 'insufficient_positive_origin_evidence');
}
