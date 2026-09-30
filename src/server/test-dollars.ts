import { createPublicClient, decodeFunctionData, defineChain, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError, type Hex, type TransactionReceipt } from 'viem';
import { TEST_USDG_ADDRESS } from '../wallets/inference-token.ts';
import type { Store } from './store.ts';

export const TEST_DOLLAR_ADDRESS = getAddress(TEST_USDG_ADDRESS);
export const MAX_TEST_DOLLARS = 10_000_000_000n;
export const TEST_DOLLAR_AMOUNT = 1_000_000_000n;
export const TEST_DOLLAR_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address) view returns (uint256)']);
const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const rpc = createPublicClient({ chain, transport: http(undefined, { timeout: 10_000, retryCount: 0 }) });
const PREPARE_INTERVAL_MS = 60_000;
const PREPARED_LIFETIME_MS = 120_000;
const RECEIPT_TIMEOUT_MS = 10_000;
type PreparedTransaction = {
  chainId: 46630; to: string; data: Hex; value: '0x0'; nonce: number;
  gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex;
};
type MintRecord = {
  nextPrepareAt: number; submitWindowAt: number; submitAttempts: number;
  preparingUntil?: number; prepared?: { transaction: PreparedTransaction; expiresAt: number };
  pendingHash?: Hex; pendingAt?: number; pendingNonce?: number;
};
type PrepareClient = Pick<typeof rpc, 'getBalance' | 'estimateFeesPerGas' | 'getTransactionCount' | 'estimateGas' | 'getTransactionReceipt' | 'request'>;
type Broadcast = Pick<typeof rpc, 'sendRawTransaction' | 'waitForTransactionReceipt' | 'readContract' | 'request'>;

/**
 * Persist attempt limits and the exact two-minute signing review using the library desk's
 * atomic Store.update reservation pattern. A pending hash blocks another mint until mined,
 * its nonce is consumed, or the node no longer knows it after two minutes.
 */
export async function prepareTestDollars(store: Store, wallet: string, client: PrepareClient = rpc, now = Date.now) {
  const owner = getAddress(wallet);
  const key = `test-dollars:${owner.toLowerCase()}`;
  try { await store.create<MintRecord>(key, { nextPrepareAt: 0, submitWindowAt: 0, submitAttempts: 0 }); }
  catch { if (!await store.get(key)) throw new Error('Could not reserve test dollar request.'); }
  const reservation = await store.update<MintRecord>(key, (record) => {
    const time = now();
    if (time < record.nextPrepareAt) throw new Error('Wait one minute between test dollar requests.');
    if (record.preparingUntil && time < record.preparingUntil) throw new Error('A test dollar request is already being prepared.');
    if (record.prepared && time < record.prepared.expiresAt) throw new Error('Sign or wait for your current test dollar request to expire.');
    return { ...record, nextPrepareAt: time + PREPARE_INTERVAL_MS, preparingUntil: time + PREPARED_LIFETIME_MS, prepared: undefined };
  });
  try {
    if (reservation.pendingHash) {
      try {
        await client.getTransactionReceipt({ hash: reservation.pendingHash });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        const [known, latestNonce] = await Promise.all([
          client.request({ method: 'eth_getTransactionByHash', params: [reservation.pendingHash] }),
          client.getTransactionCount({ address: owner, blockTag: 'latest' }),
        ]);
        const nonceConsumed = reservation.pendingNonce !== undefined && latestNonce > reservation.pendingNonce;
        const dropped = known === null && reservation.pendingAt !== undefined && now() - reservation.pendingAt >= PREPARED_LIFETIME_MS;
        if (!nonceConsumed && !dropped) throw new Error('Your test dollar mint is still pending. Refresh your balance later.');
      }
      await store.update<MintRecord>(key, (record) => ({ ...record, pendingHash: undefined, pendingAt: undefined, pendingNonce: undefined }));
    }
    if (await client.getBalance({ address: owner }) === 0n)
      throw new Error('No test ETH for network fees. Get test ETH from the Robinhood faucet first.');
    const data = encodeFunctionData({ abi: TEST_DOLLAR_ABI, functionName: 'mint', args: [owner, TEST_DOLLAR_AMOUNT] });
    const [fees, nonce, gas] = await Promise.all([
      client.estimateFeesPerGas(), client.getTransactionCount({ address: owner, blockTag: 'pending' }),
      client.estimateGas({ account: owner, to: TEST_DOLLAR_ADDRESS, data }),
    ]);
    const transaction: PreparedTransaction = {
      chainId: 46630, to: TEST_DOLLAR_ADDRESS, data, value: '0x0', nonce,
      gas: `0x${(gas * 120n / 100n).toString(16)}`,
      maxFeePerGas: `0x${(fees.maxFeePerGas! * 2n).toString(16)}`,
      maxPriorityFeePerGas: `0x${(fees.maxPriorityFeePerGas ?? 0n).toString(16)}`,
    };
    const expiresAt = now() + PREPARED_LIFETIME_MS;
    await store.update<MintRecord>(key, (record) => ({ ...record, preparingUntil: undefined, prepared: { transaction, expiresAt } }));
    return { description: 'Get 1,000 tUSDG test dollars (no value)', expiresAt: new Date(expiresAt).toISOString(), transaction };
  } catch (error) {
    await store.update<MintRecord>(key, (record) => ({ ...record, preparingUntil: undefined }));
    throw error;
  }
}

