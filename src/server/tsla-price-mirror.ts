import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BaseError, ContractFunctionZeroDataError, createPublicClient, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodMainnet } from '../finance/robinhood/manifest.ts';
import { referencePrice, type ReferencePrice } from './reference-price.ts';
import { executeFundingStep, type SignedFundingStep } from './local-investment-provisioning.ts';
import { acquireOperatorNonceLane, releaseOperatorNonceLaneIfOwned } from './operator-nonce-lane.ts';
import { reviewedOperatorFees, reviewedOperatorGas } from './ownership-gas.ts';
import type { Store } from './store.ts';

export const SOURCE_FEED = getAddress('0x4A1166a659A55625345e9515b32adECea5547C38');
const MAINNET_TSLA = getAddress('0x322F0929c4625eD5bAd873c95208D54E1c003b2d');
const TEST_STOCK = getAddress('0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E');
const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function updater() view returns (address)',
  'function latest() view returns (uint80,int256,uint256,uint256,uint256)',
  'function initialAnswer() view returns (uint256)',
  'function MAX_STEP_BPS() view returns (uint256)',
  'function MIN_PUSH_INTERVAL() view returns (uint256)',
  'function push(uint80 sourceRoundId,int256 answer,uint256 sourceUpdatedAt,uint256 sourceMultiplier)',
]);
const stockAbi = parseAbi(['function uiMultiplier() view returns (uint256)', 'function paused() view returns (bool)', 'function oraclePaused() view returns (bool)']);
const mainnetRpc = createPublicClient({ transport: http(robinhoodMainnet.rpcUrl, { timeout: 15000, retryCount: 0 }) });
const testnetRpc = createPublicClient({ transport: http('https://rpc.testnet.chain.robinhood.com', { timeout: 15000, retryCount: 0 }) });
export type PriceMirrorManifest = { chainId: number; feed: Address };
type Rpc = Pick<typeof testnetRpc, 'readContract' | 'getChainId' | 'getBlock' | 'getTransactionCount' | 'estimateFeesPerGas' | 'estimateGas' | 'getTransactionReceipt' | 'sendRawTransaction' | 'waitForTransactionReceipt'>;
type Journal = { signer: Address; feed: Address; round: string; rawMainnetAnswer: string; mainnetMultiplier: string; testnetMultiplier: string; convertedAnswer: string; state: 'pending' | 'done'; crossCheck: 'passed'; step: SignedFundingStep };
type Options = { environment?: Record<string, string | undefined>; loadManifest?: () => Promise<PriceMirrorManifest | null>; mainnet?: Pick<Rpc, 'readContract' | 'getChainId'>; testnet?: Rpc; reference?: () => Promise<ReferencePrice>; now?: () => number };

async function readTestMultiplier(rpc: Pick<Rpc, 'readContract'>) {
  try { return await rpc.readContract({ address: TEST_STOCK, abi: stockAbi, functionName: 'uiMultiplier' }); }
  catch (error) {
    // Only an absent selector gets the unscaled basis; RPC errors remain fail-closed.
    if (error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionZeroDataError) instanceof ContractFunctionZeroDataError) return 10n ** 18n;
    throw error;
  }
}

async function loadManifest(): Promise<PriceMirrorManifest | null> {
  try {
    const value = JSON.parse(await readFile(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ process.cwd(), 'contracts/evm/deployments/shared-market-46630.json'), 'utf8'));
    return { chainId: value.chainId, feed: getAddress(value.oracle) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('The shared market deployment manifest is invalid.');
  }
}

/** Matches the immutable pool window: Saturday 00:00 through Monday 12:00 UTC. */
export function priceFreshnessSeconds(now: number): number {
  const date = new Date(now * 1000);
  const day = date.getUTCDay();
  return day === 6 || day === 0 || (day === 1 && date.getUTCHours() < 12) ? 74 * 3600 : 26 * 3600;
}

// The durable lane coordinates different operator operations; this queue also prevents
// simultaneous requests in this web process from signing the same price journal twice.
let running: Promise<unknown> = Promise.resolve();
export function reconcileTslaPrice(store: Store, options: Options = {}) {
  const next = running.then(() => reconcile(store, options));
  running = next.catch(() => {});
  return next;
}

