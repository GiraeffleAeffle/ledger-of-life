import assert from 'node:assert/strict';
import test from 'node:test';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { SHARES_PROGRAM_ID, SHARES_PRICE_AUTHORITY, SHARES_INITIALIZER, DAILY_FAUCET_BUDGET, DEBT_EXPOSURE_CAP, sharesAddresses } from '../finance/solana/shares.ts';
import { parseSolanaSharesManifest, solanaSharesConfiguration } from './solana-shares-config.ts';

async function manifest() {
  return { cluster:'devnet',genesisHash:SOLANA_DEVNET_MANIFEST.genesisHash,programId:SHARES_PROGRAM_ID,cashMint:SOLANA_TEST_USDC_MINT,priceAuthority:SHARES_PRICE_AUTHORITY,initializer:SHARES_INITIALIZER,initialPriceUsdE6:'370448000',initialPricePublishedAt:'1790970931',dailyFaucetBudgetAtomic:DAILY_FAUCET_BUDGET.toString(),debtExposureCapAtomic:DEBT_EXPOSURE_CAP.toString(),...await sharesAddresses() };
}
test('unset shares manifest preserves the existing chain path', async () => {
  for (const raw of [undefined,null,'','   ']) assert.equal(await parseSolanaSharesManifest(raw),null);
  assert.equal(await solanaSharesConfiguration({}),null);
});
test('devnet manifest validates all derived addresses and returns canonical fields', async () => {
  const valid = await manifest();
  assert.deepEqual(await parseSolanaSharesManifest(JSON.stringify(valid)),valid);
  assert.deepEqual(await solanaSharesConfiguration({ SOLANA_SHARES_MANIFEST:JSON.stringify(valid) }),valid);
  assert.deepEqual(await parseSolanaSharesManifest(JSON.stringify({ ...valid,untrustedExtra:'ignored' })),valid);
});
test('manifest rejects malformed JSON, wrong shape, cluster/genesis and fixed identities', async () => {
  for (const raw of ['{','null','[]','"devnet"','42']) await assert.rejects(parseSolanaSharesManifest(raw));
  const valid = await manifest();
  for (const [field,value] of [['cluster','mainnet-beta'],['cluster','localnet'],['genesisHash','wrong'],['programId',SHARES_PRICE_AUTHORITY],['cashMint',SOLANA_DEVNET_MANIFEST.deposit.mint],['priceAuthority',SHARES_PROGRAM_ID]]) {
    await assert.rejects(parseSolanaSharesManifest(JSON.stringify({ ...valid,[field]:value })));
  }
});
test('every address is required, valid base58 and its exact expected PDA', async () => {
  const valid = await manifest();
  for (const field of ['programId','cashMint','priceAuthority','initializer','shareMint','price','pool','cashVault','collateralVault','faucetBudget']) {
    for (const value of [null,7,'invalid','']) await assert.rejects(parseSolanaSharesManifest(JSON.stringify({ ...valid,[field]:value })));
    const missing: Record<string,unknown> = { ...valid }; delete missing[field];
    await assert.rejects(parseSolanaSharesManifest(JSON.stringify(missing)));
  }
  for (const field of ['shareMint','price','pool','cashVault','collateralVault','faucetBudget']) await assert.rejects(parseSolanaSharesManifest(JSON.stringify({ ...valid,[field]:SHARES_PRICE_AUTHORITY })));
  await assert.rejects(parseSolanaSharesManifest(JSON.stringify({ ...valid,cashVault:valid.collateralVault,collateralVault:valid.cashVault })));
});

test('manifest binds exact faucet budget, aggregate debt cap and immutable initial price', async () => {
  const valid = await manifest();
  for (const field of ['dailyFaucetBudgetAtomic', 'debtExposureCapAtomic', 'initialPriceUsdE6', 'initialPricePublishedAt']) {
    for (const value of [undefined, null, 1, '0', '-1', '01', '1.1']) await assert.rejects(parseSolanaSharesManifest(JSON.stringify({ ...valid, [field]: value })));
  }
  await assert.rejects(parseSolanaSharesManifest(JSON.stringify({ ...valid, dailyFaucetBudgetAtomic: '50000001' })));
  await assert.rejects(parseSolanaSharesManifest(JSON.stringify({ ...valid, debtExposureCapAtomic: '2000000001' })));
  await assert.rejects(parseSolanaSharesManifest(JSON.stringify({ ...valid, initialPriceUsdE6: '1000000000001' })));
  await assert.rejects(parseSolanaSharesManifest(JSON.stringify({ ...valid, initialPricePublishedAt: '9223372036854775808' })));
});