/** Only broadcast a verified wallet's exact, recently prepared, capped, zero-value mint. */
export async function submitTestDollars(store: Store, wallet: string, signed: string, client: Broadcast = rpc, now = Date.now) {
  const owner = getAddress(wallet);
  const key = `test-dollars:${owner.toLowerCase()}`;
  if (!await store.get(key)) throw new Error('Prepare your test dollar transaction first.');
  const record = await store.update<MintRecord>(key, (value) => {
    const time = now();
    const attempts = time - value.submitWindowAt >= PREPARE_INTERVAL_MS ? 0 : value.submitAttempts;
    if (attempts >= 3) throw new Error('Too many test dollar submissions. Wait one minute.');
    return { ...value, submitWindowAt: attempts === 0 ? time : value.submitWindowAt, submitAttempts: attempts + 1 };
  });
  if (record.pendingHash) throw new Error('Your test dollar mint is still pending. Refresh your balance later.');
  if (!record.prepared) throw new Error('Prepare your test dollar transaction first.');
  if (now() >= record.prepared.expiresAt) throw new Error('Your test dollar transaction expired. Prepare it again.');
  if (!/^0x02[0-9a-fA-F]+$/.test(signed) || signed.length > 20_000) throw new Error('Invalid signed test transaction.');
  const serialized = signed as `0x02${string}`;
  const transaction = parseTransaction(serialized);
  if (transaction.chainId !== 46630) throw new Error('Use Robinhood Chain testnet.');
  if (!transaction.to || transaction.to.toLowerCase() !== TEST_DOLLAR_ADDRESS.toLowerCase()) throw new Error('Not a test dollar transaction.');
  if ((transaction.value ?? 0n) !== 0n) throw new Error('Test dollar mint must not send ETH.');
  const call = decodeFunctionData({ abi: TEST_DOLLAR_ABI, data: transaction.data ?? '0x' });
  if (call.functionName !== 'mint') throw new Error('Only minting test dollars is allowed.');
  const [to, amount] = call.args;
  if (to.toLowerCase() !== owner.toLowerCase() || amount <= 0n || amount > MAX_TEST_DOLLARS)
    throw new Error('Mint only to your own wallet, between zero and 10,000 tUSDG.');
  if ((await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== owner.toLowerCase())
    throw new Error('This transaction was not signed by your Robinhood testnet wallet.');
  const prepared = record.prepared.transaction;
  if (transaction.nonce !== prepared.nonce || transaction.gas !== BigInt(prepared.gas)
    || transaction.maxFeePerGas !== BigInt(prepared.maxFeePerGas)
    // viem parses a zero priority fee (RLP 0x) as absent; Robinhood testnet often has a zero priority fee.
    || (transaction.maxPriorityFeePerGas ?? 0n) !== BigInt(prepared.maxPriorityFeePerGas)
    || transaction.data?.toLowerCase() !== prepared.data.toLowerCase()
    || (transaction.accessList?.length ?? 0) !== 0)
    throw new Error('Signed transaction does not match your prepared test dollar request.');
  const hash = keccak256(serialized);
  // Reserve before broadcasting: even an ambiguous RPC failure must not allow another mint.
  await store.update<MintRecord>(key, (value) => {
    if (value.pendingHash || !value.prepared || now() >= value.prepared.expiresAt
      || JSON.stringify(value.prepared) !== JSON.stringify(record.prepared))
      throw new Error('Your test dollar request is no longer available. Refresh your balance.');
    return { ...value, prepared: undefined, pendingHash: hash, pendingAt: now(), pendingNonce: prepared.nonce };
  });
  try {
    await client.sendRawTransaction({ serializedTransaction: serialized as Hex });
  } catch (error) {
    // Only a successful null lookup proves this node did not accept the bytes.
    // A lookup failure or a known hash leaves the reservation in place.
    const known = await client.request({ method: 'eth_getTransactionByHash', params: [hash] }).catch(() => undefined);
    if (known === null) {
      await store.update<MintRecord>(key, (value) => value.pendingHash === hash
        ? { ...value, prepared: record.prepared, pendingHash: undefined, pendingAt: undefined, pendingNonce: undefined }
        : value);
    }
    throw error;
  }
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new WaitForTransactionReceiptTimeoutError({ hash })), RECEIPT_TIMEOUT_MS);
  let receipt: TransactionReceipt;
  try {
    receipt = await Promise.race([
      client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }),
      timeout.promise,
    ]);
  } catch (error) {
    if (error instanceof WaitForTransactionReceiptTimeoutError) return { hash, status: 'pending' as const };
    throw error;
  } finally { clearTimeout(timer); }
  await store.update<MintRecord>(key, (value) => ({ ...value, pendingHash: undefined, pendingAt: undefined, pendingNonce: undefined }));
  if (receipt.status !== 'success') throw new Error('The test dollar mint failed.');
  const balance = await client.readContract({ address: TEST_DOLLAR_ADDRESS, abi: TEST_DOLLAR_ABI, functionName: 'balanceOf', args: [owner] });
  return { hash, status: 'confirmed' as const, testUsdAtomic: balance.toString() };
}
