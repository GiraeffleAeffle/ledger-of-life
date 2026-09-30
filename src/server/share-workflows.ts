import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createPublicClient, createWalletClient, defineChain, encodeDeployData, encodeFunctionData, getAddress, http,
  keccak256, nonceManager, parseAbi, parseTransaction, recoverTransactionAddress, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Store } from './store.ts';
import { ROBINHOOD_TESTNET } from './robinhood-demo.ts';
import { operatorTestCapability } from './test-capability.ts';
import { executeFundingStep, type SignedFundingStep } from './local-investment-provisioning.ts';
import { acquireOperatorNonceLane, releaseOperatorNonceLane, releaseOperatorNonceLaneIfOwned } from './operator-nonce-lane.ts';
import { reviewedOperatorFees, reviewedOperatorGas } from './ownership-gas.ts';

// Robinhood Chain TESTNET only. The signed-in person's key never enters this module.
const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const rpc = createPublicClient({ chain, transport: http() });
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function mint(address,uint256)']);
const deskAbi = parseAbi(['function price() view returns (uint256)', 'function setPrice(uint256)', 'function quoteBuy(uint256) view returns (uint256)', 'function buy(uint256,uint256) returns (uint256)']);
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
  status: 'ready'; owner: Address; oracle: Address; desk: Address; pool: Address; stock?: Address; provisioner?: Address;
  escrow?: Address; depositAtomic?: string; basePriceAtomic: string;
  transactions: Hex[];
};
type Starting = { status: 'starting'; owner: Address; provisioner: Address; basePriceAtomic?: string; steps: Record<string, SignedFundingStep>; addresses: Partial<Record<'stock' | 'oracle' | 'desk' | 'pool', Address>>; transactions: Hex[] };
/** Called inside Store.update's atomic transaction: a late resume must never erase a ready escrow. */
export function finalizeShareMarket(current: WorkflowDeployment | Starting, completed: WorkflowDeployment): WorkflowDeployment {
  if (current.status === 'ready') return current;
  if (current.owner.toLowerCase() !== completed.owner.toLowerCase() || current.provisioner.toLowerCase() !== completed.provisioner?.toLowerCase())
    throw new Error('The reserved market signer or owner changed before finalization.');
  return { ...completed, transactions: current.transactions };
}
const key = (owner: Address) => `share-workflows:${owner.toLowerCase()}`;
const assertEnabled = () => { if (!operatorTestCapability()) throw new Error('Test market controls are disabled.'); };
const checked = (owner: string) => getAddress(owner);

