import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load } from 'cheerio';
import proj4 from 'proj4';
import { TOPICS, tokens, titleClusters } from './taxonomy.mjs';
import { collectDiPlan } from './diplan.mjs';
import { collectCouncil } from './council.mjs';
import { checkWriezenCalendar } from './calendar.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, '../out/regions/brandenburg-mol/topics.json');
const cacheDir = join(root, '.cache');
const UA = 'StadtstackResearch/1.0 (regional source-index research; polite read-only requests)';
const DISTRICT = 'https://service.brandenburg.de/service/de/adressen/kommunalverzeichnis/ansicht/~12064-maerkisch-oderland';
const CSV = 'https://service.brandenburg.de/service/de/adressen/kommunalverzeichnis/kvdaten.csv';
const asOf = process.env.REGIONAL_AS_OF || new Date().toISOString().slice(0, 10);
const cutoff = new Date(`${asOf}T12:00:00Z`);
cutoff.setUTCMonth(cutoff.getUTCMonth() - 18);
const cutoffDate = cutoff.toISOString().slice(0, 10);
const offline = process.argv.includes('--offline');
const warnings = [];
const lastHost = new Map();
const robotsCache = new Map();
const hostDelays = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const slug = value => value.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function cachedFetch(url, { maxAge = 24 * 3600_000, robots = true, method = 'GET', requestBody = null } = {}) {
  const file = join(cacheDir, createHash('sha256').update(`${method} ${url}\n${requestBody || ''}`).digest('hex') + '.txt');
  let previous;
  try { previous = await readFile(file, 'utf8'); } catch { /* no cache */ }
  if (offline) {
    if (previous === undefined) throw Error(`No offline snapshot: ${url}`);
    return previous;
  }
  if (previous !== undefined && Date.now() - (await stat(file)).mtimeMs < maxAge) return previous;
  try {
    if (robots) await checkRobots(url);
    const host = new URL(url).host;
    const pause = Math.max(0, (lastHost.get(host) || 0) + (hostDelays.get(host) || 850) - Date.now());
    if (pause) await sleep(pause);
    lastHost.set(host, Date.now());
    const response = await fetch(url, { method, body: requestBody, headers: { 'User-Agent': UA, Accept: 'application/json,text/html,text/csv,text/plain;q=0.8', ...(requestBody && { 'Content-Type': 'application/x-www-form-urlencoded' }) }, signal: AbortSignal.timeout(18000) });
    if (!response.ok && !(url.endsWith('/robots.txt') && response.status === 404)) throw Error(`HTTP ${response.status}`);
    const body = response.status === 404 ? '' : await response.text();
    if (!url.endsWith('/robots.txt') && (!body || body.length > 8_000_000)) throw Error('Empty or too large response');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, body);
    return body;
  } catch (error) {
    if (previous === undefined) throw Error(`${url}: ${error.message}`);
    warnings.push(`Last-good cache used for ${url}: ${error.message}`);
    return previous;
  }
}

async function checkRobots(url) {
  const origin = new URL(url).origin;
  if (!robotsCache.has(origin)) {
    const content = await cachedFetch(`${origin}/robots.txt`, { maxAge: 7 * 24 * 3600_000, robots: false }).catch(error => {
      warnings.push(`${origin}/robots.txt unavailable (${error.message}); skip this origin`);
      return null;
    });
    robotsCache.set(origin, content);
  }
  const text = robotsCache.get(origin);
  if (text === null) throw Error('No robots policy available');
  const requestedDelay = Math.max(0, ...[...text.matchAll(/^crawl-delay:\s*(\d+(?:\.\d+)?)/gim)].map(match => Number(match[1]) * 1000));
  if (requestedDelay) hostDelays.set(new URL(url).host, requestedDelay);
  let active = false, bestLength = 0, blocked = false;
  const path = new URL(url).pathname;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.split('#')[0].trim();
    const match = /^(user-agent|disallow|allow):\s*(.*)$/i.exec(clean);
    if (!match) continue;
    const directive = match[1].toLowerCase();
    if (directive === 'user-agent') active = match[2] === '*';
    if (active && match[2] && (directive === 'allow' || directive === 'disallow') && path.startsWith(match[2]) && match[2].length >= bestLength) {
      bestLength = match[2].length;
      blocked = directive === 'disallow';
    }
  }
  if (blocked) throw Error(`robots disallow ${path}`);
}

