import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createWalletClient, decodeFunctionData, encodeDeployData, encodeFunctionData, encodePacked, getAddress, http, keccak256, nonceManager, parseAbi, parseTransaction, recoverTransactionAddress, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Store } from './store.ts';
import { operatorTestCapability } from './test-capability.ts';
import { loadSharedMarketManifest, verifySharedMarket, sharedMarketRpc as rpc } from './shared-market.ts';
import { executeFundingStep, type SignedFundingStep } from './local-investment-provisioning.ts';
import { acquireOperatorNonceLane, releaseOperatorNonceLaneIfOwned } from './operator-nonce-lane.ts';
import { reviewedOperatorFees, reviewedOperatorGas } from './ownership-gas.ts';

const tokenAbi = parseAbi(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function mint(address,uint256)']);
const vaultAbi = parseAbi(['function previewDeposit(uint256) view returns (uint256)']);
export const EARNINGS_ESCROW_ABI = parseAbi([
  'function state() view returns (uint8)', 'function nonce() view returns (uint256)', 'function trackedShares() view returns (uint256)',
  'function releasedEarnings() view returns (uint256)', 'function releasableEarnings() view returns (uint256)',
  'function acceptAgreement(uint256,uint256)', 'function fund(uint256,uint256)',
  'function supply(uint256,uint256,uint256,uint256)', 'function releaseEarnings(uint256,uint256,uint256,uint256)',
]);
const SECURITY = 1_500_000_000n;
const RESERVE = 1_000_000n;
const DEPOSIT = SECURITY + RESERVE;
const key = (owner: Address) => `shared-pool-earnings:${owner.toLowerCase()}`;
type Call = { chainId: 46630; to: Address; data: Hex; value: '0x0'; nonce: number; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
type PreparedEarnings = { calls: Call[]; expiresAt: number; pendingHash?: Hex; pendingAt?: number; pendingNonce?: number };
type ReadyEarnings = { status: 'ready'; escrow: Address; vault: Address; usd: Address; transactionHashes: Hex[] };
type EarningsSetup = { status: 'starting'; vault: Address; usd: Address; landlord: Address; arbitrator: Address; deploy: SignedFundingStep; accept: SignedFundingStep; escrow?: Address };
type EarningsRecord = ReadyEarnings | EarningsSetup;
type PrepareClient = Pick<typeof rpc, 'readContract' | 'getBalance' | 'getTransactionReceipt' | 'request' | 'getTransactionCount' | 'estimateFeesPerGas'>;
const PENDING_UNKNOWN_AGE_MS = 120_000;

/** Deployment configuration, never a request Host header, controls this local-only capability. */
export function shareEarningsEnabled(environment: Record<string, string | undefined> = process.env) {
  return environment.NODE_ENV !== 'production' && operatorTestCapability(environment);
}
function assertEnabled() {
  if (!shareEarningsEnabled()) throw new Error('The earnings rehearsal is available only in local test mode.');
}

/** The operator is the disclosed test landlord; it never funds the tenant or manufactures yield. */
export async function startShareEarnings(store: Store, wallet: string) {
  assertEnabled();
  const owner = getAddress(wallet);
  const previous = await store.get<EarningsRecord>(key(owner));
  if (previous?.status === 'ready') {
    const journal = await store.get<EarningsSetup>(`${key(owner)}:setup`);
    if (journal) await releaseOperatorNonceLaneIfOwned(store, journal.landlord, key(owner));
    return previous;
  }
  const market = await loadSharedMarketManifest();
  if (!market) throw new Error('The shared market has not been deployed.');
  const dir = resolve(/* turbopackIgnore: true */ process.env.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet');
  const load = async (role: string) => privateKeyToAccount((await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ dir, `${role}.key`), 'utf8')).trim() as Hex, { nonceManager });
  const [landlord, arbitrator] = await Promise.all([load('operator'), load('arbitrator')]);
  if (owner === landlord.address || owner === arbitrator.address) throw new Error('The tenant must use their own wallet, separate from the test parties.');
  const artifact = JSON.parse(await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ 'contracts/evm/out/RentalEscrow.sol/RentalEscrow.json'), 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };
  await verifySharedMarket(market);
  const journal: EarningsSetup = previous ?? { status: 'starting', vault: market.pool, usd: market.usd, landlord: landlord.address, arbitrator: arbitrator.address, deploy: {}, accept: {} };
  if (journal.vault.toLowerCase() !== market.pool.toLowerCase() || journal.usd.toLowerCase() !== market.usd.toLowerCase() ||
      journal.landlord !== landlord.address || journal.arbitrator !== arbitrator.address)
    throw new Error('The earnings setup configuration changed; reconcile the original journal first.');
  const signer = createWalletClient({ chain: rpc.chain, account: landlord, transport: http() });
  const sign = async (data: Hex, to?: Address) => {
    const nonce = await rpc.getTransactionCount({ address: landlord.address, blockTag: 'pending' });
    const [gas, fees] = await Promise.all([rpc.estimateGas({ account: landlord, data, to, value: 0n }), rpc.estimateFeesPerGas()]);
    return signer.signTransaction({ type: 'eip1559', chainId: 46630, nonce, data, to, value: 0n,
      gas: reviewedOperatorGas(gas, to ? 'transfer' : 'deploy'), ...reviewedOperatorFees(fees) });
  };
  await acquireOperatorNonceLane(store, landlord.address, key(owner));
  if (!previous) await store.create<EarningsRecord>(key(owner), journal);
  const persist = async () => { await store.update<EarningsRecord>(key(owner), () => journal); };
  try {
    const deployed = await executeFundingStep(journal.deploy, () => sign(encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [{
      asset: journal.usd, vault: journal.vault, tenant: owner, landlord: journal.landlord, arbitrator: journal.arbitrator,
      personalWallet: owner, securityRequirement: SECURITY, fundingReserve: RESERVE, earningsReleaseAllowed: true,
      agreementHash: keccak256(encodePacked(['string', 'address', 'address'], ['Local shared-pool earnings rehearsal', owner, journal.vault])),
    }] })), persist, rpc);
    journal.escrow = (await rpc.getTransactionReceipt({ hash: deployed })).contractAddress ?? undefined;
    if (!journal.escrow) throw new Error('The earnings agreement was not deployed.');
    await persist();
    const accept = await executeFundingStep(journal.accept, () => sign(encodeFunctionData({
      abi: EARNINGS_ESCROW_ABI, functionName: 'acceptAgreement', args: [0n, BigInt(Math.floor(Date.now() / 1000) + 3600)],
    }), journal.escrow), persist, rpc);
    const value: ReadyEarnings = { status: 'ready', escrow: journal.escrow, vault: journal.vault, usd: journal.usd, transactionHashes: [deployed, accept] };
    const journalKey = `${key(owner)}:setup`;
    if (await store.get(journalKey)) await store.update(journalKey, () => journal);
    else await store.create(journalKey, journal);
    await store.update<EarningsRecord>(key(owner), () => value);
    await releaseOperatorNonceLaneIfOwned(store, landlord.address, key(owner));
    return value;
  } catch (error) {
    // Unsigned failures consumed no nonce; signed/ambiguous steps retain the lane for exact replay.
    if (!journal.deploy.signed && !journal.accept.signed) await releaseOperatorNonceLaneIfOwned(store, landlord.address, key(owner));
    throw error;
  }
}

