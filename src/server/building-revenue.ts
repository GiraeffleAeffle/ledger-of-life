import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, formatUnits, getAddress, http, keccak256, parseAbi, parseAbiItem, type Address, type Hex } from 'viem';
import investments from '../../contracts/evm/deployments/local-investments-46630.json' with { type: 'json' };
import type { Store } from './store.ts';
import { attributeBuildingIncome, rentPaymentEvidence, type BuildingInflow, type IncomeEvidence } from './building-revenue-attribution.ts';
import type { LocalAiRequest } from './local-ai-types.ts';
import { buildingIncomeJournals } from './building-income.ts';
import { connectorHosts } from './local-ai-hosts.ts';
import type { RentPayment } from './rent-payments.ts';

export const BUILDING_ABI = parseAbi([
  'function payoutToken() view returns (address)',
  'function unitToken() view returns (address)',
  'function totalStaked() view returns (uint256)',
  'function stakedOf(address account) view returns (uint256)',
  'function rewardPerUnit() view returns (uint256)',
  'function earned(address account) view returns (uint256)',
  'function pendingRevenue() view returns (uint256)',
  'function rewardDuration() view returns (uint256)',
  'function rewardScale() view returns (uint256)',
  'function rewardRate() view returns (uint256)',
  'function periodFinish() view returns (uint256)',
  'function lastUpdateTime() view returns (uint256)',
  'function streamRemainingScaled() view returns (uint256)',
  'function undistributedScaled() view returns (uint256)',
  'function rewardRemainderScaled() view returns (uint256)',
]);
export const buildingRpc = createPublicClient({
  transport: http('https://rpc.testnet.chain.robinhood.com', { timeout: 15000, retryCount: 0 }),
});
export type BuildingRpc = Pick<typeof buildingRpc,
  'getChainId' | 'getCode' | 'readContract' | 'getBlockNumber' | 'getLogs' | 'getTransactionReceipt' |
  'getTransactionCount' | 'estimateFeesPerGas' | 'estimateGas' | 'sendRawTransaction' | 'waitForTransactionReceipt' | 'getBalance'>;
export type BuildingManifest = {
  version: number; chainId: number; status: string; distributor: Address | null;
  payoutToken: Address; unitToken: Address; deploymentBlock: string | number | null;
  runtimeCodeHash: Hex | null; dependencyCodeHashes: Record<string, Hex>;
  rewardsSpec: { scheme: string; scale: string };
  rewardDuration: number;
};
export type BuildingReadOptions = { loadManifest?: () => Promise<BuildingManifest | null>; rpc?: BuildingRpc };
export const explorerUrl = 'https://explorer.testnet.chain.robinhood.com';
const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const staked = parseAbiItem('event Staked(address indexed account,uint256 amount)');
const unstaked = parseAbiItem('event Unstaked(address indexed account,uint256 amount)');

export async function loadBuildingManifest(): Promise<BuildingManifest | null> {
  try {
    const manifest = JSON.parse(await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ process.cwd(),
      'contracts/evm/deployments/building-revenue-46630.json'), 'utf8')) as BuildingManifest;
    if (manifest.version !== 3 || manifest.chainId !== 46630 || manifest.rewardDuration !== 604800 ||
        manifest.rewardsSpec?.scheme !== 'staking_stream_v1' || manifest.rewardsSpec.scale !== '1000000000000000000000000000000000000' ||
        getAddress(manifest.payoutToken) !== getAddress(investments.cashAddress) ||
        getAddress(manifest.unitToken) !== getAddress(investments.assets['demo-neighbourhood-homes'].unitAddress))
      throw new Error('Building manifest is not the reviewed seven-day tHOME revenue stream.');
    if (!manifest.distributor || manifest.status !== 'deployed') return null;
    if (!manifest.runtimeCodeHash || manifest.deploymentBlock === null)
      throw new Error('Building manifest lacks deployment pins.');
    return { ...manifest, distributor: getAddress(manifest.distributor) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function verifyBuildingDeployment(manifest: BuildingManifest, rpc: BuildingRpc = buildingRpc) {
  if (manifest.version !== 3 || !manifest.distributor || await rpc.getChainId() !== 46630)
    throw new Error('Building staking requires Robinhood testnet chain 46630.');
  const [code, payoutCode, unitCode, payout, unit, duration, scale] = await Promise.all([
    rpc.getCode({ address: manifest.distributor }), rpc.getCode({ address: manifest.payoutToken }),
    rpc.getCode({ address: manifest.unitToken }),
    rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'payoutToken' }),
    rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'unitToken' }),
    rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'rewardDuration' }),
    rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'rewardScale' }),
  ]);
  if (!code || !payoutCode || !unitCode || keccak256(code) !== manifest.runtimeCodeHash ||
      keccak256(payoutCode) !== manifest.dependencyCodeHashes.payoutToken ||
      keccak256(unitCode) !== manifest.dependencyCodeHashes.unitToken ||
      getAddress(payout) !== getAddress(manifest.payoutToken) || getAddress(unit) !== getAddress(manifest.unitToken) ||
      duration !== BigInt(manifest.rewardDuration) || scale !== BigInt(manifest.rewardsSpec.scale))
    throw new Error('Building runtime or immutable dependencies do not match the public manifest.');
}

