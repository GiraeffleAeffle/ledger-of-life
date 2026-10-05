import { createHash } from 'node:crypto';
import { keccak256, parseAbi } from 'viem';
import { decodePrice, isPriceFresh, priceMaxAge, setPriceInstruction, sharesAddresses, SHARES_PRICE_AUTHORITY, SHARES_PROGRAM_ID, type SharesPrice } from '../finance/solana/shares.ts';
import { SOLANA_DEVNET_MANIFEST } from '../finance/solana/manifest.ts';
import { createBaseSolanaGateway, type BaseSolanaGateway } from './solana-rpc.ts';
import { configuredSolanaOperations, type SolanaOperations } from './solana-operations.ts';
import { loadSharedMarketManifest, sharedMarketRpc } from './shared-market.ts';
import type { SolanaSharesManifest } from './solana-shares-config.ts';
import type { Store } from './store.ts';

type Mirror = { priceUsdE6: bigint; publishedAt: bigint; sourceLabel: string };
export type SolanaPriceMirrorOptions = {
  operations?: SolanaOperations;
  gateway?: Pick<BaseSolanaGateway, 'multiple' | 'checkedGenesis'>;
  readMirror?: () => Promise<Mirror>;
  now?: () => number;
  environment?: Record<string, string | undefined>;
};
const feedAbi = parseAbi(['function latestPrice() view returns (uint256,uint256)']);

/** Read the deployed Robinhood testnet mirror, never the mainnet source or a quote fallback. */
async function readRobinhoodMirror(): Promise<Mirror> {
  const manifest = await loadSharedMarketManifest();
  if (!manifest || await sharedMarketRpc.getChainId() !== manifest.chainId) throw new Error('Robinhood mirror unavailable');
  const code = await sharedMarketRpc.getCode({ address: manifest.oracle });
  if (!code || code === '0x' || keccak256(code).toLowerCase() !== manifest.codeHashes.oracle.toLowerCase()) throw new Error('Robinhood mirror code changed');
  const [priceUsdE6, publishedAt] = await sharedMarketRpc.readContract({ address: manifest.oracle, abi: feedAbi, functionName: 'latestPrice' });
  return { priceUsdE6, publishedAt, sourceLabel: 'Robinhood Chain testnet TSLA mirror' };
}

