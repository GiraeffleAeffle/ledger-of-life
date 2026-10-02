export type SolarAssignmentFields = {
  solarAssignmentState: 'unassigned' | 'pending' | 'approved' | 'rejected' | 'paused';
  peakCapacityKwp: number | null; dailyProductionCeilingKwh: number | null;
  solarAnomaly: { day: string; energyKwh: number; ceilingKwh: number; detectedAt: string } | null;
};
export type OperatorSolarAssignmentFields = Omit<SolarAssignmentFields, 'solarAnomaly'> & { aboveCeiling: boolean; pausedForReview: boolean };
export type HomeDevice = SolarAssignmentFields & {
  hostId: string; name: string; state: string; kind: 'operator' | 'community'; availability: string;
  payoutWallet: string | null; models: string[]; canSuspend?: boolean;
  freePublicAnswers?: boolean;
  capabilities: { gpuModels: string[]; solarSensors: string[]; validatorIds: string[] } | null;
  latestReading: { powerW: number | null; energyTodayKwh: number; timestamp: string; localDate?: string; timezone?: string } | null;
  dailyTotals: { day: string; energyKwh: number; updatedAt: string }[];
  assignSolarToBuilding: boolean;
  earnings: { settledAnswers: number; amountAtomic: string; asset: string | null; receipts?: { txHash: string; amountAtomic: string; settledAt: string | null }[] };
  solarIncome: { day: string; energyKwh: number; amountAtomic: string; state: string; txHash: string | null }[];
};
export type HomeDevicesResponse = { devices: HomeDevice[]; canPair: boolean; isOperator: boolean };
export function atomicDollars(atomic: string): string {
  if (!/^\d+$/.test(atomic)) return 'Unavailable';
  const value = BigInt(atomic);
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ''} tUSDG`;
}
export function readingFresh(timestamp: string, now = Date.now()): boolean {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && time <= now + 300_000 && now - time <= 900_000;
}
export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
export function installCommand(origin: string, checksum: string): string | null {
  if (!/^[a-f0-9]{64}$/i.test(checksum)) return null;
  return `curl --fail --location ${shellQuote(`${origin}/api/home-node/download`)} --output home-node.mjs && printf '%s  %s\\n' ${shellQuote(checksum)} home-node.mjs | shasum -a 256 -c -`;
}
export function mcpConfig(): string {
  return JSON.stringify({ mcpServers: { 'ledger-home-node': { command: 'node', args: ['/absolute/path/to/home-node.mjs', 'mcp'] } } }, null, 2);
}
export function pairingStatus(devices: Pick<HomeDevice, 'hostId' | 'name' | 'state' | 'capabilities'>[], baseline: string[], expiresAt: string, now = Date.now()): string {
  const joined = devices.find((device) => !baseline.includes(device.hostId) && device.state !== 'revoked');
  if (joined) return joined.capabilities ? `${joined.name} is connected and reporting. See its live status below.` : `${joined.name} paired. Waiting for its first capability report…`;
  if (Date.parse(expiresAt) <= now) return 'Pairing code expired. Hide it and create a new code to try again.';
  return 'Waiting for your node to pair… Checking every five seconds while this code is shown.';
}
export function solarSummary(reading: NonNullable<HomeDevice['latestReading']>, now = Date.now()): string {
  const fresh = readingFresh(reading.timestamp, now);
  const zone = reading.timezone ?? 'UTC';
  const day = reading.localDate ?? reading.timestamp.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const today = ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-');
  const period = day === today ? `today (${zone})` : `on ${day} (${zone})`;
  const power = reading.powerW === null ? 'Power unavailable' : `${reading.powerW.toLocaleString()} W ${fresh ? 'now' : 'at last reading'}`;
  return `${power} · ${reading.energyTodayKwh.toLocaleString()} kWh ${period}`;
}
export function hostKindLabel(kind: 'operator' | 'community' | undefined): string {
  return kind === 'operator' ? 'Operator host' : kind === 'community' ? 'Community host' : 'Host class unavailable';
}
export function solarAssignmentPayload(hostId: string, assigned: boolean, capacity: string): { hostId: string; assignSolarToBuilding: boolean; peakCapacityKwp?: number } | null {
  if (!assigned) return { hostId, assignSolarToBuilding: false };
  const peakCapacityKwp = Number(capacity);
  if (!Number.isFinite(peakCapacityKwp) || peakCapacityKwp <= 0 || peakCapacityKwp > 1000) return null;
  return { hostId, assignSolarToBuilding: true, peakCapacityKwp };
}
export function solarApprovalAllowed(assignment: SolarAssignmentFields): boolean {
  return assignment.peakCapacityKwp !== null && assignment.peakCapacityKwp > 0 && assignment.dailyProductionCeilingKwh !== null
    && (!assignment.solarAnomaly || assignment.solarAnomaly.energyKwh <= Math.min(assignment.dailyProductionCeilingKwh, 100));
}
export function operatorSolarApprovalAllowed(assignment: { peakCapacityKwp: number | null; aboveCeiling?: boolean; pausedForReview?: boolean }): boolean {
  return assignment.peakCapacityKwp !== null && assignment.peakCapacityKwp > 0 && assignment.aboveCeiling === false && typeof assignment.pausedForReview === 'boolean';
}