async function operator() {
  assertEnabled();
  const dir = resolve(/* turbopackIgnore: true */ process.env.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet');
  const read = async (role: string) => privateKeyToAccount((await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ dir, `${role}.key`), 'utf8')).trim() as Hex, { nonceManager });
  const [signer, landlord, arbitrator] = await Promise.all(['operator', 'landlord', 'arbitrator'].map(read));
  return { signer, landlord, arbitrator };
}
/** A distinct, explicitly funded testnet signer owns newly created oracle and desk contracts. */
export async function ownershipProvisioner() {
  assertEnabled();
  const filename = resolve(/* turbopackIgnore: true */ process.env.ROBINHOOD_OWNERSHIP_PROVISIONER_KEY_FILE || '.testnet-secrets/robinhood-testnet/ownership-provisioner.key');
  const shared = resolve(/* turbopackIgnore: true */ process.env.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet', 'operator.key');
  const [dedicatedKey, operatorKey] = await Promise.all([readFile(/* turbopackIgnore: true */ filename, 'utf8'), readFile(/* turbopackIgnore: true */ shared, 'utf8')]);
  const signer = privateKeyToAccount(dedicatedKey.trim() as Hex, { nonceManager });
  if (signer.address.toLowerCase() === privateKeyToAccount(operatorKey.trim() as Hex).address.toLowerCase())
    throw new Error('Ownership provisioner must not reuse the shared test operator.');
  return signer;
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

/** One isolated test oracle/desk/pool per signed-in wallet. A previously created market is never replaced. */
export async function startShareMarket(store: Store, wallet: string, laneOperation?: string) {
  assertEnabled();
  const owner = checked(wallet);
  let state = await store.get<WorkflowDeployment | Starting>(key(owner));
  if (state?.status === 'ready') {
    if (!laneOperation && state.provisioner) {
      const signer = await ownershipProvisioner();
      if (signer.address.toLowerCase() !== state.provisioner.toLowerCase()) throw new Error('The dedicated signer no longer matches this market’s recorded owner.');
      await releaseOperatorNonceLaneIfOwned(store, signer.address, `share-market:${owner.toLowerCase()}`);
    }
    return state;
  }
  const signer = await ownershipProvisioner();
  if (!state) {
    const existingShares = await rpc.readContract({ address: ROBINHOOD_TESTNET.tsla, abi: tokenAbi, functionName: 'balanceOf', args: [owner] });
    if (existingShares > 0n) throw new Error('Existing official test TSLA remains separate; do not replace its share market with fake stock.');
    try {
      await store.create(key(owner), { status: 'starting', owner, provisioner: signer.address, steps: {}, addresses: {}, transactions: [] } satisfies Starting);
    } catch (error) {
      if (await store.get(key(owner))) throw new Error('This wallet already has a reserved market setup. Retry it without starting another.');
      throw error;
    }
    state = await store.get<Starting>(key(owner));
  }
  if (!state || state.status !== 'starting' || state.owner?.toLowerCase() !== owner.toLowerCase() || !state.steps || !state.addresses ||
    state.provisioner?.toLowerCase() !== signer.address.toLowerCase())
    throw new Error('A previous market setup cannot be safely recovered; no replacement market was started.');
  const operation = laneOperation ?? `share-market:${owner.toLowerCase()}`;
  await acquireOperatorNonceLane(store, signer.address, operation);
  if (!state.basePriceAtomic) {
    const price = await rpc.readContract({ address: ROBINHOOD_TESTNET.desk, abi: deskAbi, functionName: 'price' });
    state = await store.update<Starting>(key(owner), (current) => ({ ...current, basePriceAtomic: current.basePriceAtomic ?? price.toString() }));
  }
  const basePrice = BigInt(state.basePriceAtomic!);
  async function sendStep(label: string, to: Address | undefined, data: Hex, value = 0n) {
    const journal = (await store.get<Starting>(key(owner)))!.steps[label] ?? {};
    const hash = await executeFundingStep(journal, async () => {
      const [nonce, fees, gas] = await Promise.all([
        rpc.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
        rpc.estimateFeesPerGas(),
        rpc.estimateGas({ account: signer.address, to, data, value }),
      ]);
      const quoted = reviewedOperatorFees(fees);
      return signer.signTransaction({
        type: 'eip1559', chainId: chain.id, nonce, to, data, value, gas: reviewedOperatorGas(gas, to ? 'transfer' : 'deploy'),
        ...quoted,
      });
    }, async () => {
      await store.update<Starting>(key(owner), (current) => {
        if (current.status !== 'starting') throw new Error('Market setup changed while its transaction was reserved.');
        const saved = current.steps[label];
        if (saved?.signed && saved.signed !== journal.signed) throw new Error('A different signed market transaction already reserves this step.');
        if (saved?.hash && saved.hash !== keccak256(journal.signed!)) throw new Error('Market transaction journal changed.');
        return { ...current, steps: { ...current.steps, [label]: { ...journal } } };
      });
    }, rpc);
    const receipt = await rpc.getTransactionReceipt({ hash });
    if (receipt.status !== 'success' || receipt.transactionHash !== hash) throw new Error('The reserved market step is not confirmed.');
    return { hash, receipt };
  }
  async function deploy(label: 'stock' | 'oracle' | 'desk' | 'pool', contract: string, source: string, args: readonly unknown[]) {
    const current = (await store.get<Starting>(key(owner)))!;
    if (current.addresses[label]) return current.addresses[label];
    const code = await artifact(contract, source);
    const result = await sendStep(label, undefined, encodeDeployData({ abi: code.abi, bytecode: code.bytecode.object, args }));
    if (!result.receipt.contractAddress) throw new Error('Reserved market deployment has no contract address.');
    await store.update<Starting>(key(owner), (value) => ({
      ...value, addresses: { ...value.addresses, [label]: result.receipt.contractAddress! },
      transactions: value.transactions.includes(result.hash) ? value.transactions : [...value.transactions, result.hash],
    }));
    return result.receipt.contractAddress;
  }
  async function transfer(label: string, to: Address, data: Hex, value = 0n) {
    const current = (await store.get<Starting>(key(owner)))!;
    if (current.transactions.includes(current.steps[label]?.hash as Hex)) return;
    const { hash } = await sendStep(label, to, data, value);
    await store.update<Starting>(key(owner), (value) => ({
      ...value, transactions: value.transactions.includes(hash) ? value.transactions : [...value.transactions, hash],
    }));
  }
  const stock = await deploy('stock', 'FakeTestTSLA', 'FakeTestTSLA', []);
  const oracle = await deploy('oracle', 'TestPriceOracle', 'TestnetMarket', [basePrice]);
  const desk = await deploy('desk', 'TestStockDesk', 'TestnetMarket', [ROBINHOOD_TESTNET.usd, stock, basePrice]);
  const pool = await deploy('pool', 'TestLendingPool', 'TestLendingPool', [stock, ROBINHOOD_TESTNET.usd, oracle, 500, DURATION]);
  await transfer('inventory', stock, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [desk, 1_000n * shareScale] }));
  await transfer('desk-usd', ROBINHOOD_TESTNET.usd, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [desk, 8_000_000_000n] }));
  await transfer('pool-usd', ROBINHOOD_TESTNET.usd, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [pool, 8_000_000_000n] }));
  const latest = (await store.get<WorkflowDeployment | Starting>(key(owner)))!;
  if (latest.status === 'starting' && (latest.steps['owner-gas']?.signed || (await rpc.getBalance({ address: owner })) < 100_000_000_000_000n))
    await transfer('owner-gas', owner, '0x', 300_000_000_000_000n);
  const ready: WorkflowDeployment = { status: 'ready', owner, stock, oracle, desk, pool, provisioner: signer.address, basePriceAtomic: basePrice.toString(), transactions: [] };
  const finalized = await store.update<WorkflowDeployment | Starting>(key(owner), (current) => finalizeShareMarket(current, ready));
  if (finalized.status !== 'ready') throw new Error('Market completion did not persist.');
  if (!laneOperation) await releaseOperatorNonceLane(store, signer.address, operation);
  return finalized;
}

