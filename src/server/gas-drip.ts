import { randomUUID } from 'node:crypto';
import { createPublicClient, defineChain, getAddress, http, keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerializedEIP1559 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GAS_DRIP_THRESHOLD } from '../domain/gas-threshold.ts';
import { acquireOperatorNonceLane, releaseOperatorNonceLaneIfOwned } from './operator-nonce-lane.ts';
import type { Store } from './store.ts';

export const GAS_DRIP_AMOUNT = 50_000_000_000_000n;
export { GAS_DRIP_THRESHOLD } from '../domain/gas-threshold.ts';
export const GAS_DRIP_DAILY_CAP = 200;
const DAY = 86_400_000;
const KEY = 'robinhood-gas-drip:46630';
const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const rpc = createPublicClient({ chain, transport: http(undefined, { timeout: 10_000, retryCount: 0 }) });
type Client = Pick<typeof rpc, 'getChainId' | 'getBalance' | 'getTransactionCount' | 'estimateFeesPerGas' | 'estimateGas' | 'getTransactionReceipt' | 'sendRawTransaction' | 'waitForTransactionReceipt'>;
type Journal = { subject: string; signer: string; at: number; lease: string; busyUntil: number; operation: string; signed?: Hex; hash?: Hex; done?: boolean };
type Ledger = { accounts: Record<string, number>; wallets: Record<string, Journal>; day: string; count: number };
type Options = { environment?: Record<string, string | undefined>; client?: Client; now?: () => number; receiptTimeoutMs?: number };
export function gasDripConfigured(environment: Record<string, string | undefined> = process.env) {
  return Boolean(environment.ROBINHOOD_GAS_DRIP_PRIVATE_KEY?.trim());
}

