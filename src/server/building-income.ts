import { randomUUID } from 'node:crypto';
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadBuildingManifest, verifyBuildingDeployment } from './building-revenue.ts';
import { connectorHosts } from './local-ai-hosts.ts';
import { HOME_NODE_PREFIX, type NodeDailyTotal, type NodeRecord } from './home-node.ts';
import { executeFundingStep, type SignedFundingStep } from './local-investment-provisioning.ts';
import { acquireOperatorNonceLane, releaseOperatorNonceLaneIfOwned } from './operator-nonce-lane.ts';
import { reviewedOperatorFees, reviewedOperatorGas } from './ownership-gas.ts';
import type { Store } from './store.ts';

const rpc = createPublicClient({ transport: http('https://rpc.testnet.chain.robinhood.com', { timeout: 15000, retryCount: 0 }) });
const mintAbi = parseAbi(['function mint(address to,uint256 amount)', 'function MAX_MINT() view returns (uint256)', 'function decimals() view returns (uint8)']);
export type BuildingIncomeJournal = { hostId: string; day: string; settlementDay: string; energyKwh: number; amountAtomic: string; signer: string; distributor: string; token: string; assignedAt: string; readingTimestamp: string; state: 'pending' | 'done' | 'cancelled'; simulated: true; step: SignedFundingStep };
type Health = { status: string; lastRunAt: string; reason?: string; minted?: number };
type Options = { environment?: Record<string, string | undefined>; now?: number; client?: typeof rpc; loadManifest?: typeof loadBuildingManifest; verifyManifest?: typeof verifyBuildingDeployment };
const HEALTH_KEY = 'building-income:health';
export function buildingIncomeConfig(environment: Record<string, string | undefined> = process.env) {
  const tariff = environment.BUILDING_INCOME_SOLAR_TARIFF || '0.08';
  const dailyCap = environment.BUILDING_INCOME_DAILY_CAP || '10';
  let incomeWallet: string | null = null;
  let valid = /^\d+(?:\.\d{1,6})?$/.test(tariff) && /^\d+(?:\.\d{1,6})?$/.test(dailyCap);
  if (environment.BUILDING_INCOME_PRIVATE_KEY) {
    try { incomeWallet = privateKeyToAccount(environment.BUILDING_INCOME_PRIVATE_KEY as Hex).address; }
    catch { valid = false; }
  }
  return { configured: Boolean(incomeWallet && valid), incomeWallet, simulated: true, tariff: valid ? tariff : null, dailyCap: valid ? dailyCap : null };
}
export async function buildingIncomeStatus(store: Store, now = Date.now()) {
  const health = await store.get<Health>(HEALTH_KEY);
  const config = buildingIncomeConfig();
  return { ...config, health: { ...health, state: !config.configured ? 'unconfigured' : !health || now - Date.parse(health.lastRunAt) > 3600000 || health.status === 'failed' ? 'attention' : 'healthy' } };
}
export async function buildingIncomeJournals(store: Store) {
  const journals: BuildingIncomeJournal[] = [];
  let after = '';
  for (;;) {
    const rows = await store.scan<BuildingIncomeJournal>('building-income:mint:', after, 100);
    journals.push(...rows.map(row => row.value));
    if (rows.length < 100) return journals;
    after = rows[rows.length - 1].key;
  }
}
async function recordHealth(store: Store, value: Health) {
  if (await store.get(HEALTH_KEY)) await store.update<Health>(HEALTH_KEY, () => value);
  else { try { await store.create(HEALTH_KEY, value); } catch { await store.update<Health>(HEALTH_KEY, () => value); } }
}
export async function reconcileBuildingIncome(store: Store, options: Options = {}) {
  const now = options.now ?? Date.now();
  const token = randomUUID();
  const lockKey = 'building-income:lease';
  type Lease = { token: string; until: number };
  try { await store.create<Lease>(lockKey, { token: '', until: 0 }); } catch (error) { if (!await store.get(lockKey)) throw error; }
  let acquired = false;
  await store.update<Lease>(lockKey, row => {
    if (row.until > now) return row;
    acquired = true;
    return { token, until: now + 600000 };
  });
  if (!acquired) return { status: 'skipped', reason: 'Income job already running.', nextCursor: null };
  try {
    const result = await reconcile(store, options, async () => {
      await store.update<Lease>(lockKey, row => {
        if (row.token !== token) throw new Error('Income job lease changed before transaction persistence.');
        return { token, until: (options.now ?? Date.now()) + 600000 };
      });
    });
    await recordHealth(store, { status: result.status, reason: 'reason' in result ? result.reason : undefined, minted: 'minted' in result ? result.minted : undefined, lastRunAt: new Date(now).toISOString() });
    return result;
  } catch (error) {
    await recordHealth(store, { status: 'failed', reason: 'Simulated income reconciliation failed; operator must inspect the job log.', lastRunAt: new Date(now).toISOString() });
    throw error;
  } finally { await store.update<Lease>(lockKey, row => row.token === token ? { token: '', until: 0 } : row); }
}
function settleableDay(node: NodeRecord, total: NodeDailyTotal, now: number) {
  if (!node.assignSolarToBuilding || node.solarAssignmentState !== 'approved' || node.solarAnomaly || !node.peakCapacityKwp || total.energyKwh > Math.min(node.peakCapacityKwp * 8, 100) || !node.assignedAt || !node.capabilities?.solarSensors.length || total.samples < 3 || !Number.isFinite(total.endAt) || Date.parse(total.updatedAt) < now - 30 * 86400000 || total.endAt <= Date.parse(node.assignedAt) || Date.parse(total.updatedAt) < Date.parse(node.assignedAt)) return false;
  const latestDay = node.latestReading?.localDate ?? node.latestReading?.timestamp.slice(0, 10);
  return Boolean(latestDay && latestDay > total.day) || now > total.endAt + 3600000;
}
async function reconcile(store: Store, options: Options, ownsLease: () => Promise<void>) {
  const environment = options.environment ?? process.env;
  const now = options.now ?? Date.now();
  const settlementDay = new Date(now).toISOString().slice(0, 10);
  const cutoff = now - 30 * 86400000;
  const nodes: { key: string; value: NodeRecord }[] = [];
  let cursor = '';
  for (;;) {
    const page = await store.scan<NodeRecord>(HOME_NODE_PREFIX, cursor, 100);
    nodes.push(...page);
    if (page.length < 100) break;
    cursor = page[page.length - 1].key;
  }
  for (const { key } of nodes) await store.update<NodeRecord>(key, row => ({ ...row, dailyTotals: row.dailyTotals.filter(entry => Date.parse(entry.updatedAt) >= cutoff), latestReading: row.latestReading && Date.parse(row.latestReading.timestamp) >= cutoff ? row.latestReading : null }));
  await store.reclaim?.();
  const config = buildingIncomeConfig(environment);
  if (!config.configured || !config.tariff || !config.dailyCap) return { status: 'unconfigured', reason: 'Dedicated income key or valid tariff/cap is missing.', nextCursor: null };
  const signer = privateKeyToAccount(environment.BUILDING_INCOME_PRIVATE_KEY as Hex);
  const manifest = await (options.loadManifest ?? loadBuildingManifest)();
  if (!manifest?.distributor) return { status: 'unconfigured', reason: 'Building distributor is not deployed.', nextCursor: null };
  if (manifest.chainId !== 46630) throw new Error('Income is testnet only (46630).');
  const client = options.client ?? rpc;
  if (await client.getChainId() !== 46630) throw new Error('Income RPC chain mismatch.');
  await (options.verifyManifest ?? verifyBuildingDeployment)(manifest);
  if (await client.readContract({ address: manifest.payoutToken, abi: mintAbi, functionName: 'decimals' }) !== 6) throw new Error('Simulated income requires six-decimal tUSDG.');
  const maxMint = await client.readContract({ address: manifest.payoutToken, abi: mintAbi, functionName: 'MAX_MINT' });
  const cap = parseUnits(config.dailyCap, 6);
  const tariff = parseUnits(config.tariff, 6);
  const journals = await buildingIncomeJournals(store);
  let used = journals.filter(row => row.settlementDay === settlementDay && row.state !== 'cancelled').reduce((sum, row) => sum + BigInt(row.amountAtomic), 0n);
  let minted = 0;
  const active = new Set((await connectorHosts(store, now)).map(host => host.id));
  const finish = async (key: string, journal: BuildingIncomeJournal) => {
    if (journal.signer !== signer.address || journal.distributor !== manifest.distributor || journal.token !== manifest.payoutToken) throw new Error('Income journal configuration changed.');
    await acquireOperatorNonceLane(store, signer.address, key);
    const data = encodeFunctionData({ abi: mintAbi, functionName: 'mint', args: [manifest.distributor, BigInt(journal.amountAtomic)] });
    await executeFundingStep(journal.step, async () => {
      const [nonce, fees, gas] = await Promise.all([client.getTransactionCount({ address: signer.address, blockTag: 'pending' }), client.estimateFeesPerGas(), client.estimateGas({ account: signer.address, to: manifest.payoutToken, data })]);
      if (await client.getChainId() !== 46630) throw new Error('Income RPC changed before signing.');
      const signingNow = options.now ?? Date.now();
      const current = await store.get<NodeRecord>(HOME_NODE_PREFIX + journal.hostId);
      const total = current?.dailyTotals.find(entry => entry.day === journal.day);
      if (!current || current.assignedAt !== journal.assignedAt || !total || !settleableDay(current, total, signingNow) || !(await connectorHosts(store, signingNow)).some(host => host.id === journal.hostId))
        throw new Error('Solar assignment or completed-day evidence changed before signing.');
      return signer.signTransaction({ type: 'eip1559', chainId: 46630, nonce, to: manifest.payoutToken, data, value: 0n, gas: reviewedOperatorGas(gas, 'transfer'), ...reviewedOperatorFees(fees) });
    }, async () => { await ownsLease(); await store.update<BuildingIncomeJournal>(key, existing => {
      if (existing.step.signed && existing.step.signed !== journal.step.signed) throw new Error('Income signed journal may not be replaced.');
      return journal;
    }); }, client);
    await store.update<BuildingIncomeJournal>(key, row => ({ ...row, state: 'done' }));
    await releaseOperatorNonceLaneIfOwned(store, signer.address, key);
    minted++;
  };
  // Signed-byte recovery is independent of retained readings; unsigned work still needs its completed-day evidence.
  for (const journal of journals.filter(row => row.state === 'pending')) {
    const key = `building-income:mint:${journal.hostId}:${journal.day}`;
    if (!journal.step.signed) {
      const node = await store.get<NodeRecord>(HOME_NODE_PREFIX + journal.hostId);
      const total = node?.dailyTotals.find(entry => entry.day === journal.day);
      if (!active.has(journal.hostId) || !node || node.assignedAt !== journal.assignedAt || !total || !settleableDay(node, total, now)) {
        await store.update<BuildingIncomeJournal>(key, row => ({ ...row, state: 'cancelled' }));
        if (journal.settlementDay === settlementDay) used -= BigInt(journal.amountAtomic);
        await releaseOperatorNonceLaneIfOwned(store, signer.address, key);
        continue;
      }
    }
    await finish(key, journal);
  }
  for (const { value: node } of nodes) {
    if (!active.has(node.hostId)) continue;
    for (const total of node.dailyTotals) {
      if (!settleableDay(node, total, now)) continue;
      const key = `building-income:mint:${node.hostId}:${total.day}`;
      if (await store.get(key)) continue;
      const energyKwh = Math.max(0, total.energyKwh - (node.baselineDay === total.day ? node.baselineKwh : 0));
      let amount = BigInt(Math.floor(energyKwh * 1000000)) * tariff / 1000000n;
      amount = amount > maxMint ? maxMint : amount;
      amount = amount > cap - used ? cap - used : amount;
      if (amount <= 0n) continue;
      const journal: BuildingIncomeJournal = { hostId: node.hostId, day: total.day, settlementDay, energyKwh, amountAtomic: amount.toString(), signer: signer.address, distributor: manifest.distributor, token: manifest.payoutToken, assignedAt: node.assignedAt!, readingTimestamp: total.updatedAt, state: 'pending', simulated: true, step: {} };
      await ownsLease();
      // The durable journal reserves this node/local-day before any signed bytes exist.
      await store.create(key, journal);
      used += amount;
      await finish(key, journal);
    }
  }
  return { status: 'checked', minted, nextCursor: null };
}
