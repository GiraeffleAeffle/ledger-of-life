import { address } from '@solana/kit';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { SHARES_PRICE_AUTHORITY, SHARES_PROGRAM_ID, SHARES_INITIALIZER, DAILY_FAUCET_BUDGET, DEBT_EXPOSURE_CAP, sharesAddresses } from '../finance/solana/shares.ts';

/** Explicit devnet cutover only; absent configuration preserves the Robinhood path. */
export type SolanaSharesManifest = {
  cluster: 'devnet'; genesisHash: string; programId: string; cashMint: string;
  shareMint: string; price: string; priceAuthority: string; initializer: string; pool: string; cashVault: string; collateralVault: string; faucetBudget: string;
  initialPriceUsdE6: string; initialPricePublishedAt: string; dailyFaucetBudgetAtomic: string; debtExposureCapAtomic: string;
};
export async function parseSolanaSharesManifest(raw: string | undefined | null): Promise<SolanaSharesManifest | null> {
  if (raw == null || raw.trim() === '') return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('SOLANA_SHARES_MANIFEST must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid shares manifest object');
  const manifest = value as Record<string, unknown>;
  if (manifest.cluster !== 'devnet' || manifest.genesisHash !== SOLANA_DEVNET_MANIFEST.genesisHash) throw new Error('Shares require the devnet genesis');
  if (manifest.programId !== SHARES_PROGRAM_ID || manifest.cashMint !== SOLANA_TEST_USDC_MINT || manifest.priceAuthority !== SHARES_PRICE_AUTHORITY || manifest.initializer !== SHARES_INITIALIZER) throw new Error('Shares program, cash mint or authority mismatch');
  if (manifest.dailyFaucetBudgetAtomic !== DAILY_FAUCET_BUDGET.toString() || manifest.debtExposureCapAtomic !== DEBT_EXPOSURE_CAP.toString()) throw new Error('Shares faucet or debt exposure cap mismatch');
  for (const field of ['initialPriceUsdE6', 'initialPricePublishedAt']) {
    if (typeof manifest[field] !== 'string' || !/^[1-9][0-9]*$/.test(manifest[field])) throw new Error(`Invalid shares manifest ${field}`);
  }
  if (BigInt(manifest.initialPriceUsdE6 as string) > 1_000_000_000_000n || BigInt(manifest.initialPricePublishedAt as string) > (1n << 63n) - 1n) throw new Error('Initial shares price or timestamp out of range');
  for (const field of ['programId', 'cashMint', 'priceAuthority', 'initializer', 'shareMint', 'price', 'pool', 'cashVault', 'collateralVault', 'faucetBudget']) {
    if (typeof manifest[field] !== 'string') throw new Error(`Missing shares manifest ${field}`);
    address(manifest[field]);
  }
  const derived = await sharesAddresses();
  for (const field of ['shareMint', 'price', 'pool', 'cashVault', 'collateralVault', 'faucetBudget'] as const) {
    if (manifest[field] !== derived[field]) throw new Error(`Shares manifest ${field} is not its program PDA`);
  }
  return { cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, programId: SHARES_PROGRAM_ID, cashMint: SOLANA_TEST_USDC_MINT, priceAuthority: SHARES_PRICE_AUTHORITY, initializer: SHARES_INITIALIZER, initialPriceUsdE6: manifest.initialPriceUsdE6 as string, initialPricePublishedAt: manifest.initialPricePublishedAt as string, dailyFaucetBudgetAtomic: DAILY_FAUCET_BUDGET.toString(), debtExposureCapAtomic: DEBT_EXPOSURE_CAP.toString(), ...derived };
}
export function solanaSharesConfiguration(env: Record<string, string | undefined> = process.env) {
  return parseSolanaSharesManifest(env.SOLANA_SHARES_MANIFEST);
}
