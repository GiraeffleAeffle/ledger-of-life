export const pinsKey = (cityId: string, accountId: string) => `ledger-of-life:personal-map-pins:v2:${encodeURIComponent(accountId)}:${cityId}`;
export const oldPinsKey = (cityId: string) => `ledger-of-life:personal-map-pins:v1:${cityId}`;

/** Claim a legacy device pin once for the first signed-in account to read it. */
export function readAccountPins(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, cityId: string, accountId: string): string {
  if (!cityId || !accountId) return '';
  const current = pinsKey(cityId, accountId);
  const existing = storage.getItem(current);
  if (existing !== null) return existing;
  const legacy = storage.getItem(oldPinsKey(cityId));
  if (legacy === null) return '';
  storage.setItem(current, legacy);
  storage.removeItem(oldPinsKey(cityId));
  return legacy;
}
