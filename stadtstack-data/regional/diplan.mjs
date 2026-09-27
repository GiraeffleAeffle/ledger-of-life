import { load } from 'cheerio';

const API = 'https://bb.beteiligung.diplanung.de/list/json';
const ORIGIN = 'https://bb.beteiligung.diplanung.de';
// Captured from the real public procedure-list browser request. Blank phase
// permission set requests all listed procedures, not only open consultations.
const FORM = new URLSearchParams({ orgaSlug: '', search: '', sort: 'publicParticipationEndDate', municipalCode: '', publicParticipationPhasePermissionset: '', publicParticipationPhaseDefinitionId: '', orgaName: '' }).toString();
const germanDate = value => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(value || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const simplify = value => (value || '').toLocaleLowerCase('de').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const includesName = (haystack, needle) => (` ${simplify(haystack)} `).includes(` ${simplify(needle)} `);

function identifyCity(title, locality, organization, known) {
  // Falkenberg/Elster belongs to Elbe-Elster, not MOL's Falkenberg/Mark.
  if (/Falkenberg\s*\/\s*Elster/iu.test(title)) return null;
  const municipality = [...known.values()];
  const exact = municipality.filter(city => includesName(title, city.name));
  // A titled municipality outranks a mislabeled map place, e.g. Hoppegarten's
  // Schulcampus card renders Neuenhagen as the location.
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    // Windpark Podelzig–Lebus has two municipal procedures, each headed
    // "hier Stadt Lebus" or "hier Gemeinde Podelzig".
    const jurisdiction = exact.filter(city => new RegExp(`\\bhier (?:Stadt|Gemeinde) ${city.name}\\b`, 'iu').test(title));
    return jurisdiction.length === 1 ? jurisdiction[0] : null;
  }
  const place = municipality.filter(city => simplify(locality) === simplify(city.name));
  if (place.length !== 1) return null; // Ortsteile require separate confirmation.
  const candidate = place[0];
  const org = simplify(organization);
  if (!org || org.startsWith('amt ') || org.includes('gemeinde falkenhagen') && candidate.id !== 'falkenhagen-mark') return null;
  const stem = candidate.name.replace(/ (?:bei Berlin|\(Oder\)|\(Märkische Schweiz\))$/u, '');
  if (!includesName(organization, candidate.name) && !includesName(organization, stem)) return null;
  return candidate;
}

function stageFromPhase(phase, start, end, asOf) {
  if (/auswertung|abw[äa]gung/i.test(phase)) return 'evaluation';
  if (/beschlussfassung/i.test(phase)) return 'decision_pending';
  if (/entwurf/i.test(phase) && !/beteiligung/i.test(phase)) return 'draft';
  if (start && start <= asOf && end && end >= asOf && /beteiligung|auslegung/i.test(phase)) return 'consultation';
  if (end && end < asOf && /beteiligung|auslegung/i.test(phase)) return 'consultation_closed';
  return 'planning';
}

export async function collectDiPlan({ fetchSource, cutoffDate, asOf, known, warnings }) {
  const data = JSON.parse(await fetchSource(API, { method: 'POST', requestBody: FORM }));
  if (data.success !== true || !Array.isArray(data.mapVars) || typeof data.responseHtml !== 'string' || data.mapVars.length !== data.procedureCount) throw Error('Unexpected DiPlan statewide list response');
  const $ = load(data.responseHtml);
  const list = new Map();
  $('.c-procedurelist__item[data-procedure-id]').each((_, el) => {
    const row = $(el), id = row.attr('data-procedure-id');
    const label = row.find('.c-procedurelist__trans').first().text().replace(/\s+/g, ' ').trim();
    const contents = row.find('.c-procedurelist__item-text');
    list.set(id, { locality: label, organization: contents.last().text().replace(/\s+/g, ' ').trim() });
  });
  const items = [], matched = new Set();
  let inWindow = 0, ambiguous = 0, pointCoordinates = 0;
  for (const procedure of data.mapVars) {
    const start = germanDate(procedure.publicParticipationStartDate), end = germanDate(procedure.publicParticipationEndDate);
    if (procedure.coordinateX && procedure.coordinateY) pointCoordinates++;
    if (!start || !end || end < cutoffDate || start > asOf) continue;
    inWindow++;
    const card = list.get(procedure.procedureId);
    if (!card) { ambiguous++; continue; }
    const municipality = identifyCity(procedure.externalName, card.locality, card.organization, known);
    if (!municipality) { ambiguous++; continue; }
    matched.add(municipality.id);
    const phase = procedure.publicParticipationPhaseName || '';
    items.push({
      municipalityId: municipality.id, title: procedure.externalName.replace(/\s+/g, ' ').trim(),
      url: new URL(procedure.procedureUrl, ORIGIN).href, date: start,
      sourceType: 'planningProcedure',
      locator: `DiPlan mapVars[procedureId=${procedure.procedureId}]: externalName, publicParticipationStartDate ${start}, publicParticipationEndDate ${end}, publicParticipationPhaseName „${phase}“; list municipality „${card.locality}“, operator „${card.organization}“`,
      stage: stageFromPhase(phase, start, end, asOf), participationEnd: end
    });
  }
  if (list.size !== data.mapVars.length) warnings.push(`DiPlan map/list mismatch: ${list.size} cards vs ${data.mapVars.length} map records`);
  return {
    items,
    coverage: { statewideProcedures: data.procedureCount, inWindow, mapPointCoordinates: pointCoordinates, molMatchedItems: items.length, molMunicipalities: matched.size, titleOrJurisdictionUnresolved: ambiguous, boundaryGeometryPublished: false },
    sources: [{ id: 'diplan-brandenburg', type: 'planningProcedure', url: API, publicList: `${ORIGIN}/`, licence: 'unknown', reuse: 'facts_with_attribution', statewideProcedures: data.procedureCount, note: 'Only title, dates, phase, URL and locator are republished; point coordinates and any procedure geometry are not redistributed' }]
  };
}
