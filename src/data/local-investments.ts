/** Leads to investigate, not verified offers or current membership opportunities. */
export const STRAUSBERG_INVESTMENT_LEADS = [
  { name: 'Wohnungsbaugenossenschaft Aufbau Strausberg eG', kind: 'Housing cooperative', url: 'https://www.wbg-aufbau.de/' },
  { name: 'Energiegenossenschaft Märkisch-Oderland', kind: 'Regional energy cooperative', url: 'https://www.eg-mol.de/' },
] as const;

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
    location: { coordinates: [13.898, 52.568], basis: 'illustrative', label: 'Illustrative city placement — not this property or an offer of land. Fictional test units, no value, no rights.' },
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
