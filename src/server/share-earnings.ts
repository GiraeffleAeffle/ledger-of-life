import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, encodePacked, getAddress, http,
  keccak256, nonceManager, parseAbi, parseTransaction, recoverTransactionAddress, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Store } from './store.ts';
import { ROBINHOOD_TESTNET } from './robinhood-demo.ts';
import { operatorTestCapability } from './test-capability.ts';
import { readShareWorkflows, startShareMarket } from './share-workflows.ts';

const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const rpc = createPublicClient({ chain, transport: http() });
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function mint(address,uint256)']);
const vault = parseAbi(['function previewDeposit(uint256) view returns (uint256)', 'function accrue(uint256)']);
const escrowAbi = parseAbi([
  'function state() view returns (uint8)', 'function nonce() view returns (uint256)', 'function trackedShares() view returns (uint256)',
  'function releasedEarnings() view returns (uint256)', 'function releasableEarnings() view returns (uint256)',
  'function acceptAgreement(uint256,uint256)', 'function fund(uint256,uint256)',
  'function supply(uint256,uint256,uint256,uint256)', 'function releaseEarnings(uint256,uint256,uint256,uint256)',
]);
const SECURITY = 1_500_000_000n;
const RESERVE = 1_000_000n;
const DEMO_PURCHASE_FAUCET = 3_540_000_000n;
const YIELD = 60_500_000n;
const MAX_YIELDS_PER_DAY = 3;
const MAX = 2n ** 256n - 1n;
type EarningsRecord = { status: 'ready'; escrow: Address; vault?: Address; securityAtomic?: string; previousEscrow?: Address; purchaseFaucetDone?: boolean; yieldDay?: string; yieldCount?: number; yieldDone?: boolean; yieldPending?: boolean; transactionHashes: Hex[] };
type Starting = { status: 'starting' };
const recordKey = (wallet: Address) => `share-earnings:${wallet.toLowerCase()}`;
const today = () => new Date().toISOString().slice(0, 10);
const yieldsToday = (entry: EarningsRecord) => entry.yieldDay === today() ? (entry.yieldCount ?? 0) : entry.yieldDone ? 1 : 0;

async function record(store: Store, owner: Address): Promise<EarningsRecord | null> {
  const value = await store.get<EarningsRecord | Starting>(recordKey(owner));
  if (value?.status === 'starting') throw new Error('Your earnings deposit is being prepared; wait for testnet confirmation.');
  return value;
}
async function actors() {
  if (!operatorTestCapability()) throw new Error('Test earnings controls are disabled.');
  const dir = resolve(process.env.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet');
  const accounts = await Promise.all(['operator', 'landlord', 'arbitrator'].map(async (role) =>
    privateKeyToAccount((await readFile(resolve(dir, `${role}.key`), 'utf8')).trim() as Hex, { nonceManager })));
  return { operator: accounts[0], landlord: accounts[1], arbitrator: accounts[2] };
}
async function receipt(hash: Hex) {
  const confirmed = await rpc.waitForTransactionReceipt({ hash });
  if (confirmed.status !== 'success') throw new Error(`Robinhood testnet earnings transaction failed: ${hash}`);
  return confirmed;
}

/** Fresh agreement: landlord operator accepts first; every tenant operation then requires their own wallet signature. */
export async function startShareEarnings(store: Store, wallet: string) {
  const owner = getAddress(wallet);
  const prior = await record(store, owner);
  if (prior?.vault) return prior;
  const people = await actors();
  if (prior) {
    const released = await rpc.readContract({ address: prior.escrow, abi: escrowAbi, functionName: 'releasedEarnings' });
    if (!released) throw new Error('Finish your earlier test earnings claim before preparing the new demo position.');
    await store.create(`share-earnings:archive:${owner.toLowerCase()}:${prior.escrow.toLowerCase()}`, prior);
    await store.update<EarningsRecord | Starting>(recordKey(owner), () => ({ status: 'starting' }));
  } else await store.create(recordKey(owner), { status: 'starting' } satisfies Starting);
  const op = createWalletClient({ chain, account: people.operator, transport: http() });
  const landlord = createWalletClient({ chain, account: people.landlord, transport: http() });
  const artifact = JSON.parse(await readFile(resolve('contracts/evm/out/RentalEscrow.sol/RentalEscrow.json'), 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };
  const yieldVault = JSON.parse(await readFile(resolve('contracts/evm/out/TestnetMarket.sol/TestYieldVault.json'), 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };
  const vaultHash = await op.deployContract({ abi: yieldVault.abi, bytecode: yieldVault.bytecode.object, args: [ROBINHOOD_TESTNET.usd] });
  const vaultAddress = (await receipt(vaultHash)).contractAddress;
  if (!vaultAddress) throw new Error('The dedicated test yield vault was not deployed.');
  const hashes: Hex[] = [vaultHash];
  const deployed = await op.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [{
    asset: ROBINHOOD_TESTNET.usd, vault: vaultAddress, tenant: owner,
    landlord: people.landlord.address, arbitrator: people.arbitrator.address, personalWallet: owner,
    securityRequirement: SECURITY, fundingReserve: RESERVE, earningsReleaseAllowed: true,
    agreementHash: keccak256(encodePacked(['string', 'address'], ['Ledger of Life · signed test earnings tenancy', owner])),
  }] });
  const escrow = (await receipt(deployed)).contractAddress;
  if (!escrow) throw new Error('Test earnings agreement was not deployed.');
  hashes.push(deployed);
  const mint = await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'mint', args: [owner, SECURITY + RESERVE] });
  await receipt(mint); hashes.push(mint);
  if ((await rpc.getBalance({ address: owner })) < 100_000_000_000_000n) {
    const gas = await op.sendTransaction({ to: owner, value: 300_000_000_000_000n });
    await receipt(gas); hashes.push(gas);
  }
  const accept = await landlord.writeContract({ address: escrow, abi: escrowAbi, functionName: 'acceptAgreement', args: [0n, MAX] });
  await receipt(accept); hashes.push(accept);
  const value: EarningsRecord = { status: 'ready', escrow, vault: vaultAddress, securityAtomic: SECURITY.toString(), previousEscrow: prior?.escrow,
    yieldDay: today(), yieldCount: 0, purchaseFaucetDone: false, transactionHashes: hashes };
  await store.update<EarningsRecord | Starting>(recordKey(owner), () => value);
  return value;
}

