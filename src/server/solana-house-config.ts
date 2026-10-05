import { address } from '@solana/kit';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import type { HouseAddresses } from '../finance/solana/house.ts';

export type SolanaHouseManifest = {
  cluster: 'devnet' | 'localnet'; genesisHash: string; programId: string; cashMint: string;
  houses: Record<'neighbourhood-homes' | 'workshop', HouseAddresses>;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Solana house manifest');
  return value as Record<string, unknown>;
}
function publicKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid house address');
  return address(value);
}
export function loadSolanaHouseManifest(environment: Record<string, string | undefined> = process.env): SolanaHouseManifest | null {
  if (!environment.SOLANA_HOUSE_MANIFEST) return null;
  const raw = object(JSON.parse(environment.SOLANA_HOUSE_MANIFEST));
  if (raw.cluster !== 'devnet' && raw.cluster !== 'localnet') throw new Error('House execution supports test networks only');
  if (typeof raw.genesisHash !== 'string' || (raw.cluster === 'devnet' ? raw.genesisHash !== SOLANA_DEVNET_MANIFEST.genesisHash : !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw.genesisHash) || raw.genesisHash === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')) throw new Error('Invalid house test-network genesis');
  const programId = publicKey(raw.programId), cashMint = publicKey(raw.cashMint);
  if (raw.cluster === 'devnet' && cashMint !== SOLANA_TEST_USDC_MINT) throw new Error('House requires site test USDC');
  const rows = object(raw.houses);
  const parse = (id: 'neighbourhood-homes' | 'workshop'): HouseAddresses => {
    const row = object(rows[id]);
    return { house: publicKey(row.house), unitMint: publicKey(row.unitMint), deskVault: publicKey(row.deskVault), rewardVault: publicKey(row.rewardVault), stakeVault: publicKey(row.stakeVault) };
  };
  const houses = { 'neighbourhood-homes': parse('neighbourhood-homes'), workshop: parse('workshop') };
  const keys = Object.values(houses).flatMap(row => Object.values(row));
  if (new Set(keys).size !== keys.length || keys.includes(programId) || keys.includes(cashMint)) throw new Error('House deployment accounts must be distinct');
  return { cluster: raw.cluster, genesisHash: raw.genesisHash, programId, cashMint, houses };
}
