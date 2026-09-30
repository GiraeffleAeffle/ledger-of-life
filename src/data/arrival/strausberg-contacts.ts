import type { ArrivalContact } from './types.ts';

export const strausbergContacts: readonly ArrivalContact[] = [
  // evidence: "Hegermühlenstraße 58, Erdgeschoss 15344 Strausberg"
  {
    id: 'buergerbuero', name: 'Bürgerbüro der Stadt Strausberg', role: 'Address registration and appointments',
    url: 'https://www.stadt-strausberg.de/buergerbuero/', address: 'Hegermühlenstraße 58, ground floor, 15344 Strausberg',
    source: { label: 'Strausberg: Bürgerbüro', url: 'https://www.stadt-strausberg.de/buergerbuero/', checkedOn: '2026-09-29' },
  },
  // evidence: "Kinder-, Jugend- und Familienbüro der Stadt Strausberg"
  {
    id: 'family-office', name: 'Kinder-, Jugend- und Familienbüro der Stadt Strausberg', role: 'Children, youth and family questions',
    url: 'https://www.stadt-strausberg.de/kinder-jugend-familienbuero/',
    source: { label: 'Strausberg: children, youth and family office', url: 'https://www.stadt-strausberg.de/kinder-jugend-familienbuero/', checkedOn: '2026-09-29' },
  },
  // evidence: "FTG Strausberger Bäder GmbH<br />Wriezener Straße 30a<br />(D) 15344 Strausberg"
  {
    id: 'baths', name: 'FTG Strausberger Bäder GmbH', role: 'Strausbad swimming hall and lakeside bathing information',
    url: 'https://www.strausberger-baeder.de/', address: 'Wriezener Straße 30a, 15344 Strausberg',
    source: { label: 'Strausberger Bäder: legal notice', url: 'https://www.strausberger-baeder.de/impressum', checkedOn: '2026-09-29' },
  },
  // evidence: "Sportvereine im Überblick können hier eingesehen werden"
  {
    id: 'city-sport', name: 'Stadt Strausberg – Sport', role: 'City sports contact and directory of clubs and facilities',
    url: 'https://www.stadt-strausberg.de/sport-2/',
    source: { label: 'Strausberg: sport', url: 'https://www.stadt-strausberg.de/sport-2/', checkedOn: '2026-09-29' },
  },
  // evidence: "Kreissportbund Märkisch – Oderland e. V."
  {
    id: 'district-sports', name: 'Kreissportbund Märkisch-Oderland e. V.', role: 'District sports-club umbrella organisation',
    url: 'https://www.ksb-mol.de/',
    source: { label: 'Kreissportbund Märkisch-Oderland', url: 'https://www.ksb-mol.de/', checkedOn: '2026-09-29' },
  },
  // evidence: "Zentrum für Erwachsenenbildung und Medien Strausberg Wriezener Straße 30 15344 Strausberg"
  {
    id: 'adult-education', name: 'Zentrum für Erwachsenenbildung und Medien Strausberg', role: 'District adult education and course enquiries',
    url: 'https://www.maerkisch-oderland.de/leben-wohnen/leben/bildung-sport-kultur/kontakte-schulverwaltungsamt',
    address: 'Wriezener Straße 30, 15344 Strausberg',
    source: { label: 'Märkisch-Oderland: adult education contacts', url: 'https://www.maerkisch-oderland.de/leben-wohnen/leben/bildung-sport-kultur/kontakte-schulverwaltungsamt', checkedOn: '2026-09-29' },
  },
  // evidence: "Hauptstelle in der Stadtverwaltung Hegermühlenstraße 58, 15344 Strausberg"
  {
    id: 'library', name: 'Heinrich-Mann-Bibliothek', role: 'City library and digital lending',
    url: 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/11710/show',
    address: 'Hegermühlenstraße 58, 15344 Strausberg',
    source: { label: 'Strausberg service portal: library', url: 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/11710/show', checkedOn: '2026-09-29' },
  },
  // evidence: "Waldsiedlung-Eichendamm 14 15306 Vierlinden OT Diedersdorf"
  {
    id: 'immigration', name: 'Ausländerbehörde Märkisch-Oderland', role: 'Residence permits and integration-course eligibility',
    url: 'https://www.maerkisch-oderland.de/leben-wohnen/wohnen/ordnung/rechts-und-ordnungsangelegenheiten/auslaenderbehoerde',
    address: 'Waldsiedlung-Eichendamm 14, 15306 Vierlinden OT Diedersdorf',
    source: { label: 'Märkisch-Oderland: immigration office', url: 'https://www.maerkisch-oderland.de/leben-wohnen/wohnen/ordnung/rechts-und-ordnungsangelegenheiten/auslaenderbehoerde', checkedOn: '2026-09-29' },
  },
  // evidence: "Adresse: August-Bebel-Straße 33, 15344 Strausberg"
  {
    id: 'tourist-information', name: 'Stadt- und Touristinformation Strausberg', role: 'Local events, walks and visitor information',
    url: 'https://www.stadt-strausberg.de/touristinformation-wir-stellen-uns-vor-2/',
    address: 'August-Bebel-Straße 33, 15344 Strausberg',
    source: { label: 'Strausberg: city and tourist information', url: 'https://www.stadt-strausberg.de/touristinformation-wir-stellen-uns-vor-2/', checkedOn: '2026-09-29' },
  },
  // evidence: "Entsorgungsbetrieb Märkisch Oderland (EMO) Klosterstraße 18 15344 Strausberg"
  {
    id: 'waste-office', name: 'Entsorgungsbetrieb Märkisch-Oderland (EMO)', role: 'Waste collection calendar and bin requests',
    url: 'https://service.lkmol.de/dienstleistungen/-/egov-bis-detail/einrichtung/15623/show',
    address: 'Klosterstraße 18, 15344 Strausberg',
    source: { label: 'Märkisch-Oderland: EMO office', url: 'https://service.lkmol.de/dienstleistungen/-/egov-bis-detail/einrichtung/15623/show', checkedOn: '2026-09-29' },
  },
];