export async function readShareEarnings(store: Store, wallet: string, readClient: Pick<typeof rpc, 'readContract'> = rpc) {
  assertEnabled();
  const item = await store.get<EarningsRecord>(key(getAddress(wallet)));
  if (!item) return null;
  if (item.status === 'starting') return { status: 'starting' as const, vault: item.vault, usd: item.usd, escrow: item.escrow };
  const [state, nonce, tracked, releasable, released] = await Promise.all([
    readClient.readContract({ address: item.escrow, abi: EARNINGS_ESCROW_ABI, functionName: 'state' }),
    readClient.readContract({ address: item.escrow, abi: EARNINGS_ESCROW_ABI, functionName: 'nonce' }),
    readClient.readContract({ address: item.escrow, abi: EARNINGS_ESCROW_ABI, functionName: 'trackedShares' }),
    readClient.readContract({ address: item.escrow, abi: EARNINGS_ESCROW_ABI, functionName: 'releasableEarnings' }),
    readClient.readContract({ address: item.escrow, abi: EARNINGS_ESCROW_ABI, functionName: 'releasedEarnings' }),
  ]);
  return { status: 'ready' as const, escrow: item.escrow, vault: item.vault, state: Number(state), nonce: nonce.toString(), supplied: tracked > 0n,
    releasableAtomic: releasable.toString(), releasedAtomic: released.toString(), securityAtomic: SECURITY.toString(), fundingAtomic: DEPOSIT.toString() };
}

