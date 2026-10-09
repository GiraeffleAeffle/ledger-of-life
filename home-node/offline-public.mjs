// Public-only, deliberately selected snapshot of src/data/arrival/strausberg-*.ts.
// Updating the packaging date does not revalidate the original source checks.
const source = (label, url) => ({ label, url, checkedOn: '2026-09-29' });
const pack = {
  cityId: 'strausberg', cityName: 'Strausberg', version: '2026-10-09.1',
  preparedOn: '2026-09-29', packagedOn: '2026-10-09',
  notice: 'Community guide, not an official city service. Sources were checked on 29 September 2026, not rechecked when packaged. Details may have changed. No live opening hours, departures, availability or nearby-town coverage.',
  entries: [
    {
      id: 'emergency-numbers', section: 'emergency', title: 'Medical help',
      text: 'Call 112 for danger to life or possible lasting harm. Call 116 117 for urgent, non-life-threatening medical help when your doctor’s practice is closed.',
      source: source('Federal health portal: emergency numbers', 'https://gesund.bund.de/notfallnummern'),
    },
    {
      id: 'buergerbuero', section: 'contacts', title: 'Bürgerbüro der Stadt Strausberg',
      text: 'Address registration and appointments', address: 'Hegermühlenstraße 58, ground floor, 15344 Strausberg',
      source: source('Strausberg: Bürgerbüro', 'https://www.stadt-strausberg.de/buergerbuero/'),
    },
    {
      id: 'family-office', section: 'contacts', title: 'Kinder-, Jugend- und Familienbüro der Stadt Strausberg',
      text: 'Children, youth and family questions',
      source: source('Strausberg: children, youth and family office', 'https://www.stadt-strausberg.de/kinder-jugend-familienbuero/'),
    },
    {
      id: 'waste-office', section: 'contacts', title: 'Entsorgungsbetrieb Märkisch-Oderland (EMO)',
      text: 'Waste collection calendar and bin requests', address: 'Klosterstraße 18, 15344 Strausberg',
      source: source('Märkisch-Oderland: EMO office', 'https://service.lkmol.de/dienstleistungen/-/egov-bis-detail/einrichtung/15623/show'),
    },
    {
      id: 'library', section: 'places', title: 'Heinrich-Mann-Bibliothek',
      text: 'City library and digital lending', address: 'Hegermühlenstraße 58, 15344 Strausberg',
      source: source('Strausberg service portal: library', 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/11710/show'),
    },
    {
      id: 'baths', section: 'places', title: 'FTG Strausberger Bäder GmbH',
      text: 'Strausbad swimming hall and lakeside bathing information', address: 'Wriezener Straße 30a, 15344 Strausberg',
      source: source('Strausberger Bäder: legal notice', 'https://www.strausberger-baeder.de/impressum'),
    },
    {
      id: 'tourist-information', section: 'places', title: 'Stadt- und Touristinformation Strausberg',
      text: 'Local events, walks and visitor information', address: 'August-Bebel-Straße 33, 15344 Strausberg',
      source: source('Strausberg: city and tourist information', 'https://www.stadt-strausberg.de/touristinformation-wir-stellen-uns-vor-2/'),
    },
    {
      id: 'register-address', section: 'welcome', title: 'Register your address',
      text: 'Registration (Anmeldung) is due within two weeks of moving in.',
      whatToDo: 'Book a Bürgerbüro appointment through the city page. Go in person with identity documents for everyone being registered and the landlord’s confirmation; check the page for extra documents in your situation.',
      caveat: 'The city portal lists an online appointment, not online address registration. Arrivals from abroad must bring all family members in person and may need original translated documents.',
      source: source('Strausberg service portal: register an address', 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/10714/show'),
    },
    {
      id: 'landlord-confirmation', section: 'welcome', title: 'Ask for your landlord’s confirmation',
      text: 'The person providing your home must confirm that you moved in.',
      whatToDo: 'Ask for the landlord’s confirmation (Wohnungsgeberbestätigung) before your registration appointment. The city registration page has a downloadable form. If it is withheld or late, tell the registration office without delay.',
      source: source('Federal Registration Act, section 19', 'https://www.gesetze-im-internet.de/bmg/__19.html'),
    },
    {
      id: 'childcare', section: 'welcome', title: 'Request a childcare place',
      text: 'The city allocates day-care and after-school care (Kita und Hort) places centrally.',
      whatToDo: 'Submit a needs notification through the city’s Kita online portal. Have a copy of your child’s birth certificate and a parent’s photo ID ready; check the service page for further documents.',
      caveat: 'A needs notification does not guarantee a preferred place; extra hours or care outside your home municipality may require district approval.',
      source: source('Strausberg service portal: childcare', 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/10205/show'),
    },
    {
      id: 'waste', section: 'welcome', title: 'Find your bin collection days',
      text: 'The district’s Entsorgungsbetrieb Märkisch-Oderland (EMO) handles collection schedules and bin services.',
      whatToDo: 'Check EMO’s collection calendar. If you own a newly connected property, use its private-household registration to request bins; for a bin change use its container-change service. If you rent, ask who manages your building’s bins.',
      caveat: 'The first-registration form is for properties being connected for the first time, not automatically for every new tenant.',
      source: source('District service portal: EMO services', 'https://service.lkmol.de/dienstleistungen/-/egov-bis-detail/einrichtung/15623/show'),
    },
  ],
};

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

export const CITY_PACKS = freeze({ strausberg: pack });

export function selectCityPack(cityId) {
  if (!Object.hasOwn(CITY_PACKS, cityId)) throw new Error('No reviewed public pack for this city. Available: strausberg.');
  return CITY_PACKS[cityId];
}

// This fixed pack has no private data/feed loader, account data or network updater.
export function cityContext(pack) {
  return `Selected city: ${pack.cityName}. Snapshot ${pack.version}; guide prepared ${pack.preparedOn}. ${pack.notice}\n` +
    pack.entries.map((entry) => `[${entry.id}] ${entry.title}: ${entry.text} ${entry.address ?? ''} ${entry.whatToDo ?? ''} ${entry.caveat ?? ''}\nSource: ${entry.source.label}; ${entry.source.url}; checked ${entry.source.checkedOn}`).join('\n\n');
}
