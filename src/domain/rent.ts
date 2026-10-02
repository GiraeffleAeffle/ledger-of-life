export const BUILDING_RENT_SHARE_BPS = 2000 as const;
export const RENT_BUILDING_ID = 'demo-neighbourhood-homes' as const;
export const BUILDING_RENT_MEANING = "A fixed 20 % of this test rent goes to the fictional building's tHOME stakers; the rest goes to the landlord. This simulates how a tokenized building could share net rental income; in a real building rent goes to the property owner under the lease.";
export type BuildingRent = { buildingId: typeof RENT_BUILDING_ID; shareBps: typeof BUILDING_RENT_SHARE_BPS; landlordWallet: string };
export type RentTerms = BuildingRent & { rentMonthly: string };
export function splitBuildingRent(rentMonthly: string) {
  if (!/^[1-9][0-9]*$/.test(rentMonthly) || BigInt(rentMonthly) > 10_000_000_000n) throw new Error('Use a positive monthly test rent up to 10,000 test dollars.');
  const rent = BigInt(rentMonthly), building = rent * BigInt(BUILDING_RENT_SHARE_BPS) / 10000n;
  return { buildingRaw: building.toString(), landlordRaw: (rent - building).toString() };
}
export function berlinRentMonth(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(new Date(now));
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
}