async function reconcile(store: Store, options: Options) {
  const skip = (reason: string) => ({ status: 'skipped', reason, nextCursor: null });
  const raw = (options.environment ?? process.env).ROBINHOOD_PRICE_UPDATER_PRIVATE_KEY;
  if (!raw) return { status: 'unconfigured', reason: 'Missing dedicated price updater key.', nextCursor: null };
  let signer;
  try { signer = privateKeyToAccount(raw as Hex); }
  catch { return { status: 'unconfigured', reason: 'Invalid dedicated price updater key.', nextCursor: null }; }
  const manifest = await (options.loadManifest ?? loadManifest)();
  if (!manifest) return { status: 'unconfigured', reason: 'Shared market not deployed yet.', nextCursor: null };
  if (manifest.chainId !== 46630) throw new Error('The price mirror must be deployed on chain 46630.');
  const feed = getAddress(manifest.feed);
  const rpc = options.testnet ?? testnetRpc;
  const source = options.mainnet ?? mainnetRpc;
  const chains = await Promise.all([source.getChainId(), rpc.getChainId()]).catch(() => null);
  if (!chains) return skip('rpc_chain_unavailable');
  if (chains[0] !== 4663) return skip('source_chain_mismatch');
  if (chains[1] !== 46630) return skip('testnet_chain_mismatch');
  const updater = await rpc.readContract({ address: feed, abi: feedAbi, functionName: 'updater' });
  if (getAddress(updater) !== signer.address) return { status: 'unconfigured', reason: 'Key is not the immutable feed updater.', nextCursor: null };
  const key = `tsla-price-mirror:46630:${feed.toLowerCase()}`;
  const previous = await store.get<Journal>(key);
  const finish = async (journal: Journal, sign: () => Promise<Hex>) => {
    if (journal.signer !== signer.address || journal.feed !== feed) throw new Error('Price journal signer or feed changed.');
    await acquireOperatorNonceLane(store, signer.address, key);
    const hash = await executeFundingStep(journal.step, sign, async () => {
      await store.update<Journal>(key, () => journal);
    }, rpc);
    await store.update<Journal>(key, (value) => ({ ...value, state: 'done' }));
    await releaseOperatorNonceLaneIfOwned(store, signer.address, key);
    return { status: 'pushed', sourceRoundId: journal.round, rawMainnetAnswer: journal.rawMainnetAnswer,
      mainnetMultiplier: journal.mainnetMultiplier, testnetMultiplier: journal.testnetMultiplier,
      convertedAnswer: journal.convertedAnswer, crossCheck: journal.crossCheck, transactionHash: hash, nextCursor: null };
  };
  // Recover exactly the persisted signed transaction, never sign a replacement nonce.
  if (previous?.state === 'pending' && previous.step.signed)
    return finish(previous, async () => { throw new Error('Signed price push must not be replaced.'); });
  if (previous?.state === 'done') await releaseOperatorNonceLaneIfOwned(store, signer.address, key);
  const now = Math.floor((options.now ?? (() => Date.now() / 1000))());
  const snapshot = await Promise.all([
    source.readContract({ address: SOURCE_FEED, abi: feedAbi, functionName: 'latestRoundData' }),
    rpc.readContract({ address: feed, abi: feedAbi, functionName: 'latest' }),
    source.readContract({ address: MAINNET_TSLA, abi: stockAbi, functionName: 'uiMultiplier' }),
    readTestMultiplier(rpc),
    source.readContract({ address: MAINNET_TSLA, abi: stockAbi, functionName: 'paused' }),
    source.readContract({ address: MAINNET_TSLA, abi: stockAbi, functionName: 'oraclePaused' }),
    rpc.readContract({ address: feed, abi: feedAbi, functionName: 'initialAnswer' }),
    rpc.readContract({ address: feed, abi: feedAbi, functionName: 'MAX_STEP_BPS' }),
    rpc.readContract({ address: feed, abi: feedAbi, functionName: 'MIN_PUSH_INTERVAL' }),
    rpc.getBlock({ blockTag: 'latest' }),
  ]).catch(() => null);
  if (!snapshot) return skip('source_read_unavailable');
  const [round, mirrored, multiplier, testMultiplier, paused, oraclePaused, initialAnswer, maxStepBps, minPushInterval, block] = snapshot;
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  if (roundId <= mirrored[0]) return skip('same_or_older_round');
  if (paused || oraclePaused) return skip('source_paused');
  if (multiplier <= 0n || testMultiplier <= 0n) return skip('invalid_multiplier');
  if (roundId === 0n || answer <= 0n || answer > 100_000_000_000_000n || answeredInRound < roundId || updatedAt === 0n || updatedAt > BigInt(now + 300)) return skip('invalid_source_round');
  if (BigInt(now) - updatedAt > BigInt(priceFreshnessSeconds(now))) return skip('stale_source_round');
  if (updatedAt <= mirrored[2]) return skip('nonincreasing_source_time');
  const pricePerShare = answer * 10n ** 18n / multiplier;
  const convertedAnswer = pricePerShare * testMultiplier / (10n ** 18n);
  if (convertedAnswer <= 0n || convertedAnswer > 100_000_000_000_000n) return skip('invalid_converted_price');
  if (mirrored[0] > 0n && block.timestamp < mirrored[4] + minPushInterval) return skip('push_interval');
  const movementAnchor = mirrored[0] === 0n ? initialAnswer : mirrored[1];
  const delta = convertedAnswer >= movementAnchor ? convertedAnswer - movementAnchor : movementAnchor - convertedAnswer;
  if (movementAnchor <= 0n || delta * 10_000n > movementAnchor * maxStepBps) return skip('hourly_movement_bound');
  let reference: ReferencePrice | undefined;
  try { reference = await (options.reference ?? (() => referencePrice(TSLAX)))(); }
  catch { return skip('reference_unavailable'); }
  const age = reference ? now - Date.parse(reference.observedAt) / 1000 : NaN;
  const referenceFresh = reference && !reference.stale && Number.isFinite(age) && age >= -5 && age <= 120 && Number.isFinite(reference.usdPrice) && reference.usdPrice > 0;
  if (!referenceFresh) return skip('reference_stale');
  if (reference && referenceFresh && Math.abs(Number(pricePerShare) / 1e8 - reference.usdPrice) / reference.usdPrice > 0.05) return skip('reference_divergence');
  const crossCheck = 'passed' as const;
  const data = encodeFunctionData({ abi: feedAbi, functionName: 'push', args: [roundId, convertedAnswer, updatedAt, testMultiplier] });
  await acquireOperatorNonceLane(store, signer.address, key);
  const journal: Journal = { signer: signer.address, feed, round: roundId.toString(), rawMainnetAnswer: answer.toString(),
    mainnetMultiplier: multiplier.toString(), testnetMultiplier: testMultiplier.toString(),
    convertedAnswer: convertedAnswer.toString(), state: 'pending', crossCheck, step: {} };
  if (previous) await store.update<Journal>(key, () => journal);
  else await store.create(key, journal);
  try { return await finish(journal, async () => {
    const [nonce, fees, gas] = await Promise.all([
      rpc.getTransactionCount({ address: signer.address, blockTag: 'pending' }), rpc.estimateFeesPerGas(),
      rpc.estimateGas({ account: signer.address, to: feed, data, value: 0n }),
    ]);
    if (await readTestMultiplier(rpc) !== testMultiplier) {
      const error = new Error('The test token multiplier changed before signing.');
      error.name = 'TestMultiplierChanged';
      throw error;
    }
    if (await rpc.getChainId() !== 46630) {
      const error = new Error('The testnet RPC chain changed before signing.');
      error.name = 'TestnetChainChanged';
      throw error;
    }
    return signer.signTransaction({ type: 'eip1559', chainId: 46630, nonce, to: feed, data, value: 0n,
      gas: reviewedOperatorGas(gas, 'transfer'), ...reviewedOperatorFees(fees) });
  }); } catch (error) {
    if (error instanceof Error && ['TestMultiplierChanged', 'TestnetChainChanged'].includes(error.name) && !journal.step.signed) {
      await releaseOperatorNonceLaneIfOwned(store, signer.address, key);
      return skip(error.name === 'TestMultiplierChanged' ? 'testnet_multiplier_changed' : 'testnet_chain_mismatch');
    }
    throw error;
  }
}