export async function readShareWorkflows(store: Store, wallet: string, readClient: Pick<typeof rpc, 'readContract'> = rpc) {
  const owner = checked(wallet);
  const deployment = await existing(store, owner);
  const stock = deployment?.stock ?? ROBINHOOD_TESTNET.tsla;
  const [shares, dollars, price] = await Promise.all([
    readClient.readContract({ address: stock, abi: tokenAbi, functionName: 'balanceOf', args: [owner] }),
    readClient.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'balanceOf', args: [owner] }),
    deployment
      ? readClient.readContract({ address: deployment.oracle, abi: oracleAbi, functionName: 'latestPrice' }).then(([value]) => value)
      : readClient.readContract({ address: ROBINHOOD_TESTNET.desk, abi: deskAbi, functionName: 'price' }),
  ]);
  const pledged = deployment?.escrow ? await Promise.all([
    readClient.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: 'state' }),
    readClient.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: 'stockHeld' }),
    readClient.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: 'cashHeld' }),
    readClient.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: 'shortfallDeadline' }),
    readClient.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: 'claimAmount' }),
  ]) : null;
  const loan = deployment ? await readClient.readContract({ address: deployment.pool, abi: poolAbi, functionName: 'position', args: [owner] }) : null;
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
    stockSymbol: deployment?.stock ? 'tTSLA · fake test stock' : 'official test TSLA',
    fakeStock: deployment?.stock ? { symbol: 'tTSLA', walletRaw: shares.toString(), walletValueAtomic: (shares * price / shareScale).toString(), priceAtomic: price.toString() } : null,
    sharesRaw: shares.toString(), testUsdAtomic: dollars.toString(), priceAtomic: price.toString(),
    walletValueAtomic: (shares * price / shareScale).toString(), suggestedPledgeRaw: suggestedPledge.toString(),
    suggestedDepositAtomic: suggestedDeposit.toString(),
    deployment: deployment ? { oracle: deployment.oracle, desk: deployment.desk, pool: deployment.pool, escrow: deployment.escrow, provisioner: deployment.provisioner ?? null } : null,
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
  const allowed = ['pledge', 'top_up', 'accept_claim', 'deposit_collateral', 'borrow', 'repay', 'withdraw_collateral', 'buy_fake'];
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
    const stock = config.stock ?? ROBINHOOD_TESTNET.tsla;
    const allowance = await rpc.readContract({ address: stock, abi: tokenAbi, functionName: 'allowance', args: [owner, target] });
    if (allowance < amount) calls.push({ to: stock, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [target, amount] }), description: 'Allow this test contract to hold only the selected test shares' });
  }
  if (action === 'repay') {
    const allowance = await rpc.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'allowance', args: [owner, config.pool] });
    if (allowance < amount) calls.push({ to: ROBINHOOD_TESTNET.usd, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [config.pool, amount] }), description: 'Allow repayment of test USD' });
  }
  if (action === 'buy_fake') {
    if (!config.stock || amount === 0n || amount > 3_600_000_000n) throw new Error('Choose at most $3,600 test USD for the fake-stock demo.');
    const balance = await rpc.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'balanceOf', args: [owner] });
    if (amount > balance) throw new Error('Claim simulated earnings or prepare test faucet funds before buying fake stock.');
    const allowance = await rpc.readContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'allowance', args: [owner, config.desk] });
    if (allowance < amount) calls.push({ to: ROBINHOOD_TESTNET.usd, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [config.desk, amount] }), description: 'Approve test USD for your fake-stock purchase' });
    const quote = await rpc.readContract({ address: config.desk, abi: deskAbi, functionName: 'quoteBuy', args: [amount] });
    calls.push({ to: config.desk, data: encodeFunctionData({ abi: deskAbi, functionName: 'buy', args: [amount, quote * 98n / 100n] }), description: 'Buy tTSLA fake test stock with your wallet' });
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
  const stock = config.stock ?? ROBINHOOD_TESTNET.tsla;
  if (!transaction.to || ![stock.toLowerCase(), ROBINHOOD_TESTNET.usd.toLowerCase(), config.pool.toLowerCase(), config.desk.toLowerCase(), config.escrow?.toLowerCase()].includes(transaction.to.toLowerCase()))
    throw new Error('Not a transaction for your test share workflow.');
  const hash = await rpc.sendRawTransaction({ serializedTransaction: signed as Hex });
  await confirm(hash);
  return { hash };
}

