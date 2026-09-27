import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http,
  nonceManager, parseAbi, parseTransaction, recoverTransactionAddress, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Store } from './store.ts';
import { ROBINHOOD_TESTNET } from './robinhood-demo.ts';
import { operatorTestCapability } from './test-capability.ts';

// Robinhood Chain TESTNET only. The signed-in person's key never enters this module.
const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const rpc = createPublicClient({ chain, transport: http() });
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function mint(address,uint256)']);
const deskAbi = parseAbi(['function price() view returns (uint256)', 'function setPrice(uint256)']);
const oracleAbi = parseAbi(['function latestPrice() view returns (uint256,uint256)', 'function setPrice(uint256)']);
const escrowAbi = parseAbi([
  'function state() view returns (uint8)', 'function stockHeld() view returns (uint256)', 'function cashHeld() view returns (uint256)',
  'function depositValue() view returns (uint256)', 'function shortfallDeadline() view returns (uint256)',
  'function claimAmount() view returns (uint256)', 'function collateralValue() view returns (uint256)',
  'function pledge(uint256,uint256)', 'function flagShortfall()', 'function liquidate()',
  'function proposeClaim(uint256)', 'function acceptClaim()', 'function settle()',
]);
const poolAbi = parseAbi([
  'function depositCollateral(uint256)', 'function borrow(uint256)', 'function repay(uint256)',
  'function withdrawCollateral(uint256)', 'function liquidate(address,uint256)',
  'function position(address) view returns (uint256 collateral,uint256 debt,uint256 collateralValue,uint256 ltvBps,uint256 healthBps)',
]);
const shareScale = 1_000_000_000_000_000_000n;
const DURATION = 365 * 24 * 60 * 60;
const noMoney = 'No real value · test tokens and simulated test price';

export type WorkflowDeployment = {
  status: 'ready'; owner: Address; oracle: Address; desk: Address; pool: Address;
  escrow?: Address; depositAtomic?: string; basePriceAtomic: string;
  transactions: Hex[];
};
type Starting = { status: 'starting' };
const key = (owner: Address) => `share-workflows:${owner.toLowerCase()}`;
const assertEnabled = () => { if (!operatorTestCapability()) throw new Error('Test market controls are disabled.'); };
const checked = (owner: string) => getAddress(owner);