/** Infrastructure faucet only: subject and wallet must come from the verified server identity. */
export async function dripTestGas(store: Store, subject: string, verifiedWallet: string, options: Options = {}) {
  const environment = options.environment ?? process.env;
  if (!gasDripConfigured(environment)) return { status: 'unconfigured' as const };
  const signer = privateKeyToAccount(environment.ROBINHOOD_GAS_DRIP_PRIVATE_KEY!.trim() as Hex);
  const owner = getAddress(verifiedWallet);
  const walletKey = owner.toLowerCase();
  const now = options.now ?? Date.now;
  const client = options.client ?? rpc;
  const at = now();
  const lease = randomUUID();
  try { await store.create<Ledger>(KEY, { accounts: {}, wallets: {}, day: '', count: 0 }); }
  catch (error) { if (!await store.get(KEY)) throw error; }
  const expired: { signer: string; operation: string }[] = [];
  await store.update<Ledger>(KEY, (value) => {
    for (const [wallet, entry] of Object.entries(value.wallets)) {
      if (!entry.signed && entry.busyUntil <= at) {
        delete value.wallets[wallet];
        if (value.accounts[entry.subject] === entry.at) delete value.accounts[entry.subject];
        if (value.day === new Date(entry.at).toISOString().slice(0, 10)) value.count--;
        expired.push({ signer: entry.signer, operation: entry.operation });
      }
    }
    return value;
  });
  for (const entry of expired) await releaseOperatorNonceLaneIfOwned(store, entry.signer, entry.operation);
  // Any later request can release a mined, previously pending transfer's signer lane.
  // This observes receipts only; it never redirects or replaces another person's signed transfer.
  const outstanding = (await store.get<Ledger>(KEY))!.wallets;
  for (const [recipient, entry] of Object.entries(outstanding)) {
    if (recipient === walletKey || entry.done || !entry.signed || !entry.hash || entry.busyUntil > at) continue;
    let observed;
    try { observed = await client.getTransactionReceipt({ hash: entry.hash }); }
    catch (error) { if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') continue; throw error; }
    if (observed.transactionHash !== entry.hash || keccak256(entry.signed) !== entry.hash)
      throw new Error('Gas drip recovery receipt does not match its journal.');
    let reserved = false;
    await store.update<Ledger>(KEY, (value) => {
      const current = value.wallets[recipient];
      if (current && !current.done && current.hash === entry.hash && current.busyUntil <= at) {
        current.lease = lease; current.busyUntil = at + 60_000; reserved = true;
      }
      return value;
    });
    if (!reserved) continue;
    await releaseOperatorNonceLaneIfOwned(store, entry.signer, entry.operation);
    await store.update<Ledger>(KEY, (value) => {
      if (value.wallets[recipient]?.lease !== lease) throw new Error('Gas drip recovery reservation changed.');
      value.wallets[recipient].done = true; value.wallets[recipient].busyUntil = 0;
      return value;
    });
  }
  // Check only the server-selected recipient. Recovery intentionally bypasses the balance check.
  const previous = (await store.get<Ledger>(KEY))!.wallets[walletKey];
  if ((!previous || previous.done) && await client.getBalance({ address: owner }) >= GAS_DRIP_THRESHOLD)
    return { status: 'sufficient_balance' as const };
  const ledger = await store.update<Ledger>(KEY, (value) => {
    // Keep the atomic limiter bounded; unresolved signed journals must never be pruned.
    for (const [account, lastDrip] of Object.entries(value.accounts)) {
      if (lastDrip + DAY <= at) delete value.accounts[account];
    }
    for (const [wallet, entry] of Object.entries(value.wallets)) {
      if (entry.done && entry.at + DAY <= at) delete value.wallets[wallet];
    }
    const existing = value.wallets[walletKey];
    if (existing && !existing.done) {
      if (existing.subject !== subject) throw new Error('This wallet already has an unresolved gas drip.');
      if (existing.busyUntil > at) throw new Error('A gas drip for this wallet is already in flight.');
      if (existing.signer !== signer.address) throw new Error('Restore the original gas drip signer to recover this transfer.');
      existing.lease = lease; existing.busyUntil = at + 60_000;
      return value;
    }
    if ((value.accounts[subject] ?? -DAY) + DAY > at || (existing && existing.at + DAY > at))
      throw new Error('Test ETH is limited to once per 24 hours per account and wallet.');
    const day = new Date(at).toISOString().slice(0, 10);
    if (value.day !== day) { value.day = day; value.count = 0; }
    if (value.count >= GAS_DRIP_DAILY_CAP) throw new Error('This site has reached its daily test ETH limit. Use the Robinhood faucet.');
    value.count++;
    value.accounts[subject] = at;
    value.wallets[walletKey] = { subject, signer: signer.address, at, lease, busyUntil: at + 60_000, operation: `${KEY}:${walletKey}:${lease}` };
    return value;
  });
  let journal = ledger.wallets[walletKey];
  const operation = journal.operation;
  const persist = async (change: (value: Journal) => Journal) => {
    const result = await store.update<Ledger>(KEY, (value) => {
      if (value.wallets[walletKey]?.lease !== lease) throw new Error('Gas drip reservation changed.');
      value.wallets[walletKey] = change(value.wallets[walletKey]);
      return value;
    });
    journal = result.wallets[walletKey];
  };
  try {
    await acquireOperatorNonceLane(store, signer.address, operation);
    if (await client.getChainId() !== 46630) throw new Error('Gas drips require Robinhood Chain testnet (46630).');
    if (!journal.signed) {
      const nonce = await client.getTransactionCount({ address: signer.address, blockTag: 'pending' });
      const fees = await client.estimateFeesPerGas();
      const gas = await client.estimateGas({ account: signer.address, to: owner, value: GAS_DRIP_AMOUNT });
      // Recheck immediately before signing; neither an RPC misconfiguration nor a funded recipient is eligible.
      if (await client.getChainId() !== 46630) throw new Error('Gas drips require Robinhood Chain testnet (46630).');
      if (await client.getBalance({ address: owner }) >= GAS_DRIP_THRESHOLD) throw new Error('Your wallet already has enough test ETH.');
      const signed = await signer.signTransaction({ chainId: 46630, type: 'eip1559', to: owner, value: GAS_DRIP_AMOUNT, nonce, gas, ...fees });
      await persist((value) => ({ ...value, signed, hash: keccak256(signed) }));
    }
    const signed = journal.signed!;
    const hash = keccak256(signed);
    const transaction = parseTransaction(signed);
    if (journal.hash !== hash || transaction.chainId !== 46630 || transaction.to?.toLowerCase() !== walletKey
      || transaction.value !== GAS_DRIP_AMOUNT || (transaction.data && transaction.data !== '0x')
      || (await recoverTransactionAddress({ serializedTransaction: signed as TransactionSerializedEIP1559 })) !== signer.address)
      throw new Error('Gas drip journal does not match the verified recipient and fixed transfer.');
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash }); }
    catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error; }
    if (!receipt) {
      try { await client.sendRawTransaction({ serializedTransaction: signed }); }
      catch { /* Ambiguous send: retain the exact journal and hash, never replace it. */ }
      const timeout = Promise.withResolvers<never>();
      const timer = setTimeout(() => timeout.reject(new Error('Gas drip receipt timeout.')), options.receiptTimeoutMs ?? 10_000);
      try { receipt = await Promise.race([client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: options.receiptTimeoutMs ?? 10_000 }), timeout.promise]); }
      catch { return { status: 'pending' as const, hash }; }
      finally { clearTimeout(timer); }
    }
    if (receipt.transactionHash !== hash) throw new Error('Gas drip receipt hash does not match.');
    await releaseOperatorNonceLaneIfOwned(store, signer.address, operation);
    await persist((value) => ({ ...value, done: true }));
    if (receipt.status !== 'success') throw new Error('The test ETH transfer failed. Use the Robinhood faucet.');
    return { status: 'confirmed' as const, hash };
  } finally {
    let releaseUnsignedLane = false;
    await store.update<Ledger>(KEY, (value) => {
      const current = value.wallets[walletKey];
      releaseUnsignedLane = !current || current.operation !== operation || !current.signed;
      if (current?.lease !== lease) return value;
      if (!current.signed) {
        // Refund only an unsigned reservation: persisted bytes must survive every ambiguous failure.
        delete value.wallets[walletKey];
        if (value.accounts[subject] === current.at) delete value.accounts[subject];
        if (value.day === new Date(current.at).toISOString().slice(0, 10)) value.count--;
      } else current.busyUntil = 0;
      return value;
    });
    if (releaseUnsignedLane) await releaseOperatorNonceLaneIfOwned(store, signer.address, operation);
  }
}