function parseCsv(text) {
  // Official semicolon CSV has quoted fields; no third-party CSV data released.
  const rows = text.replace(/^\uFEFF+/, '').trim().split(/\r?\n/).map(line => [...line.matchAll(/"((?:[^"]|"")*)"(?=;|$)/g)].map(match => match[1].replace(/""/g, '"')));
  const headers = rows.shift();
  if (!headers?.includes('regionalschluessel') || !headers.includes('utm_nordwert')) throw Error('Unexpected official CSV headers');
  return rows.map(columns => Object.fromEntries(headers.map((header, index) => [header, columns[index]])));
}

async function municipalityRegistry() {
  const csv = await cachedFetch(CSV);
  const page = await cachedFetch(DISTRICT);
  const $ = load(page);
  const list = $('h2').filter((_, el) => $(el).text().includes('zugeordnet')).first().next('ul');
  const names = new Map();
  const parents = new Map();
  const offices = [];
  for (const li of list.children('li').toArray()) {
    const anchor = $(li).children('a');
    const code = /~(12064\d{3,7})-/.exec(anchor.attr('href') || '')?.[1];
    if (!code) continue;
    names.set(code, anchor.text().replace(/^(?:amtsangehörige Gemeinde|amtsfreie Gemeinde|Gemeinde|Stadt|Amt)\s+/u, '').trim());
    if (anchor.text().trim().startsWith('Amt ')) {
      offices.push({ id: slug(names.get(code)), name: names.get(code), regionKey: code });
      for (const sub of $(li).children('ul').children('li').toArray()) {
        const child = $(sub).children('a');
        const childCode = /~(12064\d{7})-/.exec(child.attr('href') || '')?.[1];
        if (childCode) { names.set(childCode, child.text().replace(/^(?:amtsangehörige Gemeinde|Stadt)\s+/u, '').trim()); parents.set(childCode, code); }
      }
    }
  }
  const csvRows = parseCsv(csv).filter(row => /^12064\d{7}$/.test(row.regionalschluessel) && /Gemeinde/.test(row.organisationsart));
  if (names.size !== csvRows.length + offices.length || csvRows.length !== 45 || offices.length !== 6) throw Error(`Official district and CSV do not agree: ${names.size} names, ${csvRows.length} municipalities, ${offices.length} Ämter`);
  const utm33 = '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs';
  const municipalities = csvRows.map(row => {
    const name = row.bezeichnung;
    if (!names.has(row.regionalschluessel)) throw Error(`Missing municipality in district hierarchy: ${name}`);
    const easting = Number(row.utm_ostwert), northing = Number(row.utm_nordwert);
    if (!(easting > 350000 && easting < 550000 && northing > 5700000 && northing < 5950000)) throw Error(`Unexpected municipal UTM coordinates: ${name}`);
    const [lon, lat] = proj4(utm33, 'WGS84', [easting, northing]);
    const office = offices.find(item => item.regionKey === parents.get(row.regionalschluessel));
    return { id: slug(name), name, ags: row.regionalschluessel.slice(0, 5) + row.regionalschluessel.slice(-3), center: [Number(lon.toFixed(5)), Number(lat.toFixed(5))], centerPrecision: 'administrative_address_approximate', ...(office && { amtId: office.id }) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { municipalities, offices };
}

function buildTopic(category, items, method = 'keyword') {
  const municipal = Map.groupBy(items, item => item.municipalityId);
  const group = [...municipal].map(([municipalityId, entries]) => {
    const deduped = [...new Map(entries.map(item => [item.url, item])).values()];
    const ranked = ['adopted', 'decision_recorded', 'evaluation', 'decision_pending', 'consultation_closed', 'consultation', 'draft', 'planning', 'referred', 'agenda', 'unknown'];
    const stage = deduped.map(item => item.stage).sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b))[0];
    return { municipalityId, stage, items: deduped.map(({ title, url, date, sourceType, locator, stage: itemStage, participationEnd }) => ({ title, url, date, sourceType, locator, stage: itemStage, ...(participationEnd ? { participationEnd } : {}) })).sort((a, b) => (b.date || '').localeCompare(a.date || '')) };
  }).sort((a, b) => a.municipalityId.localeCompare(b.municipalityId));
  const dates = items.map(item => item.date).filter(Boolean).sort();
  return { id: category.id, label: category.label, summary: category.summary, categoryKeywords: category.keywords, municipalities: group, firstSeen: dates[0] || null, lastSeen: dates.at(-1) || null, method, reviewState: 'candidate' };
}

async function cityEvidence(known) {
  const entries = JSON.parse(await readFile(join(root, 'city-evidence.json'), 'utf8'));
  const pages = new Map();
  const items = [];
  for (const entry of entries) {
    if (!known.has(entry.municipality)) throw Error(`Unknown city evidence municipality: ${entry.municipality}`);
    if (!pages.has(entry.url)) pages.set(entry.url, cachedFetch(entry.url));
    try {
      const html = await pages.get(entry.url);
      const text = load(html)('body').text().replace(/\s+/g, ' ');
      if (!text.includes(entry.evidence)) throw Error('Locator phrase missing or page changed');
      items.push({ municipalityId: entry.municipality, title: entry.title, url: entry.url, date: entry.date, sourceType: entry.sourceType || 'cityWebsite', locator: entry.locator, stage: entry.stage, category: entry.category });
    } catch (error) { warnings.push(`Not publishing ${entry.url} (${entry.municipality}): ${error.message}`); }
  }
  return { items, pages: pages.size };
}

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw Error('REGIONAL_AS_OF must be YYYY-MM-DD');
  const { municipalities, offices } = await municipalityRegistry();
  const known = new Map(municipalities.map(municipality => [municipality.id, municipality]));
  const [diPlan, city, council, calendar] = await Promise.all([collectDiPlan({ fetchSource: cachedFetch, cutoffDate, asOf, known, slug, warnings }), cityEvidence(known), collectCouncil({ fetchSource: cachedFetch, warnings }), checkWriezenCalendar({ fetchSource: cachedFetch, cutoffDate, warnings })]);
  const records = [...diPlan.items, ...city.items, ...council.items];
  const categorized = new Map(TOPICS.map(topic => [topic.id, []]));
  const unclassified = [];
  for (const item of records) {
    const matched = item.category ? TOPICS.filter(topic => topic.id === item.category) : TOPICS.filter(topic => topic.pattern.test(item.title));
    if (!matched.length) unclassified.push(item);
    for (const topic of matched) categorized.get(topic.id).push(item);
  }
  const topics = TOPICS.flatMap(topic => new Set(categorized.get(topic.id).map(item => item.municipalityId)).size > 1 ? [buildTopic(topic, categorized.get(topic.id))] : []);
  for (const group of titleClusters(unclassified)) {
    const sharedTokens = group.map(item => tokens(item.title)).reduce((common, words) => common.filter(word => words.includes(word)));
    const key = sharedTokens.find(word => word.length >= 6);
    if (!key) continue;
    topics.push(buildTopic({ id: `cluster-${slug(key)}`, label: `Ähnliche Planungen: ${key}`, keywords: [key], summary: `Mehrere Gemeinden haben Verfahren mit dem gemeinsamen Titelbegriff „${key}“; inhaltliche Gleichheit ist noch nicht redaktionell geprüft.` }, group, 'cluster'));
  }
  topics.sort((a, b) => b.municipalities.length - a.municipalities.length || a.label.localeCompare(b.label, 'de'));
  const dataset = {
    schemaVersion: 'stadtstack-regional-topics-v1',
    generatedAt: new Date().toISOString(), asOf, region: { id: 'brandenburg-mol', name: 'Landkreis Märkisch-Oderland', state: 'Brandenburg', ags: '12064', sourceUrl: DISTRICT, municipalityCount: municipalities.length, centreMeaning: 'Approximate administrative address, not municipal polygon centroid' },
    sources: [ { id: 'brandenburg-kommunalverzeichnis', type: 'officialRegistry', url: CSV, licence: 'dl-de/by-2-0', licenceUrl: 'https://www.govdata.de/dl-de/by-2-0', attribution: 'Service Brandenburg, Kommunalverzeichnis', changes: 'Filtered to MOL; regional keys converted to AGS; administrative UTM addresses converted to approximate WGS84 coordinates', retrievedAt: asOf }, ...diPlan.sources, ...council.sources, calendar.source, { id: 'curated-official-pages', type: 'cityWebsite', url: null, licence: 'unknown', reuse: 'facts_with_attribution', checkedPages: city.pages } ],
    coverage: { since: cutoffDate, diPlan: diPlan.coverage, council: council.coverage, wriezenCalendar: calendar.coverage, curatedOfficialItems: city.items.length, cityWebsiteItems: city.items.filter(item => item.sourceType === 'cityWebsite').length, municipalityWithItems: new Set(records.map(item => item.municipalityId)).size, warnings },
    offices, municipalities, cityRegions: Object.fromEntries(municipalities.map(city => [city.id, 'brandenburg-mol'])), topics
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(dataset, null, 2) + '\n');
  console.log(JSON.stringify({ output, municipalities: municipalities.length, offices: offices.length, diPlan: diPlan.coverage, council: council.coverage, calendar: calendar.coverage, cityItems: city.items.length, topics: topics.map(topic => [topic.id, topic.municipalities.length]), warnings }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