async function operator() {
  assertEnabled();
  const dir = resolve(process.env.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet');
  const read = async (role: string) => privateKeyToAccount((await readFile(resolve(dir, `${role}.key`), 'utf8')).trim() as Hex, { nonceManager });
  const [signer, landlord, arbitrator] = await Promise.all(['operator', 'landlord', 'arbitrator'].map(read));
  return { signer, landlord, arbitrator };
}
async function artifact(contract: string, source: string) {
  const file = JSON.parse(await readFile(resolve(`contracts/evm/out/${source}.sol/${contract}.json`), 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };
  return file;
}
async function confirm(hash: Hex) {
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Robinhood testnet transaction failed: ${hash}`);
  return receipt;
}
async function existing(store: Store, owner: Address): Promise<WorkflowDeployment | null> {
  const item = await store.get<WorkflowDeployment | Starting>(key(owner));
  if (item?.status === 'starting') throw new Error('This test market is being prepared. Please wait for its testnet transactions to finish.');
  return item;
}
async function deployed(store: Store, owner: Address) {
  const item = await existing(store, owner);
  if (!item) throw new Error('Start your test market first.');
  return item;
}

/** One isolated test oracle/desk/pool per signed-in wallet: price scenarios never affect another account. */
export async function startShareMarket(store: Store, wallet: string) {
  assertEnabled();
  const owner = checked(wallet);
  const prior = await existing(store, owner);
  if (prior) return prior;
  await store.create(key(owner), { status: 'starting' } satisfies Starting);
  const people = await operator();
  const op = createWalletClient({ chain, account: people.signer, transport: http() });
  const basePrice = await rpc.readContract({ address: ROBINHOOD_TESTNET.desk, abi: deskAbi, functionName: 'price' });
  const transactions: Hex[] = [];
  async function deploy(contract: string, source: string, args: readonly unknown[]) {
    const code = await artifact(contract, source);
    const hash = await op.deployContract({ abi: code.abi, bytecode: code.bytecode.object, args });
    const address = (await confirm(hash)).contractAddress;
    if (!address) throw new Error('The test contract was not deployed.');
    transactions.push(hash);
    return address;
  }
  const oracle = await deploy('TestPriceOracle', 'TestnetMarket', [basePrice]);
  const desk = await deploy('TestStockDesk', 'TestnetMarket', [ROBINHOOD_TESTNET.usd, ROBINHOOD_TESTNET.tsla, basePrice]);
  const pool = await deploy('TestLendingPool', 'TestLendingPool', [ROBINHOOD_TESTNET.tsla, ROBINHOOD_TESTNET.usd, oracle, 500, DURATION]);
  for (const target of [desk, pool]) {
    const hash = await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'mint', args: [target, target === desk ? 20_000_000n : 10_000_000n] });
    await confirm(hash); transactions.push(hash);
  }
  if ((await rpc.getBalance({ address: owner })) < 100_000_000_000_000n) {
    const hash = await op.sendTransaction({ to: owner, value: 300_000_000_000_000n });
    await confirm(hash); transactions.push(hash);
  }
  const state: WorkflowDeployment = { status: 'ready', owner, oracle, desk, pool, basePriceAtomic: basePrice.toString(), transactions };
  await store.update<WorkflowDeployment | Starting>(key(owner), () => state);
  return state;
}

export async function readShareWorkflows(store: Store, wallet: string) {
  const owner = checked(wallet);
  const deployment = await existing(store, owner);
  const [shares, dollars, basePrice] = await Promise.all([
    rpc.readContract({ address: ROBINHOOD_TESTNET.tsla, abi: tokenAbi, functionName: 'balanceOf', args: [owner] }),
    rpc.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'balanceOf', args: [owner] }),
    rpc.readContract({ address: ROBINHOOD_TESTNET.desk, abi: deskAbi, functionName: 'price' }),
  ]);
  const price = deployment ? (await rpc.readContract({ address: deployment.oracle, abi: oracleAbi, functionName: 'latestPrice' }))[0] : basePrice;
  const pledged = deployment?.escrow ? await Promise.all([
    rpc.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: 'state' }),
    rpc.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: 'stockHeld' }),
    rpc.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: 'cashHeld' }),
    rpc.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: 'shortfallDeadline' }),
    rpc.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: 'claimAmount' }),
  ]) : null;
  const loan = deployment ? await rpc.readContract({ address: deployment.pool, abi: poolAbi, functionName: 'position', args: [owner] }) : null;
  const collateral = pledged?.[1] ?? 0n;
  const cash = pledged?.[2] ?? 0n;
  const deposit = BigInt(deployment?.depositAtomic ?? 0);
  const value = collateral * price / shareScale + cash;
  const required = deposit * 125n / 100n;
  const suggestedPledge = shares / 2n;
  const suggestedDeposit = suggestedPledge * price / shareScale * 2n / 3n;
  const maxLoan = loan ? loan[2] / 2n : 0n;
  const availableLoan = maxLoan > (loan?.[1] ?? 0n) ? maxLoan - loan![1] : 0n;
  return {
    enabled: operatorTestCapability(), disclaimer: noMoney, chainId: 46630, wallet: owner,
    sharesRaw: shares.toString(), testUsdAtomic: dollars.toString(), priceAtomic: price.toString(),
    walletValueAtomic: (shares * price / shareScale).toString(), suggestedPledgeRaw: suggestedPledge.toString(),
    suggestedDepositAtomic: suggestedDeposit.toString(),
    deployment: deployment ? { oracle: deployment.oracle, desk: deployment.desk, pool: deployment.pool, escrow: deployment.escrow } : null,
    deposit: pledged && deployment ? {
      state: Number(pledged[0]), sharesRaw: collateral.toString(), cashAtomic: cash.toString(),
      valueAtomic: value.toString(), depositAtomic: deposit.toString(), bufferAtomic: (value - required).toString(),
      deadline: Number(pledged[3]), claimAtomic: pledged[4].toString(),
    } : null,
    loan: loan ? { sharesRaw: loan[0].toString(), debtAtomic: loan[1].toString(), valueAtomic: loan[2].toString(), ltvBps: Number(loan[3]), healthBps: loan[1] === 0n ? 0 : Number(loan[4]), availableAtomic: availableLoan.toString() } : null,
  };
}

export type PreparedStep = { description: string; transaction: { chainId: 46630; to: Address; data: Hex; value: '0x0'; nonce: number; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
export async function prepareShareAction(store: Store, wallet: string, action: string, quantity?: string) {
  const owner = checked(wallet);
  const config = await deployed(store, owner);
  const allowed = ['pledge', 'top_up', 'accept_claim', 'deposit_collateral', 'borrow', 'repay', 'withdraw_collateral'];
  if (!allowed.includes(action)) throw new Error('Unknown wallet action.');
  const amount = quantity === undefined ? 0n : BigInt(quantity);
  if (amount < 0n) throw new Error('Invalid test amount.');
  const calls: { to: Address; data: Hex; description: string }[] = [];
  const stockTarget = action === 'pledge' || action === 'top_up' ? config.escrow : config.pool;
  if ((action === 'pledge' || action === 'top_up' || action === 'deposit_collateral') && (!stockTarget || amount === 0n)) throw new Error('Choose a positive amount of test shares first.');
  if (action === 'borrow' || action === 'repay' || action === 'withdraw_collateral') {
    if (!amount) throw new Error('Choose a positive test amount first.');
  }
  if (action === 'accept_claim' && !config.escrow) throw new Error('No new test tenancy yet.');
  if (action === 'pledge' || action === 'top_up' || action === 'deposit_collateral') {
    const target = stockTarget!;
    const allowance = await rpc.readContract({ address: ROBINHOOD_TESTNET.tsla, abi: tokenAbi, functionName: 'allowance', args: [owner, target] });
    if (allowance < amount) calls.push({ to: ROBINHOOD_TESTNET.tsla, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [target, amount] }), description: 'Allow this test contract to hold only the selected test TSLA' });
  }
  if (action === 'repay') {
    const allowance = await rpc.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'allowance', args: [owner, config.pool] });
    if (allowance < amount) calls.push({ to: ROBINHOOD_TESTNET.usd, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [config.pool, amount] }), description: 'Allow repayment of test USD' });
  }
  if (action === 'pledge' || action === 'top_up') calls.push({
    to: config.escrow!, data: encodeFunctionData({ abi: escrowAbi, functionName: 'pledge', args: [amount, 0n] }),
    description: action === 'pledge' ? 'Pledge test TSLA for your next deposit' : 'Add test TSLA to your deposit',
  });
  if (action === 'accept_claim') calls.push({
    to: config.escrow!, data: encodeFunctionData({ abi: escrowAbi, functionName: 'acceptClaim' }), description: 'Accept the test move-out claim',
  });
  if (action === 'deposit_collateral') calls.push({
    to: config.pool, data: encodeFunctionData({ abi: poolAbi, functionName: 'depositCollateral', args: [amount] }), description: 'Add test TSLA as borrowing collateral',
  });
  if (action === 'borrow') calls.push({
    to: config.pool, data: encodeFunctionData({ abi: poolAbi, functionName: 'borrow', args: [amount] }), description: 'Borrow test USD against your shares',
  });
  if (action === 'repay') calls.push({
    to: config.pool, data: encodeFunctionData({ abi: poolAbi, functionName: 'repay', args: [amount] }), description: 'Repay test USD and accrued interest',
  });
  if (action === 'withdraw_collateral') calls.push({
    to: config.pool, data: encodeFunctionData({ abi: poolAbi, functionName: 'withdrawCollateral', args: [amount] }), description: 'Return unpledged test shares to your wallet',
  });
  const fees = await rpc.estimateFeesPerGas();
  let nonce = await rpc.getTransactionCount({ address: owner, blockTag: 'pending' });
  return calls.map(({ to, data, description }): PreparedStep => ({ description, transaction: {
    chainId: 46630, to, data, value: '0x0', nonce: nonce++, gas: '0x927c0',
    maxFeePerGas: `0x${(fees.maxFeePerGas! * 2n).toString(16)}`, maxPriorityFeePerGas: `0x${(fees.maxPriorityFeePerGas ?? 0n).toString(16)}`,
  } }));
}

export async function submitShareTransaction(store: Store, wallet: string, signed: string) {
  const owner = checked(wallet);
  const config = await deployed(store, owner);
  if (!/^0x02[0-9a-fA-F]+$/.test(signed) || signed.length > 20_000) throw new Error('Invalid signed test transaction.');
  const serialized = signed as `0x02${string}`;
  const transaction = parseTransaction(serialized);
  if (transaction.chainId !== 46630 || (await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== owner.toLowerCase())
    throw new Error('This transaction was not signed by your Robinhood testnet wallet.');
  if (!transaction.to || ![ROBINHOOD_TESTNET.tsla.toLowerCase(), ROBINHOOD_TESTNET.usd.toLowerCase(), config.pool.toLowerCase(), config.escrow?.toLowerCase()].includes(transaction.to.toLowerCase()))
    throw new Error('Not a transaction for your test share workflow.');
  const hash = await rpc.sendRawTransaction({ serializedTransaction: signed as Hex });
  await confirm(hash);
  return { hash };
}

/** Operator-only test controls, never invoked using a person's key. */
export async function controlShareMarket(store: Store, wallet: string, action: string) {
  assertEnabled();
  const owner = checked(wallet);
  const config = await deployed(store, owner);
  const people = await operator();
  const op = createWalletClient({ chain, account: people.signer, transport: http() });
  const landlord = createWalletClient({ chain, account: people.landlord, transport: http() });
  let hash: Hex;
  if (action === 'landlord_accepts') {
    if (config.escrow) throw new Error('A test tenancy is already open.');
    const shares = await rpc.readContract({ address: ROBINHOOD_TESTNET.tsla, abi: tokenAbi, functionName: 'balanceOf', args: [owner] });
    const price = (await rpc.readContract({ address: config.oracle, abi: oracleAbi, functionName: 'latestPrice' }))[0];
    const pledged = shares / 2n;
    const security = pledged * price / shareScale * 2n / 3n;
    if (security < 10_000n) throw new Error('Buy test TSLA first, then ask the test landlord to accept it.');
    const code = await artifact('CollateralEscrow', 'CollateralEscrow');
    hash = await landlord.deployContract({ abi: code.abi, bytecode: code.bytecode.object, args: [{
      stock: ROBINHOOD_TESTNET.tsla, usd: ROBINHOOD_TESTNET.usd, oracle: config.oracle, sale: config.desk,
      tenant: owner, landlord: people.landlord.address, arbitrator: people.arbitrator.address,
      depositValue: security, initialRatioBps: 15_000, maintenanceRatioBps: 12_500,
      maxSlippageBps: 200, graceSeconds: 60, maxOracleAge: DURATION,
    }] });
    const address = (await confirm(hash)).contractAddress;
    if (!address) throw new Error('Test landlord acceptance did not deploy the tenancy.');
    await store.update<WorkflowDeployment>(key(owner), (state) => ({ ...state, escrow: address, depositAtomic: security.toString(), transactions: [...state.transactions, hash] }));
  } else if (action === 'price_down_30' || action === 'price_down_60' || action === 'price_down_70' || action === 'price_reset') {
    const price = BigInt(config.basePriceAtomic) * (action === 'price_down_30' ? 70n : action === 'price_down_60' ? 40n : action === 'price_down_70' ? 30n : 100n) / 100n;
    hash = await op.writeContract({ address: config.oracle, abi: oracleAbi, functionName: 'setPrice', args: [price] });
    await confirm(hash);
    const deskHash = await op.writeContract({ address: config.desk, abi: deskAbi, functionName: 'setPrice', args: [price] });
    await confirm(deskHash);
    await store.update<WorkflowDeployment>(key(owner), (state) => ({ ...state, transactions: [...state.transactions, hash, deskHash] }));
    return { hash, deskHash };
  } else if (action === 'flag_shortfall' || action === 'protect_deposit') {
    if (!config.escrow) throw new Error('No new test tenancy yet.');
    hash = await op.writeContract({ address: config.escrow, abi: escrowAbi, functionName: action === 'flag_shortfall' ? 'flagShortfall' : 'liquidate' });
    await confirm(hash);
  } else if (action === 'move_out_claim') {
    if (!config.escrow) throw new Error('No new test tenancy yet.');
    hash = await landlord.writeContract({ address: config.escrow, abi: escrowAbi, functionName: 'proposeClaim', args: [BigInt(config.depositAtomic!) / 5n] });
    await confirm(hash);
  } else if (action === 'settle') {
    if (!config.escrow) throw new Error('No new test tenancy yet.');
    hash = await op.writeContract({ address: config.escrow, abi: escrowAbi, functionName: 'settle' });
    await confirm(hash);
  } else if (action === 'faucet') {
    hash = await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'mint', args: [owner, 1_000_000n] });
    await confirm(hash);
  } else if (action === 'liquidate_loan') {
    const debt = (await rpc.readContract({ address: config.pool, abi: poolAbi, functionName: 'position', args: [owner] }))[1];
    const mint = await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'mint', args: [people.signer.address, debt] });
    await confirm(mint);
    const approve = await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'approve', args: [config.pool, debt] });
    await confirm(approve);
    hash = await op.writeContract({ address: config.pool, abi: poolAbi, functionName: 'liquidate', args: [owner, debt] });
    await confirm(hash);
    await store.update<WorkflowDeployment>(key(owner), (state) => ({ ...state, transactions: [...state.transactions, mint, approve, hash] }));
    return { hash, mint, approve };
  } else throw new Error('Unknown test market control.');
  await store.update<WorkflowDeployment>(key(owner), (state) => ({ ...state, transactions: [...state.transactions, hash] }));
  return { hash };
}
