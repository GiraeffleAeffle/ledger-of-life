import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  nonceManager,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';
import type { Store } from './store.ts';
import { operatorTestCapability } from './test-capability.ts';
import { referencePrice } from './reference-price.ts';

/**
 * Robinhood Chain TESTNET demo: a real on-chain rental escrow whose released earnings go to the
 * person's own EVM wallet, which can then buy Robinhood's official testnet TSLA Stock Token.
 * The stablecoin, yield vault and stock desk are our test contracts (no USDG/Morpho on testnet).
 */
const chain = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  testnet: true,
});
export const ROBINHOOD_TESTNET = {
  tsla: getAddress('0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E'),
  usd: getAddress('0xA6e10E426A738aEF586dB5191177658D67C78A14'),
  vault: getAddress('0xd7Cec2eB5830E4E8f3e48d0b7de7746650B5b060'),
  desk: getAddress('0x239213413AC090e7D7d9B0647A8d2197614710c4'),
};
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function mint(address,uint256)',
  'function transfer(address,uint256) returns (bool)',
]);
const vaultAbi = parseAbi(['function previewDeposit(uint256) view returns (uint256)', 'function accrue(uint256)']);
const deskAbi = parseAbi(['function buy(uint256,uint256) returns (uint256)', 'function quoteBuy(uint256) view returns (uint256)', 'function setPrice(uint256)', 'function price() view returns (uint256)']);
const escrowAbi = parseAbi([
  'function acceptAgreement(uint256,uint256)',
  'function fund(uint256,uint256)',
  'function supply(uint256,uint256,uint256,uint256)',
  'function releasableEarnings() view returns (uint256)',
  'function releaseEarnings(uint256,uint256,uint256,uint256)',
]);
const MAX = 2n ** 256n - 1n;
const client = createPublicClient({ chain, transport: http() });
const TSLAX_MAINNET = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';

export async function robinhoodEnabled(environment = process.env) {
  if (!operatorTestCapability(environment)) return false;
  try {
    await readFile(resolve(environment.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet', 'operator.key'));
    return true;
  } catch {
    return false;
  }
}

async function keys(environment = process.env) {
  const dir = resolve(environment.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet');
  // Local nonce tracking: the load-balanced testnet RPC can report a stale count between quick sends.
  const load = async (role: string) => privateKeyToAccount((await readFile(resolve(dir, `${role}.key`), 'utf8')).trim() as Hex, { nonceManager });
  const [operator, tenant, landlord, arbitrator] = await Promise.all(['operator', 'tenant', 'landlord', 'arbitrator'].map(load));
  return { operator, tenant, landlord, arbitrator };
}

export interface RobinhoodHoldings {
  address: Address;
  testUsdAtomic: string;
  tslaRaw: string;
  tslaShares: number;
  tslaValueUsd: number;
  ethBalance: string;
  referencePriceUsd: number;
  referencePriceObservedAt: string;
  referencePriceStale: boolean;
}

export async function robinhoodHoldings(owner: string): Promise<RobinhoodHoldings> {
  const address = getAddress(owner);
  const [usd, tsla, eth, price] = await Promise.all([
    client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'balanceOf', args: [address] }),
    client.readContract({ address: ROBINHOOD_TESTNET.tsla, abi: erc20, functionName: 'balanceOf', args: [address] }),
    client.getBalance({ address }),
    referencePrice(TSLAX_MAINNET),
  ]);
  const shares = Number(tsla) / 1e18;
  return {
    address, testUsdAtomic: usd.toString(), tslaRaw: tsla.toString(), tslaShares: shares,
    tslaValueUsd: Number((shares * price.usdPrice).toFixed(2)), ethBalance: formatEther(eth), referencePriceUsd: price.usdPrice,
    referencePriceObservedAt: price.observedAt, referencePriceStale: price.stale,
  };
}

/**
 * Runs a real testnet escrow with test signers whose `personalWallet` is the person's own EVM
 * wallet: fund 10 tUSDG → supply to the test vault → test yield → release earnings to that wallet.
 * Also tops up a little test ETH so the wallet can pay gas for its own purchase.
 */
export async function earnOnRobinhood(store: Store, personalWallet: string, environment = process.env) {
  if (!operatorTestCapability(environment) || !(await robinhoodEnabled(environment)))
    throw new Error('The Robinhood testnet demo is disabled.');
  const wallet = getAddress(personalWallet);
  // Reserve before any sends: a timeout or partial deployment must never fund another run.
  const key = `robinhood-earn:${wallet.toLowerCase()}`;
  type Job = { state: 'started' | 'done'; result?: { escrow: Address; releasedAtomic: string } };
  try {
    await store.create<Job>(key, { state: 'started' });
  } catch (error) {
    const existing = await store.get<Job>(key);
    if (!existing) throw error;
    if (existing.state === 'done' && existing.result) return existing.result;
    throw new Error('This testnet demo is already running or needs operator reconciliation.');
  }
  const people = await keys(environment);
  const as = (account: typeof people.operator) => createWalletClient({ chain, account, transport: http() });
  const [op, tenant, landlord] = [as(people.operator), as(people.tenant), as(people.landlord)];
  const wait = (hash: Hex) => client.waitForTransactionReceipt({ hash }).then((r) => {
    if (r.status !== 'success') throw new Error('A Robinhood testnet transaction failed.');
    return r;
  });
  const deadline = MAX;
  const security = 10_000_000n;
  const reserve = 10_000n;
  // Gas for everyone involved (tiny test ETH amounts from the operator).
  for (const target of [people.tenant.address, people.landlord.address, wallet]) {
    if ((await client.getBalance({ address: target })) < 100_000_000_000_000n)
      await wait(await op.sendTransaction({ to: target, value: 200_000_000_000_000n }));
  }
  const artifact = JSON.parse(await readFile(resolve('contracts/evm/out/RentalEscrow.sol/RentalEscrow.json'), 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };
  const deployHash = await op.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [{
      asset: ROBINHOOD_TESTNET.usd, vault: ROBINHOOD_TESTNET.vault, tenant: people.tenant.address, landlord: people.landlord.address,
      arbitrator: people.arbitrator.address, personalWallet: wallet, securityRequirement: security, fundingReserve: reserve,
      earningsReleaseAllowed: true, agreementHash: `0x${Buffer.from('ROBINHOOD TESTNET demo tenancy').toString('hex').padEnd(64, '0')}`,
    }],
  });
  const escrow = (await wait(deployHash)).contractAddress!;
  await wait(await tenant.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'mint', args: [people.tenant.address, security + reserve] }));
  await wait(await tenant.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'approve', args: [escrow, security + reserve] }));
  await wait(await tenant.writeContract({ address: escrow, abi: escrowAbi, functionName: 'acceptAgreement', args: [0n, deadline] }));
  await wait(await landlord.writeContract({ address: escrow, abi: escrowAbi, functionName: 'acceptAgreement', args: [1n, deadline] }));
  await wait(await tenant.writeContract({ address: escrow, abi: escrowAbi, functionName: 'fund', args: [2n, deadline] }));
  const idle = security + reserve;
  const shares = await client.readContract({ address: ROBINHOOD_TESTNET.vault, abi: vaultAbi, functionName: 'previewDeposit', args: [idle] });
  await wait(await tenant.writeContract({ address: escrow, abi: escrowAbi, functionName: 'supply', args: [idle, shares, 3n, deadline] }));
  // Test yield: real test assets enter the vault (stand-in for Morpho interest).
  const yieldAmount = 500_000n;
  await wait(await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'mint', args: [people.operator.address, yieldAmount] }));
  await wait(await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'approve', args: [ROBINHOOD_TESTNET.vault, yieldAmount] }));
  await wait(await op.writeContract({ address: ROBINHOOD_TESTNET.vault, abi: vaultAbi, functionName: 'accrue', args: [yieldAmount] }));
  // releasableEarnings() is an upper bound; vault withdrawals round shares up, so keep a 1 % margin
  // (the contract refuses any release that would leave the deposit short).
  const upperBound = await client.readContract({ address: escrow, abi: escrowAbi, functionName: 'releasableEarnings' });
  const releasable = (upperBound * 99n) / 100n;
  if (releasable === 0n) throw new Error('No earnings accrued yet.');
  await wait(await tenant.writeContract({ address: escrow, abi: escrowAbi, functionName: 'releaseEarnings', args: [releasable, MAX, 4n, deadline] }));
  // Keep the desk priced at a recent, non-stale TSLAx reference.
  const price = await referencePrice(TSLAX_MAINNET);
  if (price.stale) throw new Error('The TSLA reference price is temporarily unavailable. Try again shortly.');
  await wait(await op.writeContract({ address: ROBINHOOD_TESTNET.desk, abi: deskAbi, functionName: 'setPrice', args: [BigInt(Math.round(price.usdPrice * 1e6))] }));
  const result = { escrow, releasedAtomic: releasable.toString() };
  await store.update<Job>(key, () => ({ state: 'done', result }));
  return result;
}

