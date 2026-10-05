import { AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Instruction } from '@solana/kit';
import { SOLANA_IDS } from './manifest.ts';

/** No implicit deployment. Server callers pass the validated manifest programId explicitly. */
export const HOUSE_PROGRAM_ID: string | null = (() => {
  const raw = process.env.SOLANA_HOUSE_MANIFEST;
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('programId' in value) || typeof value.programId !== 'string') throw new Error('Invalid house program configuration');
  return address(value.programId);
})();
export const HOUSE_SCALE = 1_000_000_000_000n;
export type HouseAddresses = { house: string; unitMint: string; deskVault: string; rewardVault: string; stakeVault: string };
export type HouseAccount = {
  admin: string; cashMint: string; unitMint: string; id: string;
  bump: number; unitMintBump: number; deskVaultBump: number; rewardVaultBump: number; stakeVaultBump: number;
  priceCashPerUnit: bigint; sellCapUnits: bigint; totalStaked: bigint; rewardPerUnitStored: bigint;
  revenueTotal: bigint; revenueBySource: readonly bigint[]; stakerCount: number;
  rewardDuration: bigint; rewardRate: bigint; periodFinish: bigint; lastUpdateTime: bigint;
  streamRemainingScaled: bigint; undistributedScaled: bigint; rewardRemainderScaled: bigint;
};
export type PositionAccount = { house: string; owner: string; staked: bigint; rewardDebt: bigint; owed: bigint; claimedTotal: bigint; bump: number; rewardFraction: bigint };
const encoder = getAddressEncoder();
const text = (value: string) => new TextEncoder().encode(value);
const key = (value: string) => new Uint8Array(encoder.encode(address(value)));
function program(value?: string): string { const result = value ?? HOUSE_PROGRAM_ID; if (!result) throw new Error('Solana house deployment is not configured'); return address(result); }
async function pda(seeds: Uint8Array[], programId?: string) { return (await getProgramDerivedAddress({ programAddress: address(program(programId)), seeds }))[0]; }
export async function houseAddresses(id: string, programId?: string): Promise<HouseAddresses> {
  if (!/^[\x21-\x7e]{1,32}$/.test(id)) throw new Error('House id must be 1–32 printable ASCII bytes');
  const house = await pda([text('house'), text(id)], programId);
  return addressesForHouse(house, programId);
}
export async function addressesForHouse(house: string, programId?: string): Promise<HouseAddresses> {
  const [unitMint, deskVault, rewardVault, stakeVault] = await Promise.all(['units', 'desk', 'rewards', 'stake'].map(seed => pda([text(seed), key(house)], programId)));
  return { house, unitMint, deskVault, rewardVault, stakeVault };
}
export function positionAddress(house: string, owner: string, programId?: string) { return pda([text('position'), key(house), key(owner)], programId); }
export const HOUSE_DISCRIMINATORS = {
  initialize_house: [180,46,86,125,135,107,214,28], buy_units: [166,179,34,247,254,181,5,159], sell_units: [19,236,169,25,155,72,9,192],
  stake: [206,176,202,18,200,209,179,108], unstake: [90,95,107,42,205,124,50,225], deposit_rewards: [52,249,112,72,206,161,196,1], claim: [62,198,214,193,213,159,108,210],
} as const;
function u64(value: bigint | string) { const n = BigInt(value); if (n < 0n || n > 0xffffffffffffffffn) throw new Error('Amount outside u64'); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; }
function concat(parts: readonly Uint8Array[]) { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; }
const meta = (value: string, role = AccountRole.READONLY) => ({ address: address(value), role });
const rw = (value: string) => meta(value, AccountRole.WRITABLE);
const signer = (value: string) => meta(value, AccountRole.READONLY_SIGNER);
function ix(name: keyof typeof HOUSE_DISCRIMINATORS, accounts: Instruction['accounts'], args: Uint8Array[], programId?: string): Instruction { return { programAddress: address(program(programId)), accounts, data: concat([Uint8Array.from(HOUSE_DISCRIMINATORS[name]), ...args]) }; }
type Base = { house: string; programId?: string };
type Trade = Base & { cashAccount: string; unitAccount: string; units: bigint | string };
export async function buyUnitsInstruction(input: Trade & { buyer: string }): Promise<Instruction> {
  const a = await addressesForHouse(input.house, input.programId);
  return ix('buy_units', [signer(input.buyer), rw(input.house), rw(a.unitMint), rw(input.cashAccount), rw(input.unitAccount), rw(a.deskVault), meta(SOLANA_IDS.token)], [u64(input.units)], input.programId);
}
export async function sellUnitsInstruction(input: Trade & { seller: string }): Promise<Instruction> {
  const a = await addressesForHouse(input.house, input.programId);
  return ix('sell_units', [signer(input.seller), rw(input.house), rw(a.unitMint), rw(input.cashAccount), rw(input.unitAccount), rw(a.deskVault), meta(SOLANA_IDS.token)], [u64(input.units)], input.programId);
}
type Staking = Base & { owner: string; unitAccount: string; units: bigint | string };
export async function stakeInstruction(input: Staking & { payer: string }): Promise<Instruction> {
  const a = await addressesForHouse(input.house, input.programId), position = await positionAddress(input.house, input.owner, input.programId);
  return ix('stake', [signer(input.owner), meta(input.payer, AccountRole.WRITABLE_SIGNER), rw(input.house), rw(position), rw(input.unitAccount), rw(a.stakeVault), meta(SOLANA_IDS.token), meta(SOLANA_IDS.system)], [u64(input.units)], input.programId);
}
export async function unstakeInstruction(input: Staking): Promise<Instruction> {
  const a = await addressesForHouse(input.house, input.programId), position = await positionAddress(input.house, input.owner, input.programId);
  return ix('unstake', [signer(input.owner), rw(input.house), rw(position), rw(input.unitAccount), rw(a.stakeVault), meta(SOLANA_IDS.token)], [u64(input.units)], input.programId);
}
export async function claimInstruction(input: Base & { owner: string; cashAccount: string }): Promise<Instruction> {
  const a = await addressesForHouse(input.house, input.programId), position = await positionAddress(input.house, input.owner, input.programId);
  return ix('claim', [signer(input.owner), rw(input.house), rw(position), rw(input.cashAccount), rw(a.rewardVault), meta(SOLANA_IDS.token)], [], input.programId);
}
export async function depositRewardsInstruction(input: Base & { authority: string; source: string; amount: bigint | string; sourceKind: number }): Promise<Instruction> {
  if (!Number.isInteger(input.sourceKind) || input.sourceKind < 0 || input.sourceKind > 3) throw new Error('Invalid revenue source');
  const a = await addressesForHouse(input.house, input.programId);
  return ix('deposit_rewards', [signer(input.authority), rw(input.house), rw(input.source), rw(a.rewardVault), meta(SOLANA_IDS.token)], [u64(input.amount), Uint8Array.of(input.sourceKind)], input.programId);
}
export async function initializeHouseInstruction(input: { admin: string; cashMint: string; id: string; priceCashPerUnit: bigint | string; sellCapUnits: bigint | string; programId?: string }): Promise<Instruction> {
  const a = await houseAddresses(input.id, input.programId), id = text(input.id), len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, id.length, true);
  return ix('initialize_house', [meta(input.admin, AccountRole.WRITABLE_SIGNER), rw(a.house), meta(input.cashMint), rw(a.unitMint), rw(a.deskVault), rw(a.rewardVault), rw(a.stakeVault), meta(SOLANA_IDS.token), meta(SOLANA_IDS.system), meta('SysvarRent111111111111111111111111111111111')], [len, id, u64(input.priceCashPerUnit), u64(input.sellCapUnits)], input.programId);
}
function reader(bytes: Uint8Array, discriminator: readonly number[], size: number) {
  if (bytes.length !== size || !discriminator.every((n, i) => bytes[i] === n)) throw new Error('Invalid house account encoding');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 8;
  return { key: () => { const k = getAddressDecoder().decode(bytes.slice(offset, offset + 32)); offset += 32; return k; },
    byte: () => bytes[offset++], bytes: (length: number) => { const b = bytes.slice(offset, offset + length); offset += length; return b; },
    u32: () => { const n = view.getUint32(offset, true); offset += 4; return n; },
    u64: () => { const n = view.getBigUint64(offset, true); offset += 8; return n; },
    i64: () => { const n = view.getBigInt64(offset, true); offset += 8; return n; },
    u128: () => { const n = view.getBigUint64(offset, true) + (view.getBigUint64(offset + 8, true) << 64n); offset += 16; return n; } };
}
/** Rust fixed layout: 32-byte padded id + u8 id length, then five bumps. */
export function decodeHouse(bytes: Uint8Array): HouseAccount {
  const r = reader(bytes, [21,145,94,109,254,199,210,151], 314);
  const admin = r.key(), cashMint = r.key(), unitMint = r.key(), idBytes = r.bytes(32), idLength = r.byte();
  if (idLength < 1 || idLength > 32 || idBytes.slice(idLength).some(n => n !== 0)) throw new Error('Invalid house id encoding');
  const id = new TextDecoder('utf-8', { fatal: true }).decode(idBytes.slice(0, idLength)); if (!/^[\x21-\x7e]+$/.test(id)) throw new Error('Invalid house id');
  const bump = r.byte(), unitMintBump = r.byte(), deskVaultBump = r.byte(), rewardVaultBump = r.byte(), stakeVaultBump = r.byte();
  const priceCashPerUnit = r.u64(), sellCapUnits = r.u64(), totalStaked = r.u64(), rewardPerUnitStored = r.u128(), revenueTotal = r.u64();
  const revenueBySource = [r.u64(), r.u64(), r.u64(), r.u64()], stakerCount = r.u32();
  const rewardDuration = r.u64(), rewardRate = r.u128(), periodFinish = r.i64(), lastUpdateTime = r.i64(), streamRemainingScaled = r.u128(), undistributedScaled = r.u128(), rewardRemainderScaled = r.u128();
  return { admin, cashMint, unitMint, id, bump, unitMintBump, deskVaultBump, rewardVaultBump, stakeVaultBump, priceCashPerUnit, sellCapUnits, totalStaked, rewardPerUnitStored, revenueTotal, revenueBySource, stakerCount, rewardDuration, rewardRate, periodFinish, lastUpdateTime, streamRemainingScaled, undistributedScaled, rewardRemainderScaled };
}
export function decodePosition(bytes: Uint8Array): PositionAccount { const r = reader(bytes, [170,188,143,228,122,64,247,208], 129); return { house: r.key(), owner: r.key(), staked: r.u64(), rewardDebt: r.u128(), owed: r.u64(), claimedTotal: r.u64(), bump: r.byte(), rewardFraction: r.u128() }; }
/** Mirrors the EVM/house checkpoint at a chain timestamp (wall-clock approximation by default). */
export function pendingOwed(
  house: Pick<HouseAccount, 'rewardPerUnitStored' | 'totalStaked' | 'periodFinish' | 'lastUpdateTime' | 'streamRemainingScaled' | 'rewardRate' | 'rewardRemainderScaled'>,
  position: Pick<PositionAccount, 'staked' | 'rewardDebt' | 'owed' | 'rewardFraction'>,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): bigint {
  const max128 = (1n << 128n) - 1n;
  let projected = house.rewardPerUnitStored;
  const applicable = nowSeconds < house.periodFinish ? nowSeconds : house.periodFinish;
  if (house.totalStaked > 0n && applicable > house.lastUpdateTime) {
    const emitted = applicable === house.periodFinish ? house.streamRemainingScaled : (applicable - house.lastUpdateTime) * house.rewardRate;
    const available = emitted + house.rewardRemainderScaled;
    if (emitted < 0n || emitted > house.streamRemainingScaled || available > max128) throw new Error('Stream overflow');
    projected += available / house.totalStaked;
  }
  if (projected > max128 || projected < position.rewardDebt) throw new Error('Invalid reward debt');
  const earned = position.staked * (projected - position.rewardDebt) + position.rewardFraction;
  if (earned > max128) throw new Error('Reward overflow');
  const owed = position.owed + earned / HOUSE_SCALE;
  if (owed > (1n << 64n) - 1n) throw new Error('Reward overflow');
  return owed;
}
