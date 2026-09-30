export function claimAmount(value: string, maximumAtomic: string): string {
  const normalized = value.replace(',', '.');
  if (!/^(0|[1-9]\d{0,18})(\.\d{1,6})?$/.test(normalized)) throw new Error('Enter a test USDC amount with up to six decimal places.');
  const [whole, fraction = ''] = normalized.split('.');
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
  if (atomic > BigInt(maximumAtomic)) throw new Error('The deduction cannot exceed the allowed maximum.');
  return atomic.toString();
}

export function settlementSplit(totalAtomic: string, landlordAtomic: string) {
  const total = BigInt(totalAtomic);
  const landlord = BigInt(landlordAtomic);
  if (landlord < 0n || landlord > total) throw new Error('The deduction cannot exceed the deposit at stake.');
  return { tenantAtomic: (total - landlord).toString(), landlordAtomic: landlord.toString() };
}

export const invitationKey = (accountId: string, agreementId: string) =>
  `ledger-of-life:invite:v1:${accountId}:${agreementId}`;

export function invitationStatus(createdAt: number, now: number) {
  return now >= createdAt + 86_400_000 ? 'expired' : 'valid';
}

export function invitationPayload(value: string): { id: string; role: 'arbitrator' | 'tenant'; token: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const invitation = parsed as Record<string, unknown>;
    if (typeof invitation.id !== 'string' || !invitation.id || !['arbitrator', 'tenant'].includes(String(invitation.role)) ||
      typeof invitation.token !== 'string' || !/^[a-f0-9]{64}$/.test(invitation.token)) return null;
    return invitation as { id: string; role: 'arbitrator' | 'tenant'; token: string };
  } catch { return null; }
}

export const confirmationStalled = (startedAt: number, now: number) => now - startedAt >= 90_000;
export const pollingPaused = (failures: number) => failures >= 3;
