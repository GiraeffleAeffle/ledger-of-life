import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { WorkflowError } from '../domain/errors.ts';
import { AccessError, ConflictError } from './errors.ts';
import { hostOperatorAllowed, hostPairingAllowed, operatorConnectorHosts, ownedConnectorHosts, type ConnectorHost } from './local-ai-hosts.ts';
import type { Store } from './store.ts';
import type { LocalAiRequest } from './local-ai-types.ts';

export type NodeCapabilities = { gpuModels: string[]; solarSensors: string[]; validatorIds: string[] };
export type NodeReading = { powerW: number | null; energyTodayKwh: number; timestamp: string; localDate?: string; timezone?: string };
export type NodeDailyTotal = { day: string; energyKwh: number; updatedAt: string; samples: number; firstReadingAt: string; endAt: number; timezone: string };
export type SolarAssignmentState = 'unassigned' | 'pending' | 'approved' | 'rejected' | 'paused';
export type SolarAnomaly = { day: string; energyKwh: number; ceilingKwh: number; detectedAt: string };
export type NodeRecord = { hostId: string; capabilities: NodeCapabilities | null; capabilityAt: number; readingAt: number; latestReading: NodeReading | null; dailyTotals: NodeDailyTotal[]; assignSolarToBuilding: boolean; solarAssignmentState?: SolarAssignmentState; peakCapacityKwp?: number | null; solarAnomaly?: SolarAnomaly | null; solarApprovedAt?: string | null; assignedAt: string | null; baselineDay: string | null; baselineKwh: number };
export const HOME_NODE_PREFIX = 'home-node:device:';
async function ready(store: Store, hostId: string) {
  const key = HOME_NODE_PREFIX + hostId;
  if (!await store.get(key)) {
    try { await store.create<NodeRecord>(key, { hostId, capabilities: null, capabilityAt: 0, readingAt: 0, latestReading: null, dailyTotals: [], assignSolarToBuilding: false, solarAssignmentState: 'unassigned', peakCapacityKwp: null, solarAnomaly: null, solarApprovedAt: null, assignedAt: null, baselineDay: null, baselineKwh: 0 }); }
    catch (error) { if (!await store.get(key)) throw error; }
  }
  return key;
}
export async function recordNodeCapabilities(store: Store, host: ConnectorHost, input: Record<string, unknown>, now = Date.now()) {
  if (Object.keys(input).some(key => !['gpuModels', 'solarSensors', 'validatorIds'].includes(key))) throw new WorkflowError('Unsupported capability field.');
  for (const [key, max] of [['gpuModels', 32], ['solarSensors', 16], ['validatorIds', 16]] as const) {
    const list = input[key];
    if (!Array.isArray(list) || list.length > max || list.some(value => typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)))
      throw new WorkflowError('Use bounded public capability identifiers, never credentials or URLs.');
  }
  const capabilities = input as NodeCapabilities;
  await store.update<NodeRecord>(await ready(store, host.id), row => {
    if (row.capabilityAt && now - row.capabilityAt < 30000) throw new ConflictError('Capabilities may be sent once per 30 seconds.');
    row.capabilities = { gpuModels: [...new Set(capabilities.gpuModels)], solarSensors: [...new Set(capabilities.solarSensors)], validatorIds: [...new Set(capabilities.validatorIds)] };
    row.capabilityAt = now;
    return row;
  });
  return { ok: true };
}
/** Solar counters use the device's local day; resolve its next midnight across timezone/DST offsets. */
export function nodeLocalDay(timestamp: string, timezone: string) {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw new WorkflowError('Choose a valid local IANA timezone.'); }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const nextMidnight = Date.parse(`${localDate}T00:00:00Z`) + 86400000;
  let endAt = nextMidnight;
  for (let attempt = 0; attempt < 4; attempt++) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(endAt)).map(part => [part.type, part.value]));
    const offset = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second)) - endAt;
    const resolved = nextMidnight - offset;
    if (resolved === endAt) break;
    endAt = resolved;
  }
  return { localDate, endAt };
}
export async function recordNodeReading(store: Store, host: ConnectorHost, input: Record<string, unknown>, now = Date.now()) {
  if (Object.keys(input).some(key => !['powerW', 'energyTodayKwh', 'timestamp', 'localDate', 'timezone'].includes(key)) ||
      !(input.powerW === null || typeof input.powerW === 'number' && Number.isFinite(input.powerW) && input.powerW >= 0 && input.powerW <= 1e9) ||
      typeof input.energyTodayKwh !== 'number' || !Number.isFinite(input.energyTodayKwh) || input.energyTodayKwh < 0 || input.energyTodayKwh > 1e6 ||
      typeof input.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(input.timestamp) || !Number.isFinite(Date.parse(input.timestamp)) || Math.abs(now - Date.parse(input.timestamp)) > 300000)
    throw new WorkflowError('Use finite solar readings with a fresh UTC timestamp.');
  const reading = input as NodeReading;
  const timezone = input.timezone === undefined ? 'UTC' : input.timezone;
  if (typeof timezone !== 'string' || timezone.length > 80) throw new WorkflowError('Choose a valid local IANA timezone.');
  const { localDate: day, endAt } = nodeLocalDay(reading.timestamp, timezone);
  if (input.localDate !== undefined && input.localDate !== day) throw new WorkflowError('Solar localDate must match its timestamp and timezone.');
  await store.update<NodeRecord>(await ready(store, host.id), row => {
    if (row.readingAt && now - row.readingAt < 30000) throw new ConflictError('Readings may be sent once per 30 seconds.');
    if (row.latestReading && Date.parse(reading.timestamp) <= Date.parse(row.latestReading.timestamp)) throw new ConflictError('Reading timestamps must increase.');
    if (row.latestReading?.timezone && row.latestReading.timezone !== timezone) throw new ConflictError('A paired solar node must keep the same timezone.');
    const existing = row.dailyTotals.find(entry => entry.day === day);
    if (existing && reading.energyTodayKwh < existing.energyKwh) throw new ConflictError('Daily solar energy must not decrease.');
    row.dailyTotals = row.dailyTotals.filter(entry => Date.parse(entry.updatedAt) >= now - 30 * 86400000 && entry.day !== day);
    row.dailyTotals.push({ day, energyKwh: reading.energyTodayKwh, updatedAt: reading.timestamp, samples: (existing?.samples ?? 0) + 1, firstReadingAt: existing?.firstReadingAt ?? reading.timestamp, endAt, timezone });
    if (row.peakCapacityKwp && reading.energyTodayKwh > Math.min(row.peakCapacityKwp * 8, 100)) {
      row.solarAnomaly = { day, energyKwh: reading.energyTodayKwh, ceilingKwh: Math.min(row.peakCapacityKwp * 8, 100), detectedAt: new Date(now).toISOString() };
      if (row.assignSolarToBuilding) row.solarAssignmentState = 'paused';
    }
    if (row.assignSolarToBuilding && row.assignedAt && row.readingAt <= Date.parse(row.assignedAt)) {
      row.baselineDay = day;
      row.baselineKwh = reading.energyTodayKwh;
    }
    row.latestReading = { powerW: reading.powerW, energyTodayKwh: reading.energyTodayKwh, timestamp: reading.timestamp, localDate: day, timezone };
    row.readingAt = now;
    return row;
  });
  return { ok: true };
}
export async function assignNodeSolar(store: Store, identity: VerifiedIdentity, hostId: string, assigned: boolean, peakCapacityKwp: number | null, now = Date.now()) {
  if (!(await ownedConnectorHosts(store, identity, now)).some(host => host.id === hostId)) throw new AccessError('Only the node owner may assign its solar.');
  if (assigned && (typeof peakCapacityKwp !== 'number' || !Number.isFinite(peakCapacityKwp) || peakCapacityKwp <= 0 || peakCapacityKwp > 1000)) throw new WorkflowError('Declare positive solar peak capacity in kWp (at most 1000).');
  const row = await store.update<NodeRecord>(await ready(store, hostId), row => {
    if (assigned !== row.assignSolarToBuilding || assigned && (row.peakCapacityKwp !== peakCapacityKwp || row.solarAssignmentState === 'rejected' || !row.solarAssignmentState)) {
      row.assignSolarToBuilding = assigned;
      row.peakCapacityKwp = assigned ? peakCapacityKwp : row.peakCapacityKwp ?? null;
      row.assignedAt = assigned ? new Date(now).toISOString() : null;
      row.solarAssignmentState = assigned ? 'pending' : 'unassigned';
      row.solarApprovedAt = null;
      row.baselineDay = nodeLocalDay(new Date(now).toISOString(), row.latestReading?.timezone ?? 'UTC').localDate;
      row.baselineKwh = row.latestReading?.localDate === row.baselineDay ? row.latestReading.energyTodayKwh : 0;
      const ceiling = assigned && peakCapacityKwp ? Math.min(peakCapacityKwp * 8, 100) : null;
      const anomalous = ceiling === null ? undefined : row.dailyTotals.find(total => total.energyKwh > ceiling);
      if (anomalous && ceiling !== null) {
        row.solarAnomaly = { day: anomalous.day, energyKwh: anomalous.energyKwh, ceilingKwh: ceiling, detectedAt: new Date(now).toISOString() };
        row.solarAssignmentState = 'paused';
      }
    }
    return row;
  });
  return { hostId, assignSolarToBuilding: assigned, solarAssignmentState: row.solarAssignmentState ?? 'unassigned', peakCapacityKwp: row.peakCapacityKwp ?? null };
}
/** Shared operator response whitelist: no measured kWh, local dates or detection timestamps. */
function operatorSolarSummary(row: NodeRecord | null) {
  const ceiling = row?.peakCapacityKwp ? Math.min(row.peakCapacityKwp * 8, 100) : null;
  return { assignSolarToBuilding: row?.assignSolarToBuilding ?? false, solarAssignmentState: row?.solarAssignmentState ?? (row?.assignSolarToBuilding ? 'pending' : 'unassigned'), peakCapacityKwp: row?.peakCapacityKwp ?? null, dailyProductionCeilingKwh: ceiling, aboveCeiling: Boolean(ceiling !== null && row?.dailyTotals.some(total => total.energyKwh > ceiling)), pausedForReview: row?.solarAssignmentState === 'paused' || Boolean(row?.solarAnomaly) };
}
export async function reviewNodeSolar(store: Store, identity: VerifiedIdentity, hostId: string, approved: boolean, now = Date.now()) {
  const hosts = await operatorConnectorHosts(store, identity, now);
  if (!hosts.some(host => host.hostId === hostId && (!approved || host.state === 'active'))) throw new AccessError('Choose a registered active solar node.');
  const key = HOME_NODE_PREFIX + hostId;
  if (!await store.get<NodeRecord>(key)) throw new WorkflowError('This node has no solar assignment.');
  const row = await store.update<NodeRecord>(key, row => {
    if (!row.assignSolarToBuilding || !row.peakCapacityKwp) throw new WorkflowError('The owner must declare capacity and assign solar before approval.');
    const ceiling = Math.min(row.peakCapacityKwp * 8, 100);
    const anomalous = row.dailyTotals.find(total => total.energyKwh > ceiling);
    if (approved && anomalous) throw new ConflictError('Production exceeds the declared daily ceiling; reject or request corrected capacity before approval.');
    row.solarAssignmentState = approved ? 'approved' : 'rejected';
    row.solarApprovedAt = approved ? new Date(now).toISOString() : null;
    if (approved) row.solarAnomaly = null;
    return row;
  });
  return { hostId, ...operatorSolarSummary(row) };
}
export async function operatorHomeNodes(store: Store, identity: VerifiedIdentity, now = Date.now()) {
  const hosts = await operatorConnectorHosts(store, identity, now);
  return { devices: await Promise.all(hosts.map(async host => {
    const row = await store.get<NodeRecord>(HOME_NODE_PREFIX + host.hostId);
    return { ...host, ...operatorSolarSummary(row) };
  })) };
}
export async function myHomeNodes(store: Store, identity: VerifiedIdentity, now = Date.now()) {
  const hosts = await ownedConnectorHosts(store, identity, now);
  const earnings = new Map(hosts.map(host => [host.id, { settledAnswers: 0, amountAtomic: '0', asset: null as string | null, receipts: [] as { txHash: string; amountAtomic: string; settledAt: string | null }[] }]));
  let after = '';
  for (;;) {
    const rows = await store.scan<{ request: LocalAiRequest; completedAt?: string }>('local-ai:request:', after, 100);
    for (const { value } of rows) {
      const request = value.request;
      const entry = request?.host && earnings.get(request.host.id);
      if (!entry || request.payment.state !== 'settled' || !request.payment.receipt?.success) continue;
      entry.settledAnswers++;
      entry.amountAtomic = (BigInt(entry.amountAtomic) + BigInt(request.payment.amountAtomic)).toString();
      entry.asset = request.review?.asset ?? entry.asset;
      if (request.payment.receipt.transaction) entry.receipts.push({ txHash: request.payment.receipt.transaction, amountAtomic: request.payment.amountAtomic, settledAt: value.completedAt ?? null });
    }
    if (rows.length < 100) break;
    after = rows[rows.length - 1].key;
  }
  const devices = await Promise.all(hosts.map(async host => {
    const row = await store.get<NodeRecord>(HOME_NODE_PREFIX + host.id);
    const cutoff = now - 30 * 86400000;
    const solarIncome: { day: string; energyKwh: number; amountAtomic: string; state: string; txHash: string | null }[] = [];
    let cursor = '';
    for (;;) {
      const page = await store.scan<{ day: string; energyKwh: number; amountAtomic: string; state: string; step: { hash?: string } }>(`building-income:mint:${host.id}:`, cursor, 100);
      solarIncome.push(...page.map(({ value }) => ({ day: value.day, energyKwh: value.energyKwh, amountAtomic: value.amountAtomic, state: value.state, txHash: value.step.hash ?? null })));
      if (page.length < 100) break;
      cursor = page[page.length - 1].key;
    }
    return { hostId: host.id, name: host.name, state: host.state, kind: host.kind, availability: host.availability, payoutWallet: host.payoutWallet, models: host.models, freePublicAnswers: host.freePublicAnswers === true, canSuspend: hostOperatorAllowed(identity) && host.kind === 'community', capabilities: row?.capabilities ?? null, latestReading: row?.latestReading && Date.parse(row.latestReading.timestamp) >= cutoff ? row.latestReading : null, dailyTotals: row?.dailyTotals.filter(entry => Date.parse(entry.updatedAt) >= cutoff) ?? [], assignSolarToBuilding: row?.assignSolarToBuilding ?? false, solarAssignmentState: row?.solarAssignmentState ?? (row?.assignSolarToBuilding ? 'pending' : 'unassigned'), peakCapacityKwp: row?.peakCapacityKwp ?? null, dailyProductionCeilingKwh: row?.peakCapacityKwp ? Math.min(row.peakCapacityKwp * 8, 100) : null, solarAnomaly: row?.solarAnomaly ?? null, earnings: earnings.get(host.id)!, solarIncome };
  }));
  return { devices, canPair: hostPairingAllowed(identity), isOperator: hostOperatorAllowed(identity) };
}