/** Unsigned approve (if needed) + buy transactions for the person's own wallet to sign. */
export async function prepareRobinhoodBuy(owner: string) {
  const from = getAddress(owner);
  const balance = await client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'balanceOf', args: [from] });
  if (balance === 0n) throw new Error('No test USD on Robinhood Chain yet. Earn some first.');
  const minOut = await client.readContract({ address: ROBINHOOD_TESTNET.desk, abi: deskAbi, functionName: 'quoteBuy', args: [balance] });
  const allowance = await client.readContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'allowance', args: [from, ROBINHOOD_TESTNET.desk] });
  const fees = await client.estimateFeesPerGas();
  let nonce = await client.getTransactionCount({ address: from, blockTag: 'pending' });
  const calls: { to: Address; data: Hex; description: string }[] = [];
  if (allowance < balance)
    calls.push({ to: ROBINHOOD_TESTNET.usd, data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [ROBINHOOD_TESTNET.desk, balance] }), description: 'Allow the test desk to use your test USD' });
  calls.push({ to: ROBINHOOD_TESTNET.desk, data: encodeFunctionData({ abi: deskAbi, functionName: 'buy', args: [balance, minOut] }), description: 'Buy test TSLA with your earnings' });
  return calls.map((call) => ({
    description: call.description,
    transaction: {
      chainId: 46630 as const, to: call.to, data: call.data, value: '0x0',
      nonce: nonce++, gas: '0x' + (600_000).toString(16),
      maxFeePerGas: '0x' + (fees.maxFeePerGas! * 2n).toString(16),
      maxPriorityFeePerGas: '0x' + (fees.maxPriorityFeePerGas ?? 0n).toString(16),
    },
    spendAtomic: balance.toString(),
    minTslaRaw: minOut.toString(),
  }));
}

export async function submitRobinhoodTransaction(signed: string) {
  if (!/^0x[0-9a-fA-F]+$/.test(signed) || signed.length > 20_000) throw new Error('Invalid signed transaction.');
  const hash = await client.sendRawTransaction({ serializedTransaction: signed as Hex });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The Robinhood testnet transaction failed.');
  return { hash };
}
