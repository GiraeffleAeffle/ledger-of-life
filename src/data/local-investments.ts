/** Leads to investigate, not verified offers or current membership opportunities. */
export const STRAUSBERG_INVESTMENT_LEADS = [
  { name: 'Wohnungsbaugenossenschaft Aufbau Strausberg eG', kind: 'Housing cooperative', url: 'https://www.wbg-aufbau.de/' },
  { name: 'Energiegenossenschaft Märkisch-Oderland', kind: 'Regional energy cooperative', url: 'https://www.eg-mol.de/' },
] as const;

/** Private presentation shared by the project owner; no public online record located. */
export const ROEBEL_AGRI_PV = {
  title: 'Röbel/Müritz · citizen Agri-PV proposal',
  source: 'SolRenta Betriebs GmbH & Co. KG, “Vorstellung Bürgerbeteiligung Agri-Photovoltaik in Röbel/Müritz”, building-committee presentation, 21 Jan 2026.',
  summary: 'The developer proposed 6–8 MWp Agri-PV, citizen participation through DKB-Crowd from €250, locally determined eligibility and cheaper electricity tariffs within 25 km.',
  caveat: 'Developer’s figures, not verified; a proposal, not a decision. This is a precedent for participation, not an offer in Ledger of Life.',
  tokenization: 'Tokenization could add small tickets, transparent on-chain receipts, automatic payouts and reinvestment, and residence-based eligibility. A real offer would still need the same regulation as today’s crowd investing.',
  noteUrl: 'https://github.com/GiraeffleAeffle/ledger-of-life/blob/develop/docs/research/ROEBEL_AGRI_PV_2026-01.md',
} as const;

export type TestCityInvestmentId = 'demo-neighbourhood-homes' | 'demo-retrofit-workshop';
export type TestCityInvestment = {
  id: TestCityInvestmentId;
  name: string;
  symbol: string;
  kind: 'housing' | 'business';
  cityId: 'strausberg';
  cityName: 'Strausberg';
  description: string;
  uses: readonly string[];
  issuerReality: 'fictional-test-issuer';
  rights: 'Test tokens only; no company shares, cooperative membership or property title.';
  priceAtomicPerUnit: string;
  totalUnitsRaw: string;
  location: { coordinates: readonly [number, number]; basis: 'illustrative'; label: string };
};

/** Separate fictional issuers. Neither is any real provider or mapped property's owner. */
export const TEST_CITY_INVESTMENTS: readonly TestCityInvestment[] = [
  {
    id: 'demo-neighbourhood-homes', name: 'Neighbourhood Homes · test issuer', symbol: 'tHOME',
    kind: 'housing', cityId: 'strausberg', cityName: 'Strausberg',
    description: 'A fictional shared-housing project with rooftop solar, efficient heating and space for local work.',
    uses: ['More homes', 'Rooftop solar', 'Heat pumps', 'Shared work space'],
    issuerReality: 'fictional-test-issuer',
    rights: 'Test tokens only; no company shares, cooperative membership or property title.',
    priceAtomicPerUnit: '1000000', totalUnitsRaw: '10000000000000000000000',
    location: { coordinates: [13.898, 52.568], basis: 'illustrative', label: 'Illustrative city placement — not this property or an offer of land.' },
  },
  {
    id: 'demo-retrofit-workshop', name: 'Neighbourhood Works · test issuer', symbol: 'tWORK',
    kind: 'business', cityId: 'strausberg', cityName: 'Strausberg',
    description: 'A fictional local workshop that could install, maintain and repair building-energy equipment.',
    uses: ['Local skills', 'Installation tools', 'Repairs', 'Apprenticeships'],
    issuerReality: 'fictional-test-issuer',
    rights: 'Test tokens only; no company shares, cooperative membership or property title.',
    priceAtomicPerUnit: '1000000', totalUnitsRaw: '10000000000000000000000',
    location: { coordinates: [13.8858, 52.5786], basis: 'illustrative', label: 'Illustrative city placement — not a real business site or investment offer.' },
  },
];
