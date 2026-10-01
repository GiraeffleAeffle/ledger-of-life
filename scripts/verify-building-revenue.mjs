#!/usr/bin/env node
// Read-only: node scripts/verify-building-revenue.mjs [--account 0x...]
// No private keys, signing, broadcasting, synchronization or host payout changes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicClient, getAddress, http, keccak256, parseAbi, parseAbiItem } from 'viem';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--account'))
  throw new Error('Usage: node scripts/verify-building-revenue.mjs [--account 0x...]');
const account = args.length ? getAddress(args[1]) : null;
const manifest = JSON.parse(await readFile(new URL('../contracts/evm/deployments/building-revenue-46630.json', import.meta.url), 'utf8'));
assert.equal(manifest.version, 3); assert.equal(manifest.chainId, 46630); assert.equal(manifest.rewardDuration, 604800);
assert.equal(manifest.rewardsSpec.scheme, 'staking_stream_v1');
assert.equal(manifest.rewardsSpec.scale, '1000000000000000000000000000000000000');
if (!manifest.distributor || manifest.status !== 'deployed') {
  console.log('UNCONFIGURED: building staking distributor is not deployed. No stake or rewards exist to verify.');
  process.exit(0);
}
const rpc = createPublicClient({ transport: http(process.env.ROBINHOOD_TESTNET_RPC_URL || 'https://rpc.testnet.chain.robinhood.com') });
assert.equal(await rpc.getChainId(), 46630, 'RPC chain');
const abi = parseAbi([
  'function payoutToken() view returns (address)', 'function unitToken() view returns (address)',
  'function totalStaked() view returns (uint256)', 'function stakedOf(address) view returns (uint256)',
  'function earned(address) view returns (uint256)', 'function accounted() view returns (uint256)',
  'function pendingRevenue() view returns (uint256)', 'function rewardPerUnit() view returns (uint256)',
  'function undistributedScaled() view returns (uint256)',
  'function rewardDuration() view returns (uint256)', 'function rewardScale() view returns (uint256)',
  'function rewardRate() view returns (uint256)', 'function periodFinish() view returns (uint256)',
  'function lastUpdateTime() view returns (uint256)', 'function streamRemainingScaled() view returns (uint256)',
  'function rewardRemainderScaled() view returns (uint256)',
]);
const token = parseAbi(['function balanceOf(address) view returns (uint256)']);
const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const staked = parseAbiItem('event Staked(address indexed account,uint256 amount)');
const unstaked = parseAbiItem('event Unstaked(address indexed account,uint256 amount)');
for (const [address, hash] of [[manifest.distributor, manifest.runtimeCodeHash], [manifest.payoutToken, manifest.dependencyCodeHashes.payoutToken], [manifest.unitToken, manifest.dependencyCodeHashes.unitToken]]) {
  const code = await rpc.getCode({ address }); assert(code); assert.equal(keccak256(code), hash, 'Runtime pin');
}
assert.equal(getAddress(await rpc.readContract({ address: manifest.distributor, abi, functionName: 'payoutToken' })), getAddress(manifest.payoutToken));
assert.equal(getAddress(await rpc.readContract({ address: manifest.distributor, abi, functionName: 'unitToken' })), getAddress(manifest.unitToken));
assert.equal(await rpc.readContract({ address: manifest.distributor, abi, functionName: 'rewardDuration' }), BigInt(manifest.rewardDuration));
assert.equal(await rpc.readContract({ address: manifest.distributor, abi, functionName: 'rewardScale' }), BigInt(manifest.rewardsSpec.scale));
const tip = await rpc.getBlockNumber(), snapshot = tip > 3n ? tip - 3n : 0n;
const balances = new Map();
let revenue = 0n;
const revenueTransactions = [];
for (let start = BigInt(manifest.deploymentBlock); start <= snapshot; start += 2000n) {
  const toBlock = start + 1999n < snapshot ? start + 1999n : snapshot;
  const [incoming, deposits, withdrawals] = await Promise.all([
    rpc.getLogs({ address: manifest.payoutToken, event: transfer, args: { to: manifest.distributor }, fromBlock: start, toBlock, strict: true }),
    rpc.getLogs({ address: manifest.distributor, event: staked, fromBlock: start, toBlock, strict: true }),
    rpc.getLogs({ address: manifest.distributor, event: unstaked, fromBlock: start, toBlock, strict: true }),
  ]);
  for (const event of incoming) { assert(!event.removed); revenue += event.args.value; revenueTransactions.push(event.transactionHash); }
  for (const event of deposits) { assert(!event.removed); const key = getAddress(event.args.account); balances.set(key, (balances.get(key) ?? 0n) + event.args.amount); }
  for (const event of withdrawals) { assert(!event.removed); const key = getAddress(event.args.account); balances.set(key, (balances.get(key) ?? 0n) - event.args.amount); }
}
const read = (functionName) => rpc.readContract({ address: manifest.distributor, abi, functionName, blockNumber: snapshot });
const [totalStaked, accounted, pendingRevenue, rewardPerUnit, undistributedScaled, payoutBalance, unitBalance] = await Promise.all([
  read('totalStaked'), read('accounted'), read('pendingRevenue'), read('rewardPerUnit'), read('undistributedScaled'),
  rpc.readContract({ address: manifest.payoutToken, abi: token, functionName: 'balanceOf', args: [manifest.distributor], blockNumber: snapshot }),
  rpc.readContract({ address: manifest.unitToken, abi: token, functionName: 'balanceOf', args: [manifest.distributor], blockNumber: snapshot }),
]);
assert([...balances.values()].every(balance => balance >= 0n));
assert.equal([...balances.values()].reduce((sum, balance) => sum + balance, 0n), totalStaked, 'Event-reconstructed stake');
assert(unitBalance >= totalStaked, 'Unit custody coverage'); assert(payoutBalance >= accounted, 'Reward backing');
assert.equal(pendingRevenue, payoutBalance - accounted, 'Pending incoming revenue');
const [rewardRate, periodFinish, lastUpdateTime, streamRemainingScaled, rewardRemainderScaled] = await Promise.all([
  read('rewardRate'), read('periodFinish'), read('lastUpdateTime'), read('streamRemainingScaled'), read('rewardRemainderScaled'),
]);
const own = account ? {
  account, stakedRaw: (await rpc.readContract({ address: manifest.distributor, abi, functionName: 'stakedOf', args: [account], blockNumber: snapshot })).toString(),
  earnedRaw: (await rpc.readContract({ address: manifest.distributor, abi, functionName: 'earned', args: [account], blockNumber: snapshot })).toString(),
} : null;
console.log(JSON.stringify({ status: 'verified', readOnly: true, chainId: 46630, distributor: manifest.distributor,
  snapshotBlock: snapshot.toString(), revenueRaw: revenue.toString(), revenueTransactions, totalStakedRaw: totalStaked.toString(),
  stakerCount: [...balances.values()].filter(balance => balance > 0n).length, rewardPerUnitRaw: rewardPerUnit.toString(),
  pendingRevenueRaw: pendingRevenue.toString(), undistributedScaled: undistributedScaled.toString(), own,
  rewardDuration: manifest.rewardDuration, rewardScaleRaw: manifest.rewardsSpec.scale, rewardRateRaw: rewardRate.toString(),
  periodFinish: Number(periodFinish), lastUpdateTime: Number(lastUpdateTime), streamRemainingScaledRaw: streamRemainingScaled.toString(),
  rewardRemainderScaledRaw: rewardRemainderScaled.toString(),
  limitations: 'Fictional testnet units have no value or rights. Revenue streams to actual stakers over seven days; incoming receipts are not instantly claimable.' }, null, 2));
