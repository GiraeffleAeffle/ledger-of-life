import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, decodeFunctionData, defineChain, encodeFunctionData, formatUnits, getAddress, http, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, toHex, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import type { Store } from './store.ts';
import { marketShortfall } from '../domain/market-preflight.ts';

export const SHARED_STOCK = getAddress('0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E');
export const SHARED_USD = getAddress('0xA6e10E426A738aEF586dB5191177658D67C78A14');
const SOURCE_FEED = getAddress('0x4A1166a659A55625345e9515b32adECea5547C38');
const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
export const sharedMarketRpc = createPublicClient({ chain, transport: http(undefined, { timeout: 10_000, retryCount: 0 }) });
export const SHARED_TOKEN_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)']);
export const SHARED_POOL_ABI = parseAbi([
  'function asset() view returns (address)', 'function stock() view returns (address)', 'function oracle() view returns (address)',
  'function market() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,uint256)',
  'function position(address) view returns (uint256,uint256,uint256,uint256,uint256,bool)',
  'function balanceOf(address) view returns (uint256)', 'function previewRedeem(uint256) view returns (uint256)', 'function netContributed(address) view returns (int256)', 'function maxWithdraw(address) view returns (uint256)',
  'function borrowersPage(uint256,uint256) view returns (address[])', 'function collateralShortfall() view returns (bool)',
  'function depositCollateral(uint256)', 'function withdrawCollateral(uint256)', 'function borrow(uint256)', 'function repay(uint256)',
  'function deposit(uint256,address) returns (uint256)', 'function withdraw(uint256,address,address) returns (uint256)', 'function redeem(uint256,address,address) returns (uint256)', 'function liquidate(address,uint256)',
]);
const feedAbi = parseAbi(['function latest() view returns (uint80,int256,uint256,uint256,uint256)', 'function latestPrice() view returns (uint256,uint256)']);
const issuerAbi = parseAbi(['function implementation() view returns (address)', 'function ACCESS_CONTROLLED_REGISTRY() view returns (address)', 'function paused() view returns (bool)', 'function isBlocked(address) view returns (bool)']);
const beaconSlot = toHex(BigInt(keccak256(toHex('eip1967.proxy.beacon'))) - 1n, { size: 32 });
export type SharedMarketManifest = { chainId: 46630; usd: Address; stock: Address; oracle: Address; pool: Address; codeHashes: Record<'usd'|'stock'|'oracle'|'pool', Hex>; updater: Address; source: { chainId: 4663; feed: Address }; seed: { receiver: Address; assets: string }; collateralIssuer: { beacon: Address; implementation: Address; registry: Address; codeHashes: Record<'beacon'|'implementation'|'registry', Hex> }; };
type Rpc = typeof sharedMarketRpc;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export async function loadSharedMarketManifest(): Promise<SharedMarketManifest | null> {
  let bytes: string;
  try { bytes = await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ process.env.SHARED_MARKET_MANIFEST_FILE || 'contracts/evm/deployments/shared-market-46630.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const config = JSON.parse(bytes) as SharedMarketManifest;
  assert(config.chainId === 46630 && same(getAddress(config.stock), SHARED_STOCK) && same(getAddress(config.usd), SHARED_USD), 'Invalid shared market assets.');
  assert(config.source.chainId === 4663 && same(getAddress(config.source.feed), SOURCE_FEED), 'Invalid market price source.');
  for (const field of ['usd','stock','oracle','pool'] as const) {
    getAddress(config[field]); assert(/^0x[0-9a-fA-F]{64}$/.test(config.codeHashes[field]), 'Missing market code hash.');
  }
  for (const field of ['beacon','implementation','registry'] as const) {
    getAddress(config.collateralIssuer[field]);
    assert(/^0x[0-9a-fA-F]{64}$/.test(config.collateralIssuer.codeHashes[field]), 'Missing collateral issuer code hash.');
  }
  assert(same(config.seed.receiver, '0x000000000000000000000000000000000000dEaD') && config.seed.assets === '10000000000', 'Invalid burned market seed.');
  return config;
}
export async function verifySharedMarket(config: SharedMarketManifest, client: Rpc = sharedMarketRpc) {
  assert(await client.getChainId() === 46630, 'Wrong shared market network.');
  await Promise.all((['usd','stock','oracle','pool'] as const).map(async field => {
    const code = await client.getCode({ address: config[field] });
    assert(code && code !== '0x' && same(keccak256(code), config.codeHashes[field]), `Shared market ${field} code changed.`);
  }));
  const safety = await readCollateralSafety(config, client);
  const [usd, stock, oracle, usdDecimals, stockDecimals] = await Promise.all([
    client.readContract({ address: config.pool, abi: SHARED_POOL_ABI, functionName: 'asset' }),
    client.readContract({ address: config.pool, abi: SHARED_POOL_ABI, functionName: 'stock' }),
    client.readContract({ address: config.pool, abi: SHARED_POOL_ABI, functionName: 'oracle' }),
    client.readContract({ address: config.usd, abi: SHARED_TOKEN_ABI, functionName: 'decimals' }),
    safety.suspended ? null : client.readContract({ address: config.stock, abi: SHARED_TOKEN_ABI, functionName: 'decimals' }),
  ]);
  assert(same(usd, config.usd) && same(stock, config.stock) && same(oracle, config.oracle) && usdDecimals === 6 && (safety.suspended || stockDecimals === 18), 'Shared market contract bindings changed.');
  return safety;
}

/** Proxy runtime alone does not pin issuer implementation or transfer permissions. */
export async function readCollateralSafety(config: SharedMarketManifest, client: Rpc = sharedMarketRpc, scope?: { custody: Address; participants: Address[]; shortfall: boolean }) {
  const suspensionReasons: string[] = [];
  const pins = config.collateralIssuer;
  try {
    const [slot, implementation, registry, paused, blocked, shortfall, hashes] = await Promise.all([
      client.getStorageAt({ address: config.stock, slot: beaconSlot }),
      client.readContract({ address: pins.beacon, abi: issuerAbi, functionName: 'implementation' }),
      client.readContract({ address: config.stock, abi: issuerAbi, functionName: 'ACCESS_CONTROLLED_REGISTRY' }),
      client.readContract({ address: config.stock, abi: issuerAbi, functionName: 'paused' }),
      scope
        ? Promise.all([scope.custody, ...scope.participants].map(address => client.readContract({ address: pins.registry, abi: issuerAbi, functionName: 'isBlocked', args: [address] }))).then(values => values.some(Boolean))
        : client.readContract({ address: pins.registry, abi: issuerAbi, functionName: 'isBlocked', args: [config.pool] }),
      scope ? scope.shortfall : client.readContract({ address: config.pool, abi: SHARED_POOL_ABI, functionName: 'collateralShortfall' }),
      Promise.all((['beacon','implementation','registry'] as const).map(async field => {
        const code = await client.getCode({ address: pins[field] });
        return Boolean(code && code !== '0x' && same(keccak256(code), pins.codeHashes[field]));
      })),
    ]);
    if (!slot || !same(`0x${slot.slice(-40)}`, pins.beacon)) suspensionReasons.push('TSLA beacon changed from the pinned deployment.');
    if (!same(implementation, pins.implementation)) suspensionReasons.push('TSLA implementation changed from the pinned deployment.');
    if (!same(registry, pins.registry)) suspensionReasons.push('TSLA access registry changed from the pinned deployment.');
    if (hashes.some(matched => !matched)) suspensionReasons.push('TSLA issuer contract code changed from the pinned deployment.');
    if (paused) suspensionReasons.push('Robinhood has paused test TSLA transfers.');
    if (blocked) suspensionReasons.push(scope ? 'Robinhood has blocked a deposit party or escrow.' : 'Robinhood has blocked the shared pool.');
    if (shortfall) suspensionReasons.push(scope ? 'Deposit TSLA custody is below recorded custody (issuer burn or other shortfall).' : 'Pool TSLA collateral is below the recorded collateral (issuer burn or other shortfall).');
  } catch {
    suspensionReasons.push('TSLA issuer safety could not be verified.');
  }
  return { suspended: suspensionReasons.length > 0, suspensionReasons };
}
export async function readSharedMarket(wallet: string, client: Rpc = sharedMarketRpc, configLoader = loadSharedMarketManifest, now = Date.now) {
  const owner = getAddress(wallet);
  const config = await configLoader();
  const disclaimer = 'tUSDG is test dollars anyone can mint; it has no monetary value. Robinhood can pause, block, burn or upgrade its test TSLA.';
  if (!config) {
    const [shares, dollars] = await Promise.all([
      client.readContract({ address: SHARED_STOCK, abi: SHARED_TOKEN_ABI, functionName: 'balanceOf', args: [owner] }).catch(() => null),
      client.readContract({ address: SHARED_USD, abi: SHARED_TOKEN_ABI, functionName: 'balanceOf', args: [owner] }).catch(() => null),
    ]);
    return { enabled: false, status: 'not_deployed' as const, suspended: false, suspensionReasons: [] as string[], error: 'Shared market not deployed yet.', disclaimer, stockSymbol: 'official test TSLA', deployment: null, sharesRaw: shares?.toString() ?? null, testUsdAtomic: dollars?.toString() ?? null, priceAtomic: null, walletValueAtomic: null, price: null, pool: null, loan: null, lender: null };
  }
  const safety = await verifySharedMarket(config, client);
  const readPool = <N extends 'market'|'position'|'balanceOf'|'netContributed'|'maxWithdraw'>(functionName: N, args?: readonly unknown[]) => client.readContract({ address: config.pool, abi: SHARED_POOL_ABI, functionName, args } as Parameters<Rpc['readContract']>[0]);
  const [shares, dollars, market, position, lenderShares, contributed, maxWithdraw, latest] = await Promise.all([
    client.readContract({ address: config.stock, abi: SHARED_TOKEN_ABI, functionName: 'balanceOf', args: [owner] }).catch(error => {
      if (!safety.suspended) throw error;
      return null;
    }),
    client.readContract({ address: config.usd, abi: SHARED_TOKEN_ABI, functionName: 'balanceOf', args: [owner] }),
    readPool('market'), readPool('position', [owner]), readPool('balanceOf', [owner]), readPool('netContributed', [owner]), readPool('maxWithdraw', [owner]),
    client.readContract({ address: config.oracle, abi: feedAbi, functionName: 'latest' }),
  ]);
  const m = market as readonly [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,boolean,bigint];
  const p = position as readonly [bigint,bigint,bigint,bigint,bigint,boolean];
  const value = await client.readContract({ address: config.pool, abi: SHARED_POOL_ABI, functionName: 'previewRedeem', args: [lenderShares as bigint] });
  const time = Math.floor(now() / 1000); const date = new Date(time * 1000);
  const day = date.getUTCDay(); const weekendFreshnessWindow = day === 6 || day === 0 || (day === 1 && date.getUTCHours() < 12);
  const usablePrice = latest[0] !== 0n && m[8] && !safety.suspended;
  return { enabled: true, status: safety.suspended ? 'suspended' as const : 'ready' as const, ...safety, error: null, disclaimer, stockSymbol: 'official test TSLA', deployment: { pool: config.pool, oracle: config.oracle, stock: config.stock, usd: config.usd }, sharesRaw: shares?.toString() ?? null, testUsdAtomic: dollars.toString(), priceAtomic: usablePrice ? m[6].toString() : null, walletValueAtomic: usablePrice && shares !== null ? (shares * m[6] / 10n**18n).toString() : null,
    price: latest[0] === 0n ? null : { sourceRoundId: latest[0].toString(), sourceUpdatedAt: Number(latest[2]), pushedAt: Number(latest[4]), ageSeconds: Math.max(0, time - Number(latest[2])), stale: !m[8], weekendFreshnessWindow, sourceFeed: config.source.feed, sourceChainId: config.source.chainId, testTokenMultiplier: latest[3].toString() },
    pool: { cashAtomic: m[0].toString(), totalAssetsAtomic: m[1].toString(), borrowedAtomic: m[2].toString(), utilizationBps: Number(m[3]), borrowAprBps: Number(m[4]), supplyAprBps: Number(m[5]), effectiveBorrowApyBps: Number(m[9]) },
    loan: { sharesRaw: p[0].toString(), debtAtomic: p[1].toString(), valueAtomic: usablePrice ? p[2].toString() : null, ltvBps: Number(p[3]), availableAtomic: safety.suspended ? '0' : p[4].toString(), priceFresh: p[5] },
    lender: { sharesRaw: String(lenderShares), netContributedAtomic: String(contributed), valueAtomic: value.toString(), earnedAtomic: (value - (contributed as bigint)).toString(), maxWithdrawAtomic: String(maxWithdraw) } };
}

export type UnhealthyLoanPage = { loans: { borrower: Address; debtAtomic: string; sharesRaw: string; ltvBps: number }[]; nextCursor: string | null; scanned: number; observedAt: number; suspended: boolean; suspensionReasons: string[] };
const unhealthyCache = new Map<string, { value: UnhealthyLoanPage; expiresAt: number }>();
const unhealthyReads = new Map<string, { promise: Promise<UnhealthyLoanPage>; deadline: number }>();
const PAGE_SIZE = 20;
const PAGE_BUDGET_MS = 5_000;

/** A separate, rate-limited discovery request never delays a person's wallet snapshot. */
export async function readUnhealthyLoans(store: Store, wallet: string, cursor = '0', pageSize = PAGE_SIZE, client: Rpc = sharedMarketRpc, configLoader = loadSharedMarketManifest, now = Date.now): Promise<UnhealthyLoanPage> {
  assert(/^(0|[1-9][0-9]{0,19})$/.test(cursor) && BigInt(cursor) < 2n**64n, 'Invalid liquidation page cursor.');
  assert(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= PAGE_SIZE, 'Liquidation page size must be between 1 and 20.');
  const key = `unhealthy-loan-read:${getAddress(wallet).toLowerCase()}`;
  try { await store.create(key, { nextReadAt: 0 }); }
  catch { assert(await store.get(key), 'Could not reserve liquidation read.'); }
  await store.update<{ nextReadAt: number }>(key, value => {
    assert(now() >= value.nextReadAt, 'Wait ten seconds between liquidation page reads.');
    return { nextReadAt: now() + 10_000 };
  });
  const config = await configLoader();
  assert(config, 'Shared market not deployed yet.');
  const cacheKey = `${config.pool}:${config.oracle}:${cursor}:${pageSize}`;
  const cached = unhealthyCache.get(cacheKey);
  if (cached && now() < cached.expiresAt) return cached.value;
  let pending = unhealthyReads.get(cacheKey);
  if (!pending) {
    assert(unhealthyReads.size < 4, 'Liquidation discovery is busy. Try again later.');
    const deadline = now() + PAGE_BUDGET_MS;
    const promise = (async (): Promise<UnhealthyLoanPage> => {
      const safety = await verifySharedMarket(config, client);
      assert(now() < deadline, 'Liquidation page read exceeded its time budget.');
      if (safety.suspended) return { loans: [], nextCursor: null, scanned: 0, observedAt: Math.floor(now() / 1000), ...safety };
      // One bounded lookahead tells the UI whether another page exists, without counting the registry.
      const addresses = await client.readContract({ address: config.pool, abi: SHARED_POOL_ABI, functionName: 'borrowersPage', args: [BigInt(cursor), BigInt(pageSize + 1)] });
      assert(addresses.length <= pageSize + 1, 'Pool returned an oversized borrower page.');
      const selected = addresses.slice(0, pageSize);
      const loans: UnhealthyLoanPage['loans'] = [];
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
        while (index < selected.length) {
          assert(now() < deadline, 'Liquidation page read exceeded its time budget.');
          const borrower = selected[index++];
          const position = await client.readContract({ address: config.pool, abi: SHARED_POOL_ABI, functionName: 'position', args: [borrower] });
          if (position[5] && position[1] > 0n && position[3] >= 8000n)
            loans.push({ borrower, debtAtomic: position[1].toString(), sharesRaw: position[0].toString(), ltvBps: Number(position[3]) });
        }
      }));
      assert(now() < deadline, 'Liquidation page read exceeded its time budget.');
      loans.sort((a, b) => a.borrower.toLowerCase().localeCompare(b.borrower.toLowerCase()));
      return { loans, nextCursor: addresses.length > pageSize ? (BigInt(cursor) + BigInt(pageSize)).toString() : null, scanned: selected.length, observedAt: Math.floor(now() / 1000), ...safety };
    })();
    pending = { promise, deadline };
    unhealthyReads.set(cacheKey, pending);
    void promise.then(value => {
      if (unhealthyCache.size >= 32) unhealthyCache.delete(unhealthyCache.keys().next().value!);
      unhealthyCache.set(cacheKey, { value, expiresAt: now() + 10_000 });
    }).catch(() => undefined).finally(() => unhealthyReads.delete(cacheKey));
  }
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error('Liquidation page read exceeded its time budget.')), Math.max(0, pending.deadline - now()));
  try { return await Promise.race([pending.promise, timeout.promise]); }
  finally { clearTimeout(timer); }
}

