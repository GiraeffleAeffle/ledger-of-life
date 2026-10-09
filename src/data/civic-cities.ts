export interface CivicCity {
  readonly id: string;
  readonly name: string;
  readonly mapCoverage: 'published_snapshot' | 'not_published';
  readonly councilCoverage: 'sampled_records' | 'regional_agenda_sample' | 'not_published';
  readonly sourceUrl: string;
  /** Source snapshot date, not a promise of present-day coverage. */
  readonly checkedAt: string;
  readonly contextLinks: readonly { readonly label: string; readonly url: string; readonly checkedAt: string }[];
}

const municipalityRegistry = 'https://service.brandenburg.de/service/de/adressen/kommunalverzeichnis/kvdaten.csv';
const regionalContext = { label: 'Märkisch-Oderland municipality register', url: municipalityRegistry, checkedAt: '2026-09-27' } as const;
const published = (id: string, name: string, sourceUrl: string): CivicCity => ({
  id, name, mapCoverage: 'published_snapshot', councilCoverage: 'sampled_records', sourceUrl, checkedAt: '2026-09-27',
  contextLinks: [{ label: 'Council source · sampled papers, not decisions', url: sourceUrl, checkedAt: '2026-09-27' }],
});
const neighbour = (id: string, name: string): CivicCity => ({
  id, name, mapCoverage: 'not_published', councilCoverage: 'not_published', sourceUrl: municipalityRegistry,
  checkedAt: '2026-09-27', contextLinks: [regionalContext],
});

/** Discussion scopes only. Never use this list to manufacture map/feed/atlas coverage.
 * Evidence: stadtstack-data/out/catalogue.json (2026-09-28), src/cities.ts,
 * and out/regions/brandenburg-mol/topics.json (2026-09-27).
 * Pipeline review state/precision remain on the original records. */
export const CIVIC_CITIES: readonly CivicCity[] = [
  { id: 'strausberg', name: 'Strausberg', mapCoverage: 'published_snapshot', councilCoverage: 'not_published',
    sourceUrl: municipalityRegistry, checkedAt: '2026-09-27', contextLinks: [regionalContext] },
  neighbour('altlandsberg', 'Altlandsberg'),
  neighbour('petershagen-eggersdorf', 'Petershagen/Eggersdorf'),
  neighbour('rehfelde', 'Rehfelde'),
  { ...neighbour('ruedersdorf-bei-berlin', 'Rüdersdorf bei Berlin'), contextLinks: [regionalContext,
    { label: 'Municipal heat-planning source', url: 'https://www.ruedersdorf.de/meine-gemeinde/konzepte/kommunale-waermeplanung/', checkedAt: '2026-09-27' }] },
  { ...neighbour('hoppegarten', 'Hoppegarten'), councilCoverage: 'regional_agenda_sample', contextLinks: [regionalContext,
    { label: 'Council agenda · three meetings sampled', url: 'https://buergerinfo.gemeinde-hoppegarten.de/si0040.asp', checkedAt: '2026-09-27' }] },
  neighbour('neuenhagen-bei-berlin', 'Neuenhagen bei Berlin'),
  published('koeln', 'Köln', 'https://buergerinfo.stadt-koeln.de/oparl/system'),
  published('muenster', 'Münster', 'https://oparl.stadt-muenster.de/system'),
  published('wuppertal', 'Wuppertal', 'https://oparl.wuppertal.de/oparl/system'),
  published('castrop-rauxel', 'Castrop-Rauxel', 'https://castroprauxel.gremien.info/oparl'),
  published('duesseldorf', 'Düsseldorf', 'https://ris-oparl.itk-rheinland.de/Oparl/system'),
  published('dresden', 'Dresden', 'https://oparl.dresden.de/system'),
  published('freiburg', 'Freiburg', 'https://ris.freiburg.de/oparl'),
];
const cityIds = new Set(CIVIC_CITIES.map((city) => city.id));
export function isCivicCity(value: unknown): boolean {
  return typeof value === 'string' && cityIds.has(value);
}
