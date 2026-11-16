export type PlaceCoordinate = readonly [longitude: number, latitude: number];
export type PlaceLandmarkId = 'plan' | 'railway' | 'road' | 'farm' | 'boundary';
export interface PlaceLandmark {
  id: PlaceLandmarkId;
  label: string;
  shortLabel: string;
  coordinate: PlaceCoordinate;
  sentence: string;
  basis: 'document-orientation' | 'osm';
  osm?: { type: 'way' | 'relation'; id: number };
}

export const PLACE_CASE_ID = 'case:032e2ba5ba8566598bdd0e335406fcf2';
export const PLACE_MAP_ASSET = '/topic-b70/osm-surroundings.json';
export const PLACE_GEOMETRY_NOTICE = 'Ungefähre Orientierung nach Dokumentbeschreibung – keine amtliche oder katastergenaue Plangrenze, kein Anlagenbestand.';
export const PLACE_DOCUMENT = {
  url: 'https://sessionnet.amt-buechen.de/bi/getfile.php?id=130299&type=do',
  title: 'Gemeindevertretung Büchen · 14. Oktober 2025',
  capture: 'Bereits erfasste Niederschrift · Stadtstack-Erfassung vom 16. November 2026; kein neuer Abruf des Dokuments.',
  mainQuote: 'Nördlich sowie südlich der Bahnlinie Büchen - Hamburg, westlich der Straße "Franzhagener Weg", östlich als auch nordöstlich der Gemeindegrenze zu der Gemeinde Müssen und südlich des landwirtschaftlichen Betriebes an der Straße \'Steinkrug\'',
  compensationQuote: 'Nördlich angrenzend an das Gewerbegebiet “Steinkrüger Koppel“ und südlich des vorhandenen Verkehrsweges nach Neu-Nüssau',
  decision: 'Entwurfs- und Veröffentlichungsbeschluss, 11 Ja · 5 Nein · 0 Enthaltungen; kein finaler Satzungsbeschluss.',
} as const;

// Editorial point anchors express the document's relative location, never a perimeter.
export const PLACE_ORIENTATION_POINTS: readonly PlaceCoordinate[] = [[10.5818, 53.4942], [10.5818, 53.4916]];
// Approximate editorial envelope follows the relative document description, not surveyed edges.
export const PLACE_ORIENTATION_OUTLINE: readonly PlaceCoordinate[] = [[10.5773, 53.4959], [10.5849, 53.4954], [10.5845, 53.4903], [10.5779, 53.4905]];
export const PLACE_COMPENSATION = {
  label: 'Teilgebiet 2 · Ausgleich A2',
  sentence: 'Separat: nördlich der Steinkrüger Koppel, südlich des Weges nach Neu-Nüssau.',
  geometry: null,
  reason: 'In den erfassten OSM-Daten nicht eindeutig verortbar; deshalb kein Kartenpunkt und keine erfundene Flurstücksgrenze.',
  parcelDescription: 'Flurstück 97 teilweise · Flur 2 · Gemarkung Nüssau; nur Dokumentangabe, keine Katastergeometrie.',
} as const;

export const PLACE_LANDMARKS: readonly PlaceLandmark[] = [
  { id: 'plan', label: 'B-Plan 70 · ungefähr', shortLabel: 'Plangebiet', coordinate: [10.5818, 53.4935], basis: 'document-orientation', sentence: 'Das beschriebene Plangebiet liegt beidseits der Bahn, westlich des Franzhagener Wegs.' },
  { id: 'railway', label: 'Bahn Büchen–Hamburg', shortLabel: 'Bahn', coordinate: [10.5848537, 53.4919865], basis: 'osm', osm: { type: 'way', id: 178427208 }, sentence: 'Die Bahnlinie durchzieht die Umgebung; das Dokument nennt Flächen auf beiden Seiten.' },
  { id: 'road', label: 'Franzhagener Weg', shortLabel: 'Franzhagener Weg', coordinate: [10.5852344, 53.4932499], basis: 'osm', osm: { type: 'way', id: 28442424 }, sentence: 'Der Franzhagener Weg liegt laut Dokument östlich des beschriebenen Plangebiets.' },
  { id: 'farm', label: 'Hof bei Steinkrug', shortLabel: 'Steinkrug', coordinate: [10.5817011, 53.4970448], basis: 'osm', osm: { type: 'way', id: 259200428 }, sentence: 'Der in OSM erfasste Hof liegt nördlich des zur Orientierung markierten Bereichs.' },
  { id: 'boundary', label: 'Gemeindegrenze Müssen', shortLabel: 'Grenze Müssen', coordinate: [10.57631, 53.4943576], basis: 'osm', osm: { type: 'relation', id: 1467719 }, sentence: 'Die OSM-Gemeindegrenze zu Müssen verläuft westlich der Orientierungsmarkierung.' },
];
