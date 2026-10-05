import test from 'node:test';
import assert from 'node:assert/strict';
import { houseAddresses } from '../finance/solana/house.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { loadSolanaHouseManifest } from './solana-house-config.ts';
const programId = 'CWUN8LKoKNEBJ6SQAVAqDFrb3rDP7vbVXMcf2EoAqjQM';
async function manifest() { return { cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, programId, cashMint: SOLANA_TEST_USDC_MINT, houses: { 'neighbourhood-homes': await houseAddresses('neighbourhood-homes', programId), workshop: await houseAddresses('workshop', programId) } }; }
test('unset house manifest preserves Robinhood fallback', () => { assert.equal(loadSolanaHouseManifest({}), null); });
test('parses both initialized Solana test houses', async () => { const m = await manifest(); assert.deepEqual(loadSolanaHouseManifest({ SOLANA_HOUSE_MANIFEST: JSON.stringify(m) }), m); });
test('rejects mainnet, wrong genesis, unsupported cash and malformed accounts', async () => {
  const m = await manifest();
  for (const changed of [{ ...m, cluster: 'mainnet-beta' }, { ...m, genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }, { ...m, cashMint: programId }, { ...m, programId: 'not-a-key' }, { ...m, houses: {} }, { ...m, houses: { ...m.houses, workshop: m.houses['neighbourhood-homes'] } }]) assert.throws(() => loadSolanaHouseManifest({ SOLANA_HOUSE_MANIFEST: JSON.stringify(changed) }));
  assert.throws(() => loadSolanaHouseManifest({ SOLANA_HOUSE_MANIFEST: '[]' }));
});