type ReviewedTransaction = { chainId: 46630; to: Address; data: Hex; value: '0x0'; nonce: number; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
type MarketRecord = { nextPrepareAt: number; submitWindowAt: number; submitAttempts: number; preparingUntil?: number; prepared?: { transaction: ReviewedTransaction; expiresAt: number; operation: string; quantity: string; borrower?: string; approval: boolean }; pendingHash?: Hex; pendingAt?: number; pendingNonce?: number };
/** Said when the pool would revert an action that passed the balance checks; the rules are the pool's. */
const REFUSAL_HINTS: Record<string, string> = {
  borrow: 'Borrowing is limited to 50% of your collateral’s value and 90% pool utilization, and needs a fresh price.',
  withdraw_collateral: 'While you owe dollars, the collateral left must keep the loan within 50% of its value.',
  unlend: 'Dollars that borrowers are using come back as they repay.',
  liquidate: 'Only loans above 80% of their collateral’s value can be liquidated.',
};

/** Semantic validation remains independent of persisted review binding. */
export function validateMarketCall(transaction: { chainId?: number; to?: string | null; data?: Hex; value?: bigint }, owner: Address, config: SharedMarketManifest) {
  assert(transaction.chainId === 46630, 'Use Robinhood Chain testnet.');
  assert((transaction.value ?? 0n) === 0n, 'Market calls must not send ETH.');
  assert(transaction.to, 'Market contract creation is not allowed.');
  const data = transaction.data ?? '0x';
  if (same(transaction.to, config.stock) || same(transaction.to, config.usd)) {
    const call = decodeFunctionData({ abi: SHARED_TOKEN_ABI, data });
    assert(call.functionName === 'approve', 'Only exact pool approvals are allowed.');
    assert(same(call.args[0], config.pool) && call.args[1] > 0n && call.args[1] < 2n**256n - 1n, 'Approve only the shared pool for an exact positive amount.');
    assert(encodeFunctionData({ abi: SHARED_TOKEN_ABI, functionName: 'approve', args: call.args }).toLowerCase() === data.toLowerCase(), 'Noncanonical approval calldata.');
    return;
  }
  assert(same(transaction.to, config.pool), 'Target is not the shared market.');
  const call = decodeFunctionData({ abi: SHARED_POOL_ABI, data });
  assert(['depositCollateral','withdrawCollateral','borrow','repay','deposit','withdraw','redeem','liquidate'].includes(call.functionName), 'Market selector is not allowed.');
  if (call.functionName === 'deposit') assert(same(call.args[1], owner), 'Deposit receiver must be the signer.');
  if (call.functionName === 'withdraw' || call.functionName === 'redeem')
    assert(same(call.args[1], owner) && same(call.args[2], owner), 'Withdrawal receiver and owner must be the signer.');
  const canonical = encodeFunctionData({ abi: SHARED_POOL_ABI, functionName: call.functionName, args: call.args } as Parameters<typeof encodeFunctionData>[0]);
  assert(canonical.toLowerCase() === data.toLowerCase(), 'Noncanonical market calldata.');
}

export async function prepareMarketAction(store: Store, wallet: string, operation: string, quantity?: string, borrower?: string, client: Rpc = sharedMarketRpc, now = Date.now) {
  const owner = getAddress(wallet);
  assert(typeof quantity === 'string' && /^[1-9][0-9]{0,77}$/.test(quantity), 'Choose a positive atomic amount.');
  const amount = BigInt(quantity); assert(amount < 2n**256n - 1n, 'Amount is too large.');
  assert(['deposit_collateral','withdraw_collateral','borrow','repay','lend','unlend','liquidate'].includes(operation), 'Unknown market operation.');
  const debtor = operation === 'liquidate' ? getAddress(borrower ?? '') : undefined;
  const config = await loadSharedMarketManifest(); assert(config, 'Shared market not deployed yet.');
  const safety = await verifySharedMarket(config, client);
  assert(!safety.suspended || ['lend','repay','unlend'].includes(operation), `Collateral market suspended: ${safety.suspensionReasons.join(' ')}`);
  assert(operation !== 'borrow' || amount >= 1_000_000n, 'The minimum borrow is 1 test dollar.');
  const key = `shared-market:${owner.toLowerCase()}`;
  try { await store.create<MarketRecord>(key, { nextPrepareAt: 0, submitWindowAt: 0, submitAttempts: 0 }); }
  catch { assert(await store.get(key), 'Could not reserve market request.'); }
  const record = await store.update<MarketRecord>(key, value => {
    // Unsigned reviews wait a minute; a confirmed transaction reopens the window (see submit).
    assert(now() >= value.nextPrepareAt, 'Wait one minute between market requests.');
    assert(!value.preparingUntil || now() >= value.preparingUntil, 'A market request is already being prepared.');
    assert(!value.prepared || now() >= value.prepared.expiresAt, 'Sign or wait for your market review to expire.');
    return { ...value, nextPrepareAt: now() + 60_000, preparingUntil: now() + 120_000, prepared: undefined };
  });
  try {
    if (record.pendingHash) {
      try { await client.getTransactionReceipt({ hash: record.pendingHash }); }
      catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        const [known, nonce] = await Promise.all([client.request({ method: 'eth_getTransactionByHash', params: [record.pendingHash] }), client.getTransactionCount({ address: owner, blockTag: 'latest' })]);
        assert((record.pendingNonce !== undefined && nonce > record.pendingNonce) || (known === null && now() - (record.pendingAt ?? now()) >= 120_000), 'Your market transaction is still pending.');
      }
      await store.update<MarketRecord>(key, value => value.pendingHash === record.pendingHash ? { ...value, pendingHash: undefined, pendingAt: undefined, pendingNonce: undefined } : value);
    }
    assert(await client.getBalance({ address: owner }) > 0n, 'Get test ETH from Robinhood’s faucet for network fees.');
    // Before any approval: a person must never sign an approval for an action the pool will refuse.
    const [walletTsla, walletUsd, position, withdrawable] = await Promise.all([
      client.readContract({ address: config.stock, abi: SHARED_TOKEN_ABI, functionName: 'balanceOf', args: [owner] }),
      client.readContract({ address: config.usd, abi: SHARED_TOKEN_ABI, functionName: 'balanceOf', args: [owner] }),
      client.readContract({ address: config.pool, abi: SHARED_POOL_ABI, functionName: 'position', args: [owner] }),
      client.readContract({ address: config.pool, abi: SHARED_POOL_ABI, functionName: 'maxWithdraw', args: [owner] }),
    ]);
    const shortfall = marketShortfall(operation, amount, { walletTsla, walletUsd, collateral: position[0], debt: position[1], available: safety.suspended ? 0n : position[4], withdrawable });
    if (shortfall) throw new Error(shortfall);
    let to = config.pool; let data: Hex; let approval = false;
    const token = operation === 'deposit_collateral' ? config.stock : ['lend','repay','liquidate'].includes(operation) ? config.usd : null;
    if (token && await client.readContract({ address: token, abi: SHARED_TOKEN_ABI, functionName: 'allowance', args: [owner, config.pool] }) < amount) {
      approval = true; to = token; data = encodeFunctionData({ abi: SHARED_TOKEN_ABI, functionName: 'approve', args: [config.pool, amount] });
    } else {
      const method = { deposit_collateral: 'depositCollateral', withdraw_collateral: 'withdrawCollateral', borrow: 'borrow', repay: 'repay', lend: 'deposit', unlend: 'withdraw', liquidate: 'liquidate' }[operation]!;
      const args = operation === 'lend' ? [amount, owner] : operation === 'unlend' ? [amount, owner, owner] : operation === 'liquidate' ? [debtor, amount] : [amount];
      data = encodeFunctionData({ abi: SHARED_POOL_ABI, functionName: method, args } as Parameters<typeof encodeFunctionData>[0]);
    }
    const refused = () => { throw new Error(`The market would refuse this ${operation.replace('_', ' ')} now. ${REFUSAL_HINTS[operation] ?? 'Check your balances and try again.'}`); };
    const [fees, nonce, gas] = await Promise.all([client.estimateFeesPerGas(), client.getTransactionCount({ address: owner, blockTag: 'pending' }), client.estimateGas({ account: owner, to, data }).catch(refused)]);
    assert(fees.maxFeePerGas !== undefined, 'Network did not return fees.');
    const transaction: ReviewedTransaction = { chainId: 46630, to, data, value: '0x0', nonce, gas: `0x${(gas * 120n / 100n).toString(16)}`, maxFeePerGas: `0x${(fees.maxFeePerGas * 2n).toString(16)}`, maxPriorityFeePerGas: `0x${(fees.maxPriorityFeePerGas ?? 0n).toString(16)}` };
    await store.update<MarketRecord>(key, value => ({ ...value, preparingUntil: undefined, prepared: { transaction, expiresAt: now() + 120_000, operation, quantity, borrower: debtor, approval } }));
    const collateralAmount = operation === 'deposit_collateral' || operation === 'withdraw_collateral';
    return { needsApproval: approval, steps: [{ description: `${approval ? 'Approve exact amount for' : 'Sign'} ${operation}: ${formatUnits(amount, collateralAmount ? 18 : 6)} ${collateralAmount ? 'official test TSLA' : 'tUSDG · test dollars anyone can mint'}`, transaction }] };
  } catch (error) {
    await store.update<MarketRecord>(key, value => ({ ...value, preparingUntil: undefined }));
    throw error;
  }
}