type ControlCall = { to: Address; data: Hex };
type ControlJournal = { owner: Address; pool: Address; action: string; calls: ControlCall[]; steps: SignedFundingStep[]; state: 'running' | 'done' | 'failed_unsigned'; hashes: Hex[]; error?: string };
function controlResult(hashes: Hex[]) {
  if (hashes.length === 2) return { hash: hashes[0], deskHash: hashes[1] };
  if (hashes.length === 3) return { hash: hashes[2], mint: hashes[0], approve: hashes[1] };
  return { hash: hashes[0] };
}
/** Atomic fence: another instance cannot publish a signature after this unsigned failure. */
export async function failUnsignedShareControl(store: Store, jobKey: string, reason: string) {
  const journal = await store.update<ControlJournal>(jobKey, (current) => {
    if (current.state !== 'running' || current.steps.some((step) => Boolean(step.signed))) return current;
    return { ...current, state: 'failed_unsigned', error: reason };
  });
  return journal.state === 'failed_unsigned';
}
async function provisionedControl(store: Store, owner: Address, config: WorkflowDeployment, action: string, requestId: string, signer: PrivateKeyAccount) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId)) throw new Error('A unique control request is required to safely reconcile operator transactions.');
  const jobKey = `share-control:${owner.toLowerCase()}:${requestId}`;
  let journal = await store.get<ControlJournal>(jobKey);
  if (!journal) {
    const calls: ControlCall[] = [];
    if (action === 'price_down_30' || action === 'price_down_60' || action === 'price_down_70' || action === 'price_reset') {
      const price = BigInt(config.basePriceAtomic) * (action === 'price_down_30' ? 70n : action === 'price_down_60' ? 40n : action === 'price_down_70' ? 30n : 100n) / 100n;
      calls.push({ to: config.oracle, data: encodeFunctionData({ abi: oracleAbi, functionName: 'setPrice', args: [price] }) },
        { to: config.desk, data: encodeFunctionData({ abi: deskAbi, functionName: 'setPrice', args: [price] }) });
    } else if (action === 'flag_shortfall' || action === 'protect_deposit' || action === 'settle') {
      if (!config.escrow) throw new Error('No new test tenancy yet.');
      calls.push({ to: config.escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: action === 'flag_shortfall' ? 'flagShortfall' : action === 'protect_deposit' ? 'liquidate' : 'settle' }) });
    } else if (action === 'faucet') {
      calls.push({ to: ROBINHOOD_TESTNET.usd, data: encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [owner, 1_000_000n] }) });
    } else if (action === 'liquidate_loan') {
      const debt = (await rpc.readContract({ address: config.pool, abi: poolAbi, functionName: 'position', args: [owner] }))[1];
      calls.push(
        { to: ROBINHOOD_TESTNET.usd, data: encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [signer.address, debt] }) },
        { to: ROBINHOOD_TESTNET.usd, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [config.pool, debt] }) },
        { to: config.pool, data: encodeFunctionData({ abi: poolAbi, functionName: 'liquidate', args: [owner, debt] }) },
      );
    } else throw new Error('Unknown test market control.');
    try { await store.create(jobKey, { owner, pool: config.pool, action, calls, steps: calls.map(() => ({})), hashes: [], state: 'running' } satisfies ControlJournal); }
    catch (error) { if (!(await store.get(jobKey))) throw error; }
    journal = await store.get<ControlJournal>(jobKey);
  }
  if (!journal || journal.owner !== owner || journal.pool !== config.pool || journal.action !== action)
    throw new Error('Control request is bound to another market or operation.');
  const operation = `share-control:${owner.toLowerCase()}:${requestId}`;
  if (journal.state === 'done') {
    await releaseOperatorNonceLaneIfOwned(store, signer.address, operation);
    return controlResult(journal.hashes);
  }
  if (journal.state === 'failed_unsigned') {
    await releaseOperatorNonceLaneIfOwned(store, signer.address, operation);
    return { state: 'failed_unsigned' as const, error: journal.error ?? 'No operator transaction was signed.' };
  }
  await acquireOperatorNonceLane(store, signer.address, operation);
  try {
  for (let i = 0; i < journal.calls.length; i++) {
    const call = journal.calls[i];
    const step = (await store.get<ControlJournal>(jobKey))!.steps[i];
    const hash = await executeFundingStep(step, async () => {
      const [nonce, fees, gas] = await Promise.all([
        rpc.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
        rpc.estimateFeesPerGas(), rpc.estimateGas({ account: signer.address, to: call.to, data: call.data }),
      ]);
      const quoted = reviewedOperatorFees(fees);
      return signer.signTransaction({ type: 'eip1559', chainId: chain.id, nonce, to: call.to, data: call.data,
        gas: reviewedOperatorGas(gas, 'deploy'), ...quoted });
    }, async () => {
      await store.update<ControlJournal>(jobKey, (value) => {
        if (value.state !== 'running') throw new Error('Control was closed before signing; no transaction was sent.');
        const saved = value.steps[i];
        if (saved?.signed && saved.signed !== step.signed) throw new Error('Control transaction journal changed.');
        return { ...value, steps: value.steps.map((item, index) => index === i ? { ...step } : item) };
      });
    }, rpc);
    journal = await store.update<ControlJournal>(jobKey, (value) => ({
      ...value, hashes: value.hashes[i] === hash ? value.hashes : [...value.hashes.slice(0, i), hash],
    }));
  }
  await store.update<WorkflowDeployment>(key(owner), (value) => ({
    ...value, transactions: [...value.transactions, ...journal!.hashes.filter((hash) => !value.transactions.includes(hash))],
  }));
  await store.update<ControlJournal>(jobKey, (value) => ({ ...value, state: 'done' }));
  await releaseOperatorNonceLane(store, signer.address, operation);
  return controlResult(journal.hashes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The control was unavailable before signing.';
    if (await failUnsignedShareControl(store, jobKey, reason)) {
      await releaseOperatorNonceLaneIfOwned(store, signer.address, operation);
      return { state: 'failed_unsigned' as const, error: reason };
    }
    throw error;
  }
}

