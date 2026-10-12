import { createHash } from 'node:crypto';
import { after } from 'next/server.js';
import { getStore } from '../../../src/server/store.ts';
import { createBuildingReadCache, loadBuildingManifest, readBuildingView } from '../../../src/server/building-revenue.ts';
import { loadSolanaHouseManifest } from '../../../src/server/solana-house-config.ts';
import { readSolanaBuilding, solanaHouseId } from '../../../src/server/building-solana.ts';
export const runtime='nodejs';
const publicBuildingCache = createBuildingReadCache<Record<string, unknown>>();
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  // Routing intent is independent of manifest validation and RPC availability.
  const environment = {
    SOLANA_HOUSE_MANIFEST: process.env.SOLANA_HOUSE_MANIFEST,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    SOLANA_RPC_FALLBACK_URLS: process.env.SOLANA_RPC_FALLBACK_URLS,
  };
  let network: 'solana-devnet' | 'solana-localnet' | 'robinhood-testnet' = query.get('network') !== 'robinhood' && environment.SOLANA_HOUSE_MANIFEST
    ? 'solana-devnet' : 'robinhood-testnet';
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (network !== 'robinhood-testnet') {
      const manifest = loadSolanaHouseManifest(environment);
      if (!manifest) throw new Error('Solana house is not configured.');
      network = manifest.cluster === 'localnet' ? 'solana-localnet' : 'solana-devnet';
    }
    const houseId = network === 'robinhood-testnet' ? 'neighbourhood-homes' : solanaHouseId(query.get('houseId'));
    const evmManifest = network === 'robinhood-testnet' ? await loadBuildingManifest() : null;
    if (network === 'robinhood-testnet' && !evmManifest) throw new Error('Building staking distributor is not deployed.');
    const key = createHash('sha256').update(JSON.stringify([network, houseId,
      network === 'robinhood-testnet' ? evmManifest : environment])).digest('hex');
    request.signal.throwIfAborted();
    const result = await publicBuildingCache(key, async () => {
      // Shared refreshes have their own aborting budget; a disconnect cannot cancel other readers.
      const signal = AbortSignal.timeout(3_000);
      const building = network !== 'robinhood-testnet'
        ? await readSolanaBuilding(houseId, environment, signal)
        : await readBuildingView(await getStore(), { signal, loadManifest: async () => evmManifest });
      signal.throwIfAborted();
      return building;
    }, after);
    request.signal.throwIfAborted();
    return Response.json({ ...result, network }, { headers });
  } catch {
    return Response.json({ building: null, network, code: 'rpc_unavailable', error: 'Testnetz-RPC derzeit nicht erreichbar' }, { status: 503, headers });
  }
}