export async function submitMarketTransaction(store: Store, wallet: string, signed: string, client: Rpc = sharedMarketRpc, now = Date.now) {
  const owner = getAddress(wallet); const key = `shared-market:${owner.toLowerCase()}`;
  assert(await store.get(key), 'Prepare your market transaction first.');
  const record = await store.update<MarketRecord>(key, value => {
    const attempts = now() - value.submitWindowAt >= 60_000 ? 0 : value.submitAttempts;
    assert(attempts < 3, 'Too many market submissions. Wait one minute.');
    return { ...value, submitWindowAt: attempts === 0 ? now() : value.submitWindowAt, submitAttempts: attempts + 1 };
  });
  assert(!record.pendingHash, 'Your market transaction is still pending.');
  const review = record.prepared; assert(review && now() < review.expiresAt, 'Market signing review expired. Prepare again.');
  assert(/^0x02[0-9a-fA-F]+$/.test(signed) && signed.length <= 20_000, 'Invalid signed market transaction.');
  const serialized = signed as `0x02${string}`; const transaction = parseTransaction(serialized);
  const config = await loadSharedMarketManifest(); assert(config, 'Shared market not deployed yet.');
  const safety = await verifySharedMarket(config, client);
  assert(!safety.suspended || ['lend','repay','unlend'].includes(review.operation), `Collateral market suspended: ${safety.suspensionReasons.join(' ')}`);
  validateMarketCall(transaction, owner, config);
  assert(same(await recoverTransactionAddress({ serializedTransaction: serialized }), owner), 'Transaction was not signed by your verified wallet.');
  const prepared = review.transaction;
  // viem parses a zero priority fee (RLP 0x) as absent; Robinhood testnet often has a zero priority fee.
  assert(same(transaction.to!, prepared.to) && transaction.data?.toLowerCase() === prepared.data.toLowerCase() && transaction.nonce === prepared.nonce && transaction.gas === BigInt(prepared.gas) && transaction.maxFeePerGas === BigInt(prepared.maxFeePerGas) && (transaction.maxPriorityFeePerGas ?? 0n) === BigInt(prepared.maxPriorityFeePerGas) && (transaction.accessList?.length ?? 0) === 0, 'Signed transaction does not match the prepared market review.');
  const hash = keccak256(serialized);
  await store.update<MarketRecord>(key, value => {
    assert(!value.pendingHash && value.prepared && now() < value.prepared.expiresAt && JSON.stringify(value.prepared) === JSON.stringify(review), 'Market review is no longer available.');
    return { ...value, prepared: undefined, pendingHash: hash, pendingAt: now(), pendingNonce: prepared.nonce };
  });
  try { await client.sendRawTransaction({ serializedTransaction: serialized }); }
  catch (error) {
    const known = await client.request({ method: 'eth_getTransactionByHash', params: [hash] }).catch(() => undefined);
    if (known === null) await store.update<MarketRecord>(key, value => value.pendingHash === hash ? { ...value, prepared: review, pendingHash: undefined, pendingAt: undefined, pendingNonce: undefined } : value);
    throw error;
  }
  let receipt;
  // Only this exact transaction settles the review: viem would otherwise resolve with a same-nonce replacement's receipt.
  try { receipt = await client.waitForTransactionReceipt({ hash, timeout: 10_000, confirmations: 1, checkReplacement: false }); }
  catch { return { hash, status: 'pending' as const }; }
  assert(receipt.transactionHash?.toLowerCase() === hash.toLowerCase(), 'Market transaction was replaced by another transaction from your wallet.');
  // A confirmed transaction cost its signer gas and a signature, so the next step or action (the call after an
  // approval, or borrowing right after adding collateral) need not wait; unsigned reviews and reverts still do.
  // Hash-owned: a late completion must not clear a newer pending transaction or reset its windows.
  await store.update<MarketRecord>(key, value => value.pendingHash !== hash ? value : { ...value, pendingHash: undefined, pendingAt: undefined, pendingNonce: undefined, ...(receipt.status === 'success' ? { nextPrepareAt: now(), submitAttempts: 0 } : {}) });
  assert(receipt.status === 'success', 'Market transaction reverted.');
  return { hash, status: 'confirmed' as const };
}