/** Operator-only test controls, never invoked using a person's key. */
export async function controlShareMarket(store: Store, wallet: string, action: string, requestId?: string) {
  assertEnabled();
  const owner = checked(wallet);
  const config = await deployed(store, owner);
  const people = await operator();
  const signer = config.provisioner ? await ownershipProvisioner() : people.signer;
  if (config.provisioner && signer.address.toLowerCase() !== config.provisioner.toLowerCase())
    throw new Error('The dedicated signer no longer matches this market’s recorded owner.');
  if (config.provisioner && action !== 'landlord_accepts' && action !== 'move_out_claim')
    return provisionedControl(store, owner, config, action, requestId ?? '', signer);
  const op = createWalletClient({ chain, account: signer, transport: http() });
  const landlord = createWalletClient({ chain, account: people.landlord, transport: http() });
  let hash: Hex;
  if (action === 'landlord_accepts') {
    if (config.escrow) throw new Error('A test tenancy is already open.');
    const shares = await rpc.readContract({ address: config.stock ?? ROBINHOOD_TESTNET.tsla, abi: tokenAbi, functionName: 'balanceOf', args: [owner] });
    const price = (await rpc.readContract({ address: config.oracle, abi: oracleAbi, functionName: 'latestPrice' }))[0];
    const pledged = shares / 2n;
    const security = pledged * price / shareScale * 2n / 3n;
    if (security < 10_000n) throw new Error('Buy fake test stock first, then ask the test landlord to accept it.');
    const code = await artifact('CollateralEscrow', 'CollateralEscrow');
    hash = await landlord.deployContract({ abi: code.abi, bytecode: code.bytecode.object, gas: 3_000_000n, args: [{
      stock: config.stock ?? ROBINHOOD_TESTNET.tsla, usd: ROBINHOOD_TESTNET.usd, oracle: config.oracle, sale: config.desk,
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
    const mint = await op.writeContract({ address: ROBINHOOD_TESTNET.usd, abi: tokenAbi, functionName: 'mint', args: [signer.address, debt] });
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
