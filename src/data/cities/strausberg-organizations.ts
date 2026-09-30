export type ParticipationChannel = 'visit' | 'buy' | 'work' | 'training' | 'contact' | 'supply' | 'partner';
export interface OrganizationSource { url: string; publisher: string; checkedAt: string }
export interface OrganizationParticipation {
  kind: ParticipationChannel;
  label: string;
  url: string;
  detail?: string;
  /** Published opportunities are attributed invitations, not guaranteed availability or a contract. */
  status: 'verified_channel' | 'information_only' | 'published_opportunity';
}
export interface OrganizationProfile {
  id: string;
  name: string;
  sector: 'housing' | 'energy' | 'manufacturing' | 'public_library';
  /** Existing Stadtstack place ID only; null means that no matching place signal is established. */
  signalId: string | null;
  productsAndServices: string[];
  participation: OrganizationParticipation[];
  sources: OrganizationSource[];
}

/** Public information about independent organisations, not project partners or token issuers. */
export const strausbergOrganizations: OrganizationProfile[] = [
  {
    id: 'swg-strausberg', name: 'Strausberger Wohnungsbaugesellschaft mbH', sector: 'housing', signalId: null,
    productsAndServices: ['Wohnungen zur Miete in Strausberg', 'Wohnungssuche und Wohnungsantrag'],
    participation: [
      { kind: 'buy', label: 'Wohnungsangebote ansehen', url: 'https://www.swg-strausberg.de/wohnungen.php', status: 'verified_channel' },
      { kind: 'contact', label: 'Wohnungssuche und Wohnungsantrag', url: 'https://www.swg-strausberg.de/fragen-zur-wohnungssuche/', status: 'verified_channel' },
      { kind: 'work', label: 'Karriere-Informationen der Stadtwerke Gruppe', url: 'https://www.stadtwerkegruppe-strausberg.de/karriere/', status: 'information_only' },
      { kind: 'training', label: 'Ausbildung bei der SWG kennenlernen', url: 'https://www.swg-strausberg.de/', status: 'information_only' },
    ],
    sources: [
      { url: 'https://www.swg-strausberg.de/', publisher: 'Strausberger Wohnungsbaugesellschaft mbH', checkedAt: '2026-09-28' },
      { url: 'https://www.swg-strausberg.de/fragen-zur-wohnungssuche/', publisher: 'Strausberger Wohnungsbaugesellschaft mbH', checkedAt: '2026-09-28' },
      { url: 'https://www.swg-strausberg.de/wohnungen.php', publisher: 'Strausberger Wohnungsbaugesellschaft mbH', checkedAt: '2026-09-28' },
    ],
  },
  {
    id: 'stadtwerke-strausberg', name: 'Stadtwerke Strausberg GmbH', sector: 'energy', signalId: null,
    productsAndServices: ['Strom und Wärme', 'Energieberatung, Hausanschlüsse und Wallboxen'],
    participation: [
      { kind: 'buy', label: 'Stromtarife und Versorgung ansehen', url: 'https://www.stadtwerke-strausberg.de/strom/', status: 'verified_channel' },
      { kind: 'contact', label: 'Hausanschluss anfragen', url: 'https://www.stadtwerke-strausberg.de/hausanschluss/', status: 'verified_channel' },
      { kind: 'work', label: 'Karriere-Informationen der Stadtwerke Gruppe', url: 'https://www.stadtwerkegruppe-strausberg.de/karriere/', status: 'information_only' },
      { kind: 'training', label: 'Ausbildungs- und Karriereoptionen kennenlernen', url: 'https://www.stadtwerkegruppe-strausberg.de/karriere/', status: 'information_only' },
    ],
    sources: [
      { url: 'https://www.stadtwerke-strausberg.de/', publisher: 'Stadtwerke Strausberg GmbH', checkedAt: '2026-09-28' },
    ],
  },
  {
    id: 'stemme', name: 'STEMME GmbH', sector: 'manufacturing', signalId: null,
    productsAndServices: ['Motorsegler und Sportflugzeuge der S12-Serie', 'Service für Stemme-Flugzeuge'],
    participation: [
      { kind: 'buy', label: 'Twin Voyager S12 ansehen', url: 'https://www.stemme.com/s12.html', status: 'verified_channel' },
      { kind: 'contact', label: 'Hersteller kontaktieren', url: 'https://www.stemme.com/contact.html', status: 'verified_channel' },
      { kind: 'work', label: 'Veröffentlichte Stellen ansehen', url: 'https://www.stemme.com/career.html', status: 'published_opportunity',
        detail: 'IT Manager, Qualitätsingenieur und Entwicklungsingenieur stehen auf der veröffentlichten Karriereseite.' },
      { kind: 'partner', label: 'Vertriebs- oder Servicepartner werden', url: 'https://www.stemme.com/locations.html', status: 'published_opportunity',
        detail: 'STEMME lädt zum Ausbau seines Vertriebs- und Servicepartnernetzes ein.' },
    ],
    sources: [
      { url: 'https://www.stemme.com/', publisher: 'STEMME GmbH', checkedAt: '2026-09-28' },
      { url: 'https://www.stemme.com/contact.html', publisher: 'STEMME GmbH', checkedAt: '2026-09-28' },
      { url: 'https://www.stemme.com/s12.html', publisher: 'STEMME GmbH', checkedAt: '2026-09-28' },
      { url: 'https://www.stemme.com/career.html', publisher: 'STEMME GmbH', checkedAt: '2026-09-28' },
      { url: 'https://www.stemme.com/locations.html', publisher: 'STEMME GmbH', checkedAt: '2026-09-28' },
    ],
  },
  {
    id: 'heinrich-mann-bibliothek', name: 'Heinrich-Mann-Bibliothek Strausberg', sector: 'public_library',
    signalId: 'osm:node-1631758488',
    productsAndServices: ['Bücher, audiovisuelle Medien, Spiele und Zeitschriften', 'Lesungen und Bibliotheksunterricht nach Anmeldung'],
    participation: [
      { kind: 'visit', label: 'Hauptstelle in der Hegermühlenstraße 58 besuchen', url: 'https://www.stadt-strausberg.de/kulturelle-einrichtungen/', status: 'verified_channel' },
      { kind: 'contact', label: 'Bibliotheksangebote erfragen', url: 'https://www.stadt-strausberg.de/wir-stellen-uns-vor/', status: 'verified_channel' },
    ],
    sources: [
      { url: 'https://www.stadt-strausberg.de/kulturelle-einrichtungen/', publisher: 'Stadt Strausberg', checkedAt: '2026-09-28' },
      { url: 'https://www.stadt-strausberg.de/wir-stellen-uns-vor/', publisher: 'Stadt Strausberg', checkedAt: '2026-09-28' },
      { url: 'https://www.openstreetmap.org/node/1631758488', publisher: 'OpenStreetMap contributors (ODbL)', checkedAt: '2026-09-28' },
    ],
  },
];

/** The group publishes both lines of business; this does not establish a supply contract. */
export const strausbergOrganizationRelations: {
  fromId: OrganizationProfile['id']; toId: OrganizationProfile['id'];
  kind: 'shared_group'; source: OrganizationSource;
}[] = [
  {
    fromId: 'swg-strausberg', toId: 'stadtwerke-strausberg', kind: 'shared_group',
    source: { url: 'https://www.stadtwerkegruppe-strausberg.de/', publisher: 'Stadtwerke Gruppe Strausberg', checkedAt: '2026-09-28' },
  },
];