export async function readBuildingView(store: Store, options: BuildingReadOptions = {}) {
  const manifest = await (options.loadManifest ?? loadBuildingManifest)();
  const rpc = options.rpc ?? buildingRpc;
  const revenueTransactions: BuildingInflow[] = [];
  const incomeEvidence: IncomeEvidence[] = [];
  let totalStaked = 0n, rewardPerUnit = 0n, pendingRevenue = 0n, undistributedScaled = 0n;
  let rewardRate = 0n, periodFinish = 0n, lastUpdateTime = 0n, streamRemainingScaled = 0n, rewardRemainderScaled = 0n;
  let payingDevices: { name: string; kind: 'operator' | 'community'; availability: 'online' | 'asleep' | 'offline' }[] = [];
  const balances = new Map<Address, bigint>();
  if (manifest?.distributor) {
    await verifyBuildingDeployment(manifest, rpc);
    const tip = await rpc.getBlockNumber(), snapshot = tip > 3n ? tip - 3n : 0n;
    [totalStaked, rewardPerUnit, pendingRevenue, undistributedScaled, rewardRate, periodFinish, lastUpdateTime, streamRemainingScaled, rewardRemainderScaled] = await Promise.all([
      rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'totalStaked', blockNumber: snapshot }),
      rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'rewardPerUnit', blockNumber: snapshot }),
      rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'pendingRevenue', blockNumber: snapshot }),
      rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'undistributedScaled', blockNumber: snapshot }),
      rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'rewardRate', blockNumber: snapshot }),
      rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'periodFinish', blockNumber: snapshot }),
      rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'lastUpdateTime', blockNumber: snapshot }),
      rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'streamRemainingScaled', blockNumber: snapshot }),
      rpc.readContract({ address: manifest.distributor, abi: BUILDING_ABI, functionName: 'rewardRemainderScaled', blockNumber: snapshot }),
    ]);
    for (let start = BigInt(manifest.deploymentBlock!); start <= snapshot; start += 10000n) {
      const toBlock = start + 9999n < snapshot ? start + 9999n : snapshot;
      const [receipts, stakes, withdrawals] = await Promise.all([
        rpc.getLogs({ address: manifest.payoutToken, event: transfer, args: { to: manifest.distributor }, fromBlock: start, toBlock, strict: true }),
        rpc.getLogs({ address: manifest.distributor, event: staked, fromBlock: start, toBlock, strict: true }),
        rpc.getLogs({ address: manifest.distributor, event: unstaked, fromBlock: start, toBlock, strict: true }),
      ]);
      for (const receipt of receipts) {
        if (receipt.removed) throw new Error('Removed building revenue transfer.');
        revenueTransactions.push({ transactionHash: receipt.transactionHash, logIndex: receipt.logIndex, from: receipt.args.from,
          blockNumber: receipt.blockNumber.toString(), amountRaw: receipt.args.value.toString(), explorerUrl: `${explorerUrl}/tx/${receipt.transactionHash}` });
      }
      for (const event of stakes) {
        if (event.removed) throw new Error('Removed building staking event.');
        const account = getAddress(event.args.account);
        balances.set(account, (balances.get(account) ?? 0n) + event.args.amount);
      }
      for (const event of withdrawals) {
        if (event.removed) throw new Error('Removed building withdrawal event.');
        const account = getAddress(event.args.account);
        balances.set(account, (balances.get(account) ?? 0n) - event.args.amount);
      }
    }
    if ([...balances.values()].some(balance => balance < 0n) ||
        [...balances.values()].reduce((sum, balance) => sum + balance, 0n) !== totalStaked)
      throw new Error('Building staking history does not match confirmed total stake.');
  }
  // The retained schema attributes paid work, not all physical GPU usage or energy consumption.
  let cursor = '', gpuTokensServed = 0, paidAnswers = 0, runtimeMs = 0, knownRuntime = false;
  if (manifest?.distributor) {
    do {
      const rows = await store.scan<{ request: LocalAiRequest }>('local-ai:request:', cursor, 500);
      for (const row of rows) {
        cursor = row.key;
        const request = row.value.request;
        if (request.state !== 'completed' || request.payment.state !== 'settled' ||
            request.review?.payTo.toLowerCase() !== manifest.distributor.toLowerCase()) continue;
        paidAnswers++;
        if (request.payment.receipt?.transaction) incomeEvidence.push({
          transactionHash: request.payment.receipt.transaction, amountRaw: request.payment.amountAtomic, kind: 'gpu',
          hostId: request.host?.id ?? 'direct', hostName: request.host?.name ?? 'Operator direct host',
        });
        gpuTokensServed += request.usage?.outputTokens ?? 0;
        if (request.usage) { runtimeMs += request.usage.wallMs; knownRuntime = true; }
      }
      if (rows.length < 500) break;
    } while (true);
  }
  if (manifest?.distributor) {
    let rentCursor = '';
    do {
      const rows = await store.scan<RentPayment>('rent-payment:', rentCursor, 500);
      incomeEvidence.push(...rentPaymentEvidence(rows.map(row => row.value), { distributor: manifest.distributor, payoutToken: manifest.payoutToken }));
      if (rows.length < 500) break;
      rentCursor = rows[rows.length - 1].key;
    } while (true);
    const [journals, hosts] = await Promise.all([buildingIncomeJournals(store), connectorHosts(store)]);
    payingDevices = hosts.filter(host => host.payoutWallet?.toLowerCase() === manifest.distributor!.toLowerCase())
      .map(host => ({ name: host.name, kind: host.kind ?? 'community', availability: host.availability }));
    for (const journal of journals) {
      if (journal.state !== 'done' || !journal.step.hash ||
          journal.distributor.toLowerCase() !== manifest.distributor.toLowerCase() ||
          journal.token.toLowerCase() !== manifest.payoutToken.toLowerCase()) continue;
      incomeEvidence.push({ transactionHash: journal.step.hash, amountRaw: journal.amountAtomic, kind: 'solar',
        hostId: journal.hostId, hostName: hosts.find(host => host.id === journal.hostId)?.name ?? journal.hostId });
    }
  }
  const revenueRaw = revenueTransactions.reduce((sum, row) => sum + BigInt(row.amountRaw), 0n).toString();
  const attributed = attributeBuildingIncome(revenueTransactions, incomeEvidence);
  return {
    configured: Boolean(manifest), status: manifest ? 'configured' : 'unconfigured',
    reason: manifest ? null : 'Building staking distributor is not deployed.', chainId: 46630,
    distributor: manifest?.distributor ?? null, explorerUrl,
    payingDevices,
    shareToken: manifest?.unitToken ?? investments.assets['demo-neighbourhood-homes'].unitAddress,
    assetToken: manifest?.payoutToken ?? investments.cashAddress, revenueRaw, revenue: formatUnits(BigInt(revenueRaw), 6),
    totalStakedRaw: totalStaked.toString(), totalStaked: formatUnits(totalStaked, 18), rewardPerUnitRaw: rewardPerUnit.toString(),
    pendingRevenueRaw: pendingRevenue.toString(), undistributedScaledRaw: undistributedScaled.toString(),
    rewardDuration: manifest?.rewardDuration ?? 604800, rewardScaleRaw: manifest?.rewardsSpec.scale ?? '1000000000000000000000000000000000000',
    rewardRateRaw: rewardRate.toString(), periodFinish: Number(periodFinish), lastUpdateTime: Number(lastUpdateTime),
    streamRemainingScaledRaw: streamRemainingScaled.toString(), rewardRemainderScaledRaw: rewardRemainderScaled.toString(),
    stakerCount: [...balances.values()].filter(balance => balance > 0n).length, gpuTokensServed, paidAnswers,
    revenueTransactions: attributed.transactions, incomeSources: attributed.sources,
    validator: null, heat: { runtimeSeconds: knownRuntime ? runtimeMs / 1000 : null, nominalPowerWatts: null, measuredWhPerToken: null },
  };
}