export async function prepareShareEarnings(store: Store, wallet: string, operation: string, client: PrepareClient = rpc, now = Date.now) {
  assertEnabled();
  const owner = getAddress(wallet);
  const bindingKey = `${key(owner)}:prepared`;
  const previous = await store.get<PreparedEarnings>(bindingKey);
  if (previous?.pendingHash) {
    try { await client.getTransactionReceipt({ hash: previous.pendingHash }); }
    catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      const [known, latestNonce] = await Promise.all([
        client.request({ method: 'eth_getTransactionByHash', params: [previous.pendingHash] }),
        client.getTransactionCount({ address: owner, blockTag: 'latest' }),
      ]);
      const consumed = previous.pendingNonce !== undefined && latestNonce > previous.pendingNonce;
      const dropped = known === null && previous.pendingAt !== undefined && now() - previous.pendingAt >= PENDING_UNKNOWN_AGE_MS;
      if (!consumed && !dropped) throw new Error(`Your earnings transaction is pending: ${previous.pendingHash}`);
    }
    await store.update<PreparedEarnings>(bindingKey, (value) => {
      if (value.pendingHash !== previous.pendingHash) throw new Error('The pending earnings transaction changed.');
      return { ...value, pendingHash: undefined, pendingAt: undefined, pendingNonce: undefined };
    });
  }
  const entry = await store.get<EarningsRecord>(key(owner));
  if (!entry) throw new Error('Set up the local earnings agreement first.');
  if (entry.status === 'starting') throw new Error('The local earnings agreement is still being prepared. Resume setup first.');
  if (await client.getBalance({ address: owner }) <= 0n)
    throw new Error('No test ETH for network fees. Get test ETH from the Robinhood faucet first.');
  const status = (await readShareEarnings(store, owner, client))!;
  if (status.status !== 'ready') throw new Error('The local earnings agreement is still being prepared. Resume setup first.');
  const nonce = BigInt(status.nonce);
  const deadline = BigInt(Math.floor(now() / 1000) + 3600);
  const calls: { to: Address; data: Hex; description: string }[] = [];
  if (operation === 'mint') calls.push({ to: entry.usd, data: encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [owner, DEPOSIT] }), description: 'Mint your own 1,501 test dollars (no monetary value)' });
  else if (operation === 'accept' && status.state === 0) calls.push({ to: entry.escrow, data: encodeFunctionData({ abi: EARNINGS_ESCROW_ABI, functionName: 'acceptAgreement', args: [nonce, deadline] }), description: 'Accept the local test-landlord agreement' });
  else if (operation === 'fund' && status.state === 1) {
    const allowance = await client.readContract({ address: entry.usd, abi: tokenAbi, functionName: 'allowance', args: [owner, entry.escrow] });
    if (allowance < DEPOSIT) calls.push({ to: entry.usd, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [entry.escrow, DEPOSIT] }), description: 'Approve only your test deposit' });
    calls.push({ to: entry.escrow, data: encodeFunctionData({ abi: EARNINGS_ESCROW_ABI, functionName: 'fund', args: [nonce, deadline] }), description: 'Fund your RentalEscrow' });
  } else if (operation === 'supply' && status.state === 2 && !status.supplied) {
    const quoted = await client.readContract({ address: entry.vault, abi: vaultAbi, functionName: 'previewDeposit', args: [DEPOSIT] });
    // Borrower interest advances between preparation and mining; allow one basis point.
    const minimum = quoted * 9_999n / 10_000n;
    calls.push({ to: entry.escrow, data: encodeFunctionData({ abi: EARNINGS_ESCROW_ABI, functionName: 'supply', args: [DEPOSIT, minimum, nonce, deadline] }), description: 'Supply the deposit to the shared lending pool' });
  } else if (operation === 'claim' && status.state === 2 && status.supplied) {
    const amount = BigInt(status.releasableAtomic);
    if (amount <= 0n) throw new Error('No borrower interest is releasable yet. Interest is real, small, and withdrawals require pool cash.');
    calls.push({ to: entry.escrow, data: encodeFunctionData({ abi: EARNINGS_ESCROW_ABI, functionName: 'releaseEarnings', args: [amount, 2n ** 256n - 1n, nonce, deadline] }), description: 'Claim actual borrower interest to your wallet' });
  } else throw new Error('This earnings step is not ready.');
  const fees = await client.estimateFeesPerGas();
  let transactionNonce = await client.getTransactionCount({ address: owner, blockTag: 'pending' });
  const steps = calls.map((call) => ({ description: call.description, transaction: {
    chainId: 46630 as const, to: call.to, data: call.data, value: '0x0' as const, nonce: transactionNonce++, gas: '0x927c0' as Hex,
    maxFeePerGas: `0x${(fees.maxFeePerGas! * 2n).toString(16)}` as Hex,
    maxPriorityFeePerGas: `0x${(fees.maxPriorityFeePerGas ?? 0n).toString(16)}` as Hex,
  } }));
  const binding: PreparedEarnings = { calls: steps.map(({ transaction }) => transaction), expiresAt: Number(deadline) };
  if (await store.get(bindingKey)) await store.update<PreparedEarnings>(bindingKey, (value) => {
    if (value.pendingHash) throw new Error('Your earnings transaction is still pending.');
    return binding;
  });
  else await store.create(bindingKey, binding);
  return steps;
}

