/** Research checked 2026-09-26; these are publication facts, not budget amounts. */
export const strausbergSources = {
  checkedAt: '2026-09-26',
  gazette: 'https://www.stadt-strausberg.de/wp-content/uploads/2024/11/2024-Amtsblatt_07.pdf',
  inspectionLaw: 'https://bravors.brandenburg.de/gesetze/bbgkverf#69',
  informationAccessLaw: 'https://bravors.brandenburg.de/gesetze/aig',
  bernau: 'https://www.bernau.de/de/rathaus-service/buergerinformation/haushalt.html',
  brandenburg: 'https://www.stadt-brandenburg.de/fileadmin/pdf/20/HH-Plan_2025-2026/01_02_Vorbericht_Haushaltssatzung_Beschluss_2025_2026.pdf',
  directories: [
    { label: 'Stadt Strausberg · Vereine', url: 'https://www.stadt-strausberg.de/vereine/' },
    { label: 'Stadt Strausberg · Sport', url: 'https://www.stadt-strausberg.de/sport-2/' },
    { label: 'Kreissportbund Märkisch-Oderland · Vereinsliste (district-wide)', url: 'https://www.ksb-mol.de/vereinsliste/' },
  ],
  calendar: 'https://strausberg.allris.cloud/public/si010',
  documents: 'https://strausberg.allris.cloud/public/dooeff',
  hierarchy: [
    { level: 'City · Strausberg', available: 'Atlas projects and consultations; public directories', url: 'https://www.stadt-strausberg.de/' },
    { level: 'District · Märkisch-Oderland', available: 'District services and council portal (link only)', url: 'https://www.maerkisch-oderland.de/' },
    { level: 'State · Brandenburg', available: 'State laws and public portal (link only)', url: 'https://brandenburg.de/' },
    { level: 'Country · Germany', available: 'Bundestag debates and decisions (link only)', url: 'https://www.bundestag.de/' },
    { level: 'EU', available: 'EU legislation and institutions (link only)', url: 'https://european-union.europa.eu/' },
  ],
} as const;