/** A pending signature is not a usable price: only a fresh, validated chain read is. */
export async function ensureSolanaSharesPrice(store: Store, manifest: SolanaSharesManifest, options: SolanaPriceMirrorOptions = {}): Promise<{ price: SharesPrice; fresh: boolean; updated: boolean; signature?: string; reason?: string }> {
  const environment = options.environment ?? process.env;
  const time = Math.floor((options.now ?? (() => Date.now() / 1000))());
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid price mirror clock');
  const now = BigInt(time);
  const derived = await sharesAddresses();
  if (manifest.cluster !== 'devnet' || manifest.genesisHash !== SOLANA_DEVNET_MANIFEST.genesisHash || manifest.programId !== SHARES_PROGRAM_ID || manifest.priceAuthority !== SHARES_PRICE_AUTHORITY || manifest.shareMint !== derived.shareMint || manifest.price !== derived.price) throw new Error('Invalid shares price manifest');
  if (!options.gateway && !environment.SOLANA_RPC_URL) throw new Error('Solana price RPC unavailable');
  const gateway = options.gateway ?? createBaseSolanaGateway({ rpcUrl: environment.SOLANA_RPC_URL!, genesisHash: manifest.genesisHash, maximumSponsorLamports: '10000000' });
  async function readPrice() {
    if (await gateway.checkedGenesis() !== manifest.genesisHash) throw new Error('Shares price genesis mismatch');
    const { accounts } = await gateway.multiple([manifest.price]);
    const account = accounts[0];
    if (!account || account.address !== manifest.price || account.owner !== manifest.programId || account.executable) throw new Error('Shares price account unavailable or wrong program');
    const price = decodePrice(account.data);
    if (price.shareMint !== manifest.shareMint || price.authority !== SHARES_PRICE_AUTHORITY || price.initialPriceUsdE6.toString() !== manifest.initialPriceUsdE6 || price.initialPublishedAt.toString() !== manifest.initialPricePublishedAt) throw new Error('Shares price account bindings changed');
    if (price.priceUsdE6 <= 0n || price.priceUsdE6 > 1_000_000_000_000n || price.publishedAt <= 0n || price.copiedAt <= 0n) throw new Error('Invalid shares price account');
    return price;
  }
  const price = await readPrice();
  const unavailable = (reason: string, signature?: string) => ({ price, fresh: false, updated: false, reason, ...(signature ? { signature } : {}) });
  if (price.publishedAt > now || price.copiedAt > now) return unavailable('price_future');
  if (isPriceFresh(price, now)) return { price, fresh: true, updated: false };
  // Pin the source to this chain snapshot before sponsorship. A newer upstream
  // round must not create a second write while the first signature is unresolved.
  const snapshotKey = `solana-shares-price-source:${createHash('sha256').update([manifest.genesisHash, manifest.price, price.priceUsdE6, price.publishedAt, price.copiedAt].join(':')).digest('hex')}`;
  type SourceSnapshot = { priceUsdE6: string; publishedAt: string; operationId?: string; signature?: string };
  const saved = await store.get<SourceSnapshot>(snapshotKey);
  if (saved?.operationId) {
    let operations = options.operations;
    if (!operations) {
      try {
        const configured = await configuredSolanaOperations(store, { cluster: manifest.cluster, genesisHash: manifest.genesisHash, maximumSponsorLamports: 10_000_000n }, environment);
        if (configured.sponsor.address !== SHARES_PRICE_AUTHORITY) return unavailable('price_sponsor_unavailable', saved.signature);
        operations = configured.operations;
      } catch { return unavailable('price_sponsor_unavailable', saved.signature); }
    }
    const result = await operations.reconcile({ id: saved.operationId });
    const signature = result.signature ?? saved.signature;
    if (result.state !== 'confirmed') return unavailable(result.state === 'failed' || result.state === 'expired' ? `price_update_${result.state}` : 'price_update_pending', signature);
    const observed = await readPrice();
    const fresh = observed.publishedAt <= now && observed.copiedAt <= now && isPriceFresh(observed, now);
    return { price: observed, fresh, updated: observed.publishedAt >= BigInt(saved.publishedAt) && observed.priceUsdE6 === BigInt(saved.priceUsdE6), ...(signature ? { signature } : {}), ...(!fresh ? { reason: 'price_update_not_observed' } : {}) };
  }
  let source: Mirror;
  if (saved) {
    source = { priceUsdE6: BigInt(saved.priceUsdE6), publishedAt: BigInt(saved.publishedAt), sourceLabel: 'Robinhood Chain testnet TSLA mirror' };
  } else {
    try { source = await (options.readMirror ?? readRobinhoodMirror)(); } catch { return unavailable('mirror_unavailable'); }
  }
  if (source.priceUsdE6 <= 0n || source.priceUsdE6 > 1_000_000_000_000n || source.publishedAt <= 0n) return unavailable('mirror_invalid');
  if (source.publishedAt > now) return unavailable('mirror_future');
  if (now - source.publishedAt > priceMaxAge(now)) return unavailable('mirror_stale');
  if (source.publishedAt <= price.publishedAt) return unavailable('mirror_not_newer');
  if (now - price.copiedAt < 3600n) return unavailable('price_update_too_early');
  const delta = source.priceUsdE6 > price.priceUsdE6 ? source.priceUsdE6 - price.priceUsdE6 : price.priceUsdE6 - source.priceUsdE6;
  if (delta * 10_000n > price.priceUsdE6 * 2000n) return unavailable('mirror_out_of_band');
  let operations = options.operations;
  if (!operations) {
    try {
      const configured = await configuredSolanaOperations(store, { cluster: manifest.cluster, genesisHash: manifest.genesisHash, maximumSponsorLamports: 10_000_000n }, environment);
      if (configured.sponsor.address !== SHARES_PRICE_AUTHORITY) return unavailable('price_sponsor_unavailable');
      operations = configured.operations;
    } catch { return unavailable('price_sponsor_unavailable'); }
  }
  if (!saved) {
    try {
      await store.create<SourceSnapshot>(snapshotKey, { priceUsdE6: source.priceUsdE6.toString(), publishedAt: source.publishedAt.toString() });
    } catch (error) {
      const concurrent = await store.get<SourceSnapshot>(snapshotKey);
      if (!concurrent) throw error;
      source = { priceUsdE6: BigInt(concurrent.priceUsdE6), publishedAt: BigInt(concurrent.publishedAt), sourceLabel: 'Robinhood Chain testnet TSLA mirror' };
    }
  }
  // All fingerprint inputs are immutable snapshots. Repeated prepares recover the same durable write.
  const requestId = `shares-price:${createHash('sha256').update([manifest.price, price.priceUsdE6, price.publishedAt, price.copiedAt, source.priceUsdE6, source.publishedAt].join(':')).digest('hex')}`;
  const instruction = await setPriceInstruction({ authority: SHARES_PRICE_AUTHORITY, priceUsdE6: source.priceUsdE6, publishedAt: source.publishedAt });
  const submitted = await operations.executeAsSponsor({
    kind: 'shares-price-mirror', requestId, instructions: [instruction],
    review: { network: 'solana-devnet', operation: 'copy_test_share_price', authority: SHARES_PRICE_AUTHORITY, priceAccount: manifest.price, shareMint: manifest.shareMint, previousPriceUsdE6: price.priceUsdE6.toString(), previousPublishedAt: price.publishedAt.toString(), previousCopiedAt: price.copiedAt.toString(), priceUsdE6: source.priceUsdE6.toString(), publishedAt: source.publishedAt.toString(), source: 'Robinhood Chain testnet TSLA mirror' },
  });
  await store.update<SourceSnapshot>(snapshotKey, current => ({ ...current, operationId: submitted.id, signature: submitted.signature }));
  const result = submitted.state === 'broadcast' || submitted.state === 'prepared' ? await operations.reconcile({ id: submitted.id }) : submitted;
  const signature = result.signature ?? submitted.signature;
  if (result.state !== 'confirmed') return unavailable(result.state === 'failed' || result.state === 'expired' ? `price_update_${result.state}` : 'price_update_pending', signature);
  const observed = await readPrice();
  const fresh = observed.publishedAt <= now && observed.copiedAt <= now && isPriceFresh(observed, now);
  return { price: observed, fresh, updated: observed.publishedAt >= source.publishedAt && observed.priceUsdE6 === source.priceUsdE6, signature, ...(!fresh ? { reason: 'price_update_not_observed' } : {}) };
}