export function assertPreparedEarningsCall(transaction: { chainId?: number; to?: Address | null; data?: Hex; value?: bigint; nonce?: number; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; accessList?: readonly unknown[] }, calls: Call[]) {
  if (transaction.chainId !== 46630 || (transaction.value ?? 0n) !== 0n || !transaction.to || (transaction.accessList?.length ?? 0) !== 0 ||
    !calls.some((call) => call.to.toLowerCase() === transaction.to!.toLowerCase() && call.data === transaction.data && call.nonce === (transaction.nonce ?? 0) &&
      transaction.gas === BigInt(call.gas) && transaction.maxFeePerGas === BigInt(call.maxFeePerGas) && (transaction.maxPriorityFeePerGas ?? 0n) === BigInt(call.maxPriorityFeePerGas)))
    throw new Error('Only the exact prepared earnings call can be submitted.');
  decodeFunctionData({ abi: [...tokenAbi, ...EARNINGS_ESCROW_ABI], data: transaction.data! });
}

export async function submitShareEarnings(store: Store, wallet: string, signed: string, client: Pick<typeof rpc, 'sendRawTransaction' | 'waitForTransactionReceipt' | 'request'> = rpc, now = Date.now) {
  assertEnabled();
  const owner = getAddress(wallet);
  const bindingKey = `${key(owner)}:prepared`;
  const binding = await store.get<PreparedEarnings>(bindingKey);
  if (!binding || binding.expiresAt < now() / 1000 || !/^0x02[0-9a-fA-F]+$/.test(signed) || signed.length > 20_000)
    throw new Error('Prepare your earnings transaction first.');
  if (binding.pendingHash) throw new Error(`Your earnings transaction is pending: ${binding.pendingHash}`);
  const serialized = signed as `0x02${string}`;
  const transaction = parseTransaction(serialized);
  if ((await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== owner.toLowerCase()) throw new Error('Sign with your own tenant wallet.');
  assertPreparedEarningsCall(transaction, binding.calls);
  const hash = keccak256(serialized);
  await store.update<PreparedEarnings>(bindingKey, (value) => {
    if (value.pendingHash || value.expiresAt < now() / 1000) throw new Error('The prepared earnings request is no longer available.');
    assertPreparedEarningsCall(transaction, value.calls);
    return { ...value, calls: value.calls.filter((call) => call.nonce !== (transaction.nonce ?? 0)), pendingHash: hash, pendingAt: now(), pendingNonce: transaction.nonce ?? 0 };
  });
  try { await client.sendRawTransaction({ serializedTransaction: serialized }); }
  catch (error) {
    // Only a successful null lookup proves this node refused the bytes.
    // A known hash or failed lookup must retain the pending reservation.
    const known = await client.request({ method: 'eth_getTransactionByHash', params: [hash] }).catch(() => undefined);
    if (known === null) await store.update<PreparedEarnings>(bindingKey, (value) => value.pendingHash === hash
      ? { ...binding, pendingHash: undefined, pendingAt: undefined, pendingNonce: undefined }
      : value);
    throw error;
  }
  const confirmed = await client.waitForTransactionReceipt({ hash });
  await store.update<PreparedEarnings>(bindingKey, (value) => {
    if (value.pendingHash !== hash) throw new Error('The pending earnings transaction changed.');
    return { ...value, pendingHash: undefined, pendingAt: undefined, pendingNonce: undefined };
  });
  if (confirmed.status !== 'success') throw new Error(`Earnings transaction failed: ${hash}`);
  return { hash };
}