export async function readShareEarnings(store: Store, wallet: string, readClient: Pick<typeof rpc, 'readContract'> = rpc) {
  const owner = getAddress(wallet);
  const item = await record(store, owner);
  if (!item) return null;
  const [state, nonce, tracked, releasable, released] = await Promise.all([
    readClient.readContract({ address: item.escrow, abi: escrowAbi, functionName: 'state' }),
    readClient.readContract({ address: item.escrow, abi: escrowAbi, functionName: 'nonce' }),
    readClient.readContract({ address: item.escrow, abi: escrowAbi, functionName: 'trackedShares' }),
    readClient.readContract({ address: item.escrow, abi: escrowAbi, functionName: 'releasableEarnings' }),
    readClient.readContract({ address: item.escrow, abi: escrowAbi, functionName: 'releasedEarnings' }),
  ]);
  const count = yieldsToday(item);
  return { escrow: item.escrow, state: Number(state), nonce: nonce.toString(), supplied: tracked > 0n,
    yieldsToday: count, yieldAvailable: count < MAX_YIELDS_PER_DAY && !item.yieldPending && releasable < 10_000n, purchaseFaucetDone: Boolean(item.purchaseFaucetDone),
    previousEscrow: item.previousEscrow ?? null,
    releasableAtomic: releasable.toString(), releasedAtomic: released.toString(), securityAtomic: item.securityAtomic ?? '10000000' };
}

/** An earnings read must never hide independent wallet, pledge and loan positions. */
export async function readShareOverview(
  store: Store, wallet: string,
  workflowClient?: Parameters<typeof readShareWorkflows>[2],
  earningsClient?: Parameters<typeof readShareEarnings>[2],
) {
  const [workflow, earnings] = await Promise.all([
    readShareWorkflows(store, wallet, workflowClient),
    readShareEarnings(store, wallet, earningsClient)
      .then((value) => ({ value, error: null }))
      .catch((error: unknown) => ({ value: null, error: error instanceof Error ? error.message : 'Earnings temporarily unavailable.' })),
  ]);
  return { ...workflow, earnings: earnings.value, earningsError: earnings.error };
}

