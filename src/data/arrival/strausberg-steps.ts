import type { ArrivalStep } from './types.ts';

export const strausbergSteps: readonly ArrivalStep[] = [
  // evidence: "Bei Zuzug in die Stadt Strausberg aus dem Bundesgebiet bzw. aus dem Ausland müssen sich meldepflichtige Personen innerhalb von zwei Wochen unter persönlicher Vorsprache anmelden."
  {
    id: 'register-address', phase: 'first-two-weeks', title: 'Register your address',
    why: 'Registration (Anmeldung) is due within two weeks of moving in.',
    whatToDo: 'Book a Bürgerbüro appointment through the city page. Go in person with identity documents for everyone being registered and the landlord’s confirmation; check the page for extra documents in your situation.',
    source: { label: 'Strausberg service portal: register an address', url: 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/10714/show', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'The city portal lists an online appointment, not online address registration. Arrivals from abroad must bring all family members in person and may need original translated documents.',
  },
  // evidence: "Der Wohnungsgeber ist verpflichtet, bei der Anmeldung mitzuwirken."
  {
    id: 'landlord-confirmation', phase: 'first-two-weeks', title: 'Ask for your landlord’s confirmation',
    why: 'The person providing your home must confirm that you moved in.',
    whatToDo: 'Ask for the landlord’s confirmation (Wohnungsgeberbestätigung) before your registration appointment. The city registration page has a downloadable form. If it is withheld or late, tell the registration office without delay.',
    source: { label: 'Federal Registration Act, section 19', url: 'https://www.gesetze-im-internet.de/bmg/__19.html', checkedOn: '2026-09-29' },
    official: true,
  },
  // evidence: "Staatsangehörige aus Ländern, die nicht der Europäischen Union angehören, müssen sich auch bei der Ausländerbehörde melden."
  {
    id: 'immigration-office', phase: 'first-two-weeks', title: 'Check your residence documents',
    why: 'Newcomers from outside the EU may also need to speak with the district immigration office (Ausländerbehörde).',
    whatToDo: 'After registering at the Bürgerbüro, check the district immigration office’s residence-permit services and make an appointment if your situation requires it.',
    situations: ['from-abroad'],
    source: { label: 'Strausberg service portal: register an address', url: 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/10714/show', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'The city specifically says non-EU nationals must also report to the immigration office; EU nationals should check their own requirements.',
  },
  // evidence: "Für einen Platz in der Kindertages- oder Horteinrichtung ist eine Bedarfsmeldung über das Online-Portal: https://kitaanmeldung.stadt-strausberg.de erforderlich."
  {
    id: 'childcare', phase: 'first-two-weeks', title: 'Request a childcare place',
    why: 'The city allocates day-care and after-school care (Kita und Hort) places centrally.',
    whatToDo: 'Submit a needs notification through the city’s Kita online portal. Have a copy of your child’s birth certificate and a parent’s photo ID ready; check the service page for further documents.',
    situations: ['with-children'], interests: ['kids'],
    source: { label: 'Strausberg service portal: childcare', url: 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/10205/show', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'A needs notification does not guarantee a preferred place; extra hours or care outside your home municipality may require district approval.',
  },
  // evidence: "In dringenden, nicht lebensbedrohlichen Situationen, wenn die Arztpraxis geschlossen hat, ist der Ärztliche Bereitschaftsdienst zuständig."
  {
    id: 'emergency-numbers', phase: 'first-two-weeks', title: 'Save the medical emergency numbers',
    why: 'Life-threatening emergencies and urgent problems outside practice hours need different help.',
    whatToDo: 'Call 112 for danger to life or possible lasting harm. Call 116 117 for urgent, non-life-threatening medical help when your doctor’s practice is closed.',
    interests: ['health'],
    source: { label: 'Federal health portal: emergency numbers', url: 'https://gesund.bund.de/notfallnummern', checkedOn: '2026-09-29' },
    official: true,
  },
  // evidence: "Für alle Anliegen ist ein gültiger Online-Termin erforderlich."
  {
    id: 'vehicle', phase: 'first-month', title: 'Check your vehicle registration',
    why: 'The district vehicle registration office, not the city Bürgerbüro, handles registration and address changes for vehicles.',
    whatToDo: 'Find the relevant change-of-address or transfer case on the district vehicle registration page. Check its document list and book an online appointment; the district also links to the state i-Kfz service.',
    source: { label: 'Märkisch-Oderland: vehicle registration', url: 'https://www.maerkisch-oderland.de/leben-wohnen/wohnen/verkehr/fahrzeugzulassung', checkedOn: '2026-09-29' },
    official: true,
  },
  // evidence: "Jeder Hundehalter ist verpflichtet, die Hundehaltung in der Stadt Strausberg unverzüglich anzuzeigen, sobald der Hund älter als acht Wochen ist."
  {
    id: 'dog', phase: 'first-month', title: 'Report your dog to the city',
    why: 'Keeping a dog needs a notification to the city’s public-order team.',
    whatToDo: 'Use the city dog-keeping (Hundehaltung) form. Check the page for the required chip number and dog and keeper details; also check the city’s dog tax rules.',
    source: { label: 'Strausberg service portal: dog keeping', url: 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/11250/show', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'The public-order notice and dog-tax registration are separate matters; ask the city which forms apply.',
  },
  // evidence: "Abfallentsorgung – Behälteränderungsdienst (Privathaushalt & Gewerbe)"
  {
    id: 'waste', phase: 'first-month', title: 'Find your bin collection days',
    why: 'The district’s Entsorgungsbetrieb Märkisch-Oderland (EMO) handles collection schedules and bin services.',
    whatToDo: 'Check EMO’s collection calendar. If you own a newly connected property, use its private-household registration to request bins; for a bin change use its container-change service. If you rent, ask who manages your building’s bins.',
    source: { label: 'District service portal: EMO services', url: 'https://service.lkmol.de/dienstleistungen/-/egov-bis-detail/einrichtung/15623/show', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'The first-registration form is for properties being connected for the first time, not automatically for every new tenant.',
  },
  // evidence: "Ansprechpartner für einen Schulwechsel sind die staatlichen Schulämter, zuständig für verschiedene Landkreise und kreisfreien Städte."
  {
    id: 'school', phase: 'first-month', title: 'Arrange your child’s school place',
    why: 'School transfers and first-time enrolment use different routes.',
    whatToDo: 'For a transfer from another German state, contact the state school office in Frankfurt (Oder), which covers Märkisch-Oderland. For a child starting primary school, consult the state’s school-registration page and ask the local school about its current deadlines.',
    situations: ['with-children'], interests: ['kids'],
    source: { label: 'Brandenburg education ministry: school transfer', url: 'https://mbjs.brandenburg.de/bildung/weitere-themen/schulwechsel-nach-brandenburg.html', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'Current first-grade registration dates are published separately and can change each school year.',
  },
  // evidence: "# S Strausberg Nord S Westkreuz"
  {
    id: 'transport-tickets', phase: 'first-month', title: 'Plan your trips and tickets',
    why: 'The S5 connects Strausberg Nord, Strausberg Stadt, Hegermühle and Strausberg with Berlin; these Strausberg stations are in fare zone C.',
    whatToDo: 'Find your nearest S5 stop on the line page. Enter your trip in VBB Fahrinfo to check live connections and the ticket zones before buying a ticket.',
    source: { label: 'S-Bahn Berlin: S5 line and stations', url: 'https://sbahn.berlin/en/plan-a-journey/s5/', checkedOn: '2026-09-29' },
    official: false,
    caveat: 'Check https://www.vbb.de/fahrinfo/ for current routes, ticket options, fares and disruptions.',
  },
  // evidence: "Hausärztliche Praxen in Ihrer Nähe finden Sie über unsere Arztsuche."
  {
    id: 'find-doctor', phase: 'first-month', title: 'Look for a local doctor',
    why: 'A family doctor (Hausarztpraxis) is often the first place for non-emergency medical care.',
    whatToDo: 'Use the federal health portal’s doctor search for practices near Strausberg; filter by language or accessibility if needed, then ask the practice about appointments.',
    interests: ['health'],
    source: { label: 'Federal health portal: family doctors', url: 'https://gesund.bund.de/hausaerztliche-versorgung', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'A search result does not confirm that the practice is accepting new patients.',
  },
  // evidence: "von Angelegenheiten der Berechtigung oder Verpflichtung zur Teilnahme an Integrationskursen"
  {
    id: 'integration-course', phase: 'months-two-and-three', title: 'Ask about language and integration courses',
    why: 'The district immigration office handles questions about eligibility or obligations for integration courses.',
    whatToDo: 'Check the immigration office’s online applications and ask whether an integration course applies to you. For other adult courses, ask the district’s adult-education centre in Strausberg.',
    situations: ['from-abroad'], interests: ['culture'],
    source: { label: 'Märkisch-Oderland: immigration office', url: 'https://www.maerkisch-oderland.de/leben-wohnen/wohnen/ordnung/rechts-und-ordnungsangelegenheiten/auslaenderbehoerde', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'No current Strausberg language-course places or dates were verified.',
  },
  // evidence: "Dann kommen Sie einfach während der Öffnungszeiten zu uns in die Heinrich-Mann-Bibliothek im Stadthaus oder in die Zweigbibliothek"
  {
    id: 'library', phase: 'months-two-and-three', title: 'Visit the city library',
    why: 'The Heinrich-Mann-Bibliothek has in-person and digital lending.',
    whatToDo: 'Visit the main library in the city administration building or its Hegermühle branch. Ask about a reader’s card and the Onleihe digital collection.',
    interests: ['culture', 'kids'],
    source: { label: 'Strausberg service portal: library lending', url: 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/11710/show', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'Check current opening hours and membership charges before you visit.',
  },
  // evidence: "Sportvereine im Überblick können hier eingesehen werden"
  {
    id: 'try-sports-club', phase: 'months-two-and-three', title: 'Find a sports club',
    why: 'The city links to its list of sports clubs, a starting point for meeting people through an activity.',
    whatToDo: 'Browse the city’s club list and contact a club about its current sessions and whether you can visit before joining.',
    interests: ['sport'],
    source: { label: 'Strausberg: sport and sports clubs', url: 'https://www.stadt-strausberg.de/sport-2/', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'A trial session is not promised by the city; ask the club directly.',
  },
  // evidence: "Am 28.09. starten wir den nächsten Seepferdchenkurs für Schwimmanfänger."
  {
    id: 'swim-at-strausbad', phase: 'months-two-and-three', title: 'Try the municipal swimming pool',
    why: 'Strausbad has a swimming hall; its operator also publishes swimming-course news.',
    whatToDo: 'Check Strausberger Bäder for current swimming hours and the next course, or ask at the hall on Wriezener Straße 30a.',
    interests: ['sport', 'kids'],
    source: { label: 'Strausberger Bäder: beginner swimming course', url: 'https://www.strausberger-baeder.de/freie-plaetze-im-naechsten-seepferdchen-kurs', checkedOn: '2026-09-29' },
    official: false,
    caveat: 'The course notice is dated 17 September 2026 and its 28 September start has passed; check for the next course and current access.',
  },
  // evidence: "Alle Veranstaltungen im Stadtgebiet finden Sie auch in unserem Online-Veranstaltungskalender."
  {
    id: 'city-events', phase: 'months-two-and-three', title: 'Pick a local event',
    why: 'The city has a calendar with events from different local organisers.',
    whatToDo: 'Open the city event calendar and choose an event you can attend; check its date, organiser and any registration details.',
    interests: ['culture'],
    source: { label: 'Strausberg tourist information: local events', url: 'https://www.stadt-strausberg.de/touristinformation-wir-stellen-uns-vor-2/', checkedOn: '2026-09-29' },
    official: true,
  },
  // evidence: "Während der regulären Badesaison vom 15. Mai bis 15. September wird die Qualität der Badegewässer von den Gesundheitsämtern durch regelmäßige Kontrollen vor Ort"
  {
    id: 'lake-swimming', phase: 'months-four-to-six', title: 'Plan a lake swim in season',
    why: 'Brandenburg monitors designated bathing waters during the summer bathing season.',
    whatToDo: 'Before swimming in the Straussee, consult the state bathing-water map and local signs for current water quality and access.',
    interests: ['nature', 'sport'],
    source: { label: 'Brandenburg: bathing-water monitoring and season', url: 'https://badestellen.brandenburg.de/erlaeuterungen-und-kontakte', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'The regular monitored season is 15 May to 15 September; this is not a promise that a particular lakeside facility is open.',
  },
  // evidence: "öffentliche Tagesordnungen, Vorlagen und Niederschriften der Stadtverordnetenversammlung sowie seiner Ausschüsse abzurufen."
  {
    id: 'local-council', phase: 'months-four-to-six', title: 'Follow a city council issue',
    why: 'Public council agendas and records show which local decisions are coming up.',
    whatToDo: 'Read the citizens’ council information system (Ratsinformationssystem) before a city council meeting. Check the city’s resident-participation information for how to submit a resident question.',
    source: { label: 'Strausberg service portal: council information system', url: 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/10376/show', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'Question procedures and meeting arrangements should be checked with the city before attending.',
  },
  // evidence: "Homepage des Kinder- und Jugendparlaments"
  {
    id: 'youth-parliament', phase: 'months-four-to-six', title: 'Explore young people’s participation',
    why: 'The city family office links to the local children’s and youth parliament (Kinder- und Jugendparlament).',
    whatToDo: 'Ask the city’s family office how a young resident can connect with the parliament. For other perspectives, ask about the senior and disability advisory councils listed by the city.',
    situations: ['with-children'], interests: ['kids'],
    source: { label: 'Strausberg: children, youth and family office', url: 'https://www.stadt-strausberg.de/kinder-jugend-familienbuero/', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'Membership rules or meeting dates for the parliament and advisory councils were not verified.',
  },
  // evidence: "Sie haben Interesse, als ehrenamtliche Wahlhelfer*in den reibungslosen Ablauf der Wahl zu unterstützen?"
  {
    id: 'volunteer', phase: 'months-four-to-six', title: 'Look for a way to volunteer',
    why: 'The city invites eligible residents to volunteer as election helpers (Wahlhelfer).',
    whatToDo: 'Read the city’s election-helper page and its online registration form. For other volunteering, ask a local club directly about its needs.',
    interests: ['volunteering'],
    source: { label: 'Strausberg service portal: election helpers', url: 'https://onlinedienste.strausberg.de/detail/-/vr-bis-detail/dienstleistung/10865/show', checkedOn: '2026-09-29' },
    official: true,
    caveat: 'Election helpers must be eligible to vote in the particular election; the dated election notice may not describe the next opening.',
  },
];