/** Only the signed-in tenant's own wallet can sign these prepared on-chain calls. */
export async function prepareShareEarnings(store: Store, wallet: string, action: string) {
  const owner = getAddress(wallet);
  const entry = await record(store, owner);
  if (!entry) throw new Error('Open your test earnings deposit first.');
  const escrow = entry.escrow;
  const status = await readShareEarnings(store, owner);
  const nonce = BigInt(status!.nonce);
  const calls: { to: Address; data: Hex; description: string }[] = [];
  if (action === 'accept' && status!.state === 0) calls.push({ to: escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: 'acceptAgreement', args: [nonce, MAX] }), description: 'Accept your test earnings agreement' });
  else if (action === 'fund' && status!.state === 1) {
    const amount = BigInt(status!.securityAtomic) + (entry.vault ? RESERVE : 10_000n);
    const allowance = await rpc.readContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'allowance', args: [owner, escrow] });
    if (allowance < amount) calls.push({ to: ROBINHOOD_TESTNET.usd, data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [escrow, amount] }), description: 'Approve only your test deposit amount' });
    calls.push({ to: escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: 'fund', args: [nonce, MAX] }), description: 'Fund your own test earnings deposit' });
  } else if (action === 'supply' && status!.state === 2 && !status!.supplied) {
    const amount = BigInt(status!.securityAtomic) + (entry.vault ? RESERVE : 10_000n);
    const minShares = await rpc.readContract({ address: entry.vault ?? ROBINHOOD_TESTNET.vault, abi: vault, functionName: 'previewDeposit', args: [amount] });
    calls.push({ to: escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: 'supply', args: [amount, minShares, nonce, MAX] }), description: 'Place your test deposit into the test yield vault' });
  } else if (action === 'claim' && status!.state === 2 && status!.supplied) {
    const upperBound = BigInt(status!.releasableAtomic);
    const amount = upperBound > 1_000n ? upperBound - 1_000n : upperBound * 99n / 100n;
    if (amount === 0n) throw new Error('Simulate test earnings before claiming.');
    calls.push({ to: escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: 'releaseEarnings', args: [amount, MAX, nonce, MAX] }), description: 'Claim simulated earnings to your own wallet' });
  } else throw new Error('This earnings step is not ready yet.');
  const fees = await rpc.estimateFeesPerGas();
  let transactionNonce = await rpc.getTransactionCount({ address: owner, blockTag: 'pending' });
  return calls.map((call) => ({ description: call.description, transaction: {
    chainId: 46630 as const, to: call.to, data: call.data, value: '0x0' as const, nonce: transactionNonce++, gas: '0x927c0' as Hex,
    maxFeePerGas: `0x${(fees.maxFeePerGas! * 2n).toString(16)}` as Hex,
    maxPriorityFeePerGas: `0x${(fees.maxPriorityFeePerGas ?? 0n).toString(16)}` as Hex,
  } }));
}

export async function submitShareEarnings(store: Store, wallet: string, signed: string) {
  const owner = getAddress(wallet);
  const item = await record(store, owner);
  if (!item || !/^0x02[0-9a-fA-F]+$/.test(signed) || signed.length > 20_000) throw new Error('Invalid signed test earnings transaction.');
  const serialized = signed as `0x02${string}`;
  const transaction = parseTransaction(serialized);
  if (transaction.chainId !== 46630 || (await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== owner.toLowerCase() || !transaction.to ||
    ![item.escrow.toLowerCase(), ROBINHOOD_TESTNET.usd.toLowerCase()].includes(transaction.to.toLowerCase()))
    throw new Error('Only your signed test earnings transaction can be submitted.');
  const hash = await rpc.sendRawTransaction({ serializedTransaction: serialized });
  await receipt(hash);
  return { hash };
}

/** The operator contributes real test USD to the test vault; the tenant signs the later claim. */
export async function addSimulatedShareYield(store: Store, wallet: string) {
  const owner = getAddress(wallet);
  const entry = await record(store, owner);
  if (!entry) throw new Error('Open your test earnings deposit first.');
  const status = await readShareEarnings(store, owner);
  if (!status?.supplied || !status.yieldAvailable) throw new Error('Claim the current simulated yield first, or wait until tomorrow after three test runs.');
  const people = await actors();
  await store.update<EarningsRecord>(recordKey(owner), (state) => {
    if (state.yieldPending || yieldsToday(state) >= MAX_YIELDS_PER_DAY) throw new Error('A test yield is pending, or all three daily runs are used.');
    return { ...state, yieldDay: today(), yieldCount: yieldsToday(state) + 1, yieldPending: true };
  });
  const op = createWalletClient({ chain, account: people.operator, transport: http() });
  const hashes: Hex[] = [];
  const amount = entry.vault ? YIELD : 500_000n;
  const targetVault = entry.vault ?? ROBINHOOD_TESTNET.vault;
  const mint = await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'mint', args: [people.operator.address, amount] });
  await receipt(mint); hashes.push(mint);
  const approve = await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'approve', args: [targetVault, amount] });
  await receipt(approve); hashes.push(approve);
  const accrue = await op.writeContract({ address: targetVault, abi: vault, functionName: 'accrue', args: [amount] });
  await receipt(accrue); hashes.push(accrue);
  await store.update<EarningsRecord>(recordKey(owner), (state) => ({ ...state, yieldPending: false, yieldDone: true, transactionHashes: [...state.transactionHashes, ...hashes] }));
  return { hashes };
}

/** One explicit test-mode setup: genuine signed earn/buy actions remain wallet-controlled. */
export async function prepareDemoPosition(store: Store, wallet: string) {
  const owner = getAddress(wallet);
  const market = await startShareMarket(store, owner);
  const earnings = await startShareEarnings(store, owner);
  if (earnings.purchaseFaucetDone) return { escrow: earnings.escrow, vault: earnings.vault, stock: market.stock, faucet: null };
  const people = await actors();
  const op = createWalletClient({ chain, account: people.operator, transport: http() });
  const faucet = await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: erc20, functionName: 'mint', args: [owner, DEMO_PURCHASE_FAUCET] });
  await receipt(faucet);
  await store.update<EarningsRecord>(recordKey(owner), (state) => ({ ...state, purchaseFaucetDone: true, transactionHashes: [...state.transactionHashes, faucet] }));
  return { escrow: earnings.escrow, vault: earnings.vault, stock: market.stock, faucet };
}
