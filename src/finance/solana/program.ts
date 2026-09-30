import { AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Instruction } from "@solana/kit";
import { atomic } from "./amounts.ts";
import { isSupportedDepositMint, ledgerDepositMint, SOLANA_IDS, type DeploymentManifest } from "./manifest.ts";
import type { AccountObservation } from "./observations.ts";

const phases = ["awaiting-funding", "active", "claim-proposed", "disputed", "settling", "closed"] as const;
export type TenancyAccount = {
  address: string; leaseId: Uint8Array; tenant: string; landlord: string; arbitrator: string;
  depositMint: string; reserve: string; market: string; receiptMint: string; liquiditySupply: string; marketAuthority: string;
  tenantDestination: string; landlordDestination: string; policyHash: Uint8Array; releasePermitted: boolean;
  requiredSecurityAtomic: string; accountedIdleAtomic: string; accountedReceiptsAtomic: string; releasedEarningsAtomic: string;
  nextNonce: string; claimAtomic: string; approvedClaimAtomic: string; phase: typeof phases[number]; bump: number;
  tenantOwedAtomic: string; landlordOwedAtomic: string;
};
export function decodeTenancy(account: AccountObservation, manifest: DeploymentManifest): TenancyAccount {
  const data = account.data;
  const pull = manifest.escrowVersion === "pull-v2";
  if (account.owner !== manifest.escrowProgram || account.executable || data.length !== (pull ? 499 : 483) || ![251, 53, 106, 214, 69, 170, 131, 234].every((byte, index) => data[index] === byte)) throw new Error("Invalid tenancy account");
  let offset = 8;
  const bytes32 = () => { const bytes = data.slice(offset, offset + 32); offset += 32; return bytes; };
  const key = () => getAddressDecoder().decode(bytes32());
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = () => { const result = view.getBigUint64(offset, true).toString(); offset += 8; return result; };
  const leaseId = bytes32();
  const tenant = key(), landlord = key(), arbitrator = key(), depositMint = key(), reserve = key(), market = key(), receiptMint = key(), liquiditySupply = key(), marketAuthority = key(), tenantDestination = key(), landlordDestination = key();
  const policyHash = bytes32();
  if (data[offset] > 1) throw new Error("Invalid policy encoding");
  const releasePermitted = data[offset++] === 1;
  const requiredSecurityAtomic = u64(), accountedIdleAtomic = u64(), accountedReceiptsAtomic = u64(), releasedEarningsAtomic = u64(), nextNonce = u64(), claimAtomic = u64(), approvedClaimAtomic = u64();
  const phase = phases[data[offset++]]; const bump = data[offset++];
  const tenantOwedAtomic = pull ? u64() : "0", landlordOwedAtomic = pull ? u64() : "0";
  if (!phase || !isSupportedDepositMint(depositMint) || reserve !== manifest.reserve || market !== manifest.market || receiptMint !== manifest.receiptMint || liquiditySupply !== manifest.liquiditySupply || marketAuthority !== manifest.marketAuthority) throw new Error("Tenancy differs from configured deployment");
  return { address: account.address, leaseId, tenant, landlord, arbitrator, depositMint, reserve, market, receiptMint, liquiditySupply, marketAuthority, tenantDestination, landlordDestination, policyHash, releasePermitted, requiredSecurityAtomic, accountedIdleAtomic, accountedReceiptsAtomic, releasedEarningsAtomic, nextNonce, claimAtomic, approvedClaimAtomic, phase, bump, tenantOwedAtomic, landlordOwedAtomic };
}
export async function deriveEscrowAddresses(program: string, tenant: string, leaseId: Uint8Array) {
  if (leaseId.length !== 32) throw new Error("Lease identifier must be 32 bytes");
  const encode = getAddressEncoder();
  const derive = (seeds: Uint8Array[]) => getProgramDerivedAddress({ programAddress: address(program), seeds });
  const [tenancy, bump] = await derive([new TextEncoder().encode("tenancy"), new Uint8Array(encode.encode(address(tenant))), leaseId]);
  const [cash, receipts] = await Promise.all(["cash", "receipts"].map(async seed => (await derive([new TextEncoder().encode(seed), new Uint8Array(encode.encode(tenancy))]))[0]));
  return { tenancy, bump, cash, receipts };
}
export async function derivePayoutAddress(owner: string, mint: string) {
  const encode = getAddressEncoder();
  return (await getProgramDerivedAddress({
    programAddress: address(SOLANA_IDS.associatedToken),
    seeds: [
      encode.encode(address(owner)),
      encode.encode(address(SOLANA_IDS.token)),
      encode.encode(address(mint)),
    ],
  }))[0];
}
const discriminators = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237], initialize_staged: [168, 74, 32, 26, 236, 97, 244, 1], fund: [218, 188, 111, 221, 152, 113, 174, 7],
  supply: [81, 67, 116, 61, 250, 209, 5, 198], redeem: [184, 12, 86, 149, 70, 196, 97, 225],
  release_earnings: [133, 153, 190, 61, 65, 103, 225, 72], propose_claim: [70, 254, 74, 21, 158, 61, 195, 189],
  respond_to_claim: [45, 203, 133, 116, 107, 221, 231, 3], resolve_claim: [63, 99, 216, 44, 183, 52, 190, 140], settle: [175, 42, 185, 87, 144, 131, 102, 212],
  payout: [149, 140, 194, 236, 174, 189, 6, 239],
} as const;
function u64(value: string) { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, atomic(value), true); return bytes; }
function concat(parts: readonly Uint8Array[]) { const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return bytes; }
function meta(key: string, role: AccountRole = AccountRole.READONLY) { return { address: address(key), role }; }
export type EscrowAction =
  | { kind: "fund"; source: string }
  | { kind: "supply" | "release_earnings" | "propose_claim" | "resolve_claim"; amountAtomic: string }
  | { kind: "redeem"; receiptAtomic: string; minimumReceivedAtomic: string }
  | { kind: "respond_to_claim"; accept: boolean }
  | { kind: "settle" }
  | { kind: "payout"; landlord: boolean };

export async function buildEscrowInstruction(input: {
  manifest: DeploymentManifest; tenancy: TenancyAccount; actor: string; nonce: string; action: EscrowAction;
}): Promise<Instruction> {
  const { manifest, tenancy: t, action } = input;
  const derived = await deriveEscrowAddresses(manifest.escrowProgram, t.tenant, t.leaseId);
  if (t.address !== derived.tenancy || t.bump !== derived.bump || input.nonce !== t.nextNonce) throw new Error("Tenancy PDA or operation nonce mismatch");
  if (!isSupportedDepositMint(t.depositMint) || t.reserve !== manifest.reserve || t.market !== manifest.market || t.receiptMint !== manifest.receiptMint || t.liquiditySupply !== manifest.liquiditySupply || t.marketAuthority !== manifest.marketAuthority) throw new Error("Wrong tenancy deployment");
  const actor = meta(input.actor, AccountRole.READONLY_SIGNER), tenancy = meta(t.address, AccountRole.WRITABLE);
  let accounts;
  if (action.kind === "fund") {
    accounts = [actor, tenancy, meta(t.depositMint), meta(action.source, AccountRole.WRITABLE), meta(derived.cash, AccountRole.WRITABLE), meta(SOLANA_IDS.token)];
  } else if (["supply", "redeem", "release_earnings"].includes(action.kind)) {
    accounts = [actor, tenancy, meta(t.depositMint), meta(t.receiptMint, AccountRole.WRITABLE), meta(derived.cash, AccountRole.WRITABLE), meta(derived.receipts, AccountRole.WRITABLE), meta(t.tenantDestination, AccountRole.WRITABLE), meta(t.reserve, AccountRole.WRITABLE), meta(t.market), meta(t.marketAuthority), meta(t.liquiditySupply, AccountRole.WRITABLE), meta(SOLANA_IDS.klend), meta(SOLANA_IDS.instructions), meta(SOLANA_IDS.token), ...manifest.oracleAccounts.map(key => meta(key))];
  } else if (action.kind === "settle") {
    accounts = manifest.escrowVersion === "pull-v2"
      ? [actor, tenancy, meta(t.depositMint), meta(derived.cash)]
      : [actor, tenancy, meta(t.depositMint), meta(derived.cash, AccountRole.WRITABLE), meta(t.tenantDestination, AccountRole.WRITABLE), meta(t.landlordDestination, AccountRole.WRITABLE), meta(SOLANA_IDS.token)];
  } else if (action.kind === "payout") {
    if (manifest.escrowVersion !== "pull-v2") throw new Error("Pull payout requires a new deployment");
    accounts = [actor, tenancy, meta(t.depositMint), meta(derived.cash, AccountRole.WRITABLE), meta(action.landlord ? t.landlordDestination : t.tenantDestination, AccountRole.WRITABLE), meta(SOLANA_IDS.token)];
  } else accounts = [actor, tenancy];
  const args: Uint8Array[] = [];
  if ("amountAtomic" in action) args.push(u64(action.amountAtomic));
  if (action.kind === "redeem") args.push(u64(action.receiptAtomic), u64(action.minimumReceivedAtomic));
  if (action.kind === "respond_to_claim") args.push(Uint8Array.of(action.accept ? 1 : 0));
  if (action.kind === "payout") args.push(Uint8Array.of(action.landlord ? 1 : 0));
  args.push(u64(input.nonce));
  return { programAddress: address(manifest.escrowProgram), accounts, data: concat([Uint8Array.from(discriminators[action.kind]), ...args]) };
}

export async function buildInitializeEscrow(input: {
  manifest: DeploymentManifest; payer: string; tenant: string; landlord: string; arbitrator: string;
  leaseId: Uint8Array; policyHash: Uint8Array; releasePermitted: boolean; requiredSecurityAtomic: string;
  tenantDestination: string; landlordDestination: string; mode?: "joint" | "staged";
}): Promise<Instruction> {
  const { manifest: m } = input;
  const amount = atomic(input.requiredSecurityAtomic, false);
  if (amount > 10_000_000_000n || input.policyHash.length !== 32 || input.policyHash.every(byte => byte === 0) || new Set([input.tenant, input.landlord, input.arbitrator]).size !== 3) throw new Error("Invalid tenancy initialization");
  const derived = await deriveEscrowAddresses(m.escrowProgram, input.tenant, input.leaseId);
  const key = (value: string) => new Uint8Array(getAddressEncoder().encode(address(value)));
  const args = [input.leaseId, key(input.arbitrator), u64(input.requiredSecurityAtomic), input.policyHash, Uint8Array.of(input.releasePermitted ? 1 : 0), key(m.liquiditySupply), key(m.marketAuthority)];
  const staged = input.mode === "staged";
  return { programAddress: address(m.escrowProgram), data: concat([Uint8Array.from(staged ? discriminators.initialize_staged : discriminators.initialize), ...args]), accounts: [
    meta(input.payer, AccountRole.WRITABLE_SIGNER), meta(input.tenant, staged ? AccountRole.READONLY : AccountRole.READONLY_SIGNER), meta(input.landlord, AccountRole.READONLY_SIGNER), meta(derived.tenancy, AccountRole.WRITABLE),
    meta(ledgerDepositMint(m)), meta(m.receiptMint), meta(derived.cash, AccountRole.WRITABLE), meta(derived.receipts, AccountRole.WRITABLE), meta(input.tenantDestination), meta(input.landlordDestination), meta(m.reserve), meta(m.market), meta(SOLANA_IDS.token), meta(SOLANA_IDS.system),
  ] };
}

/** TEST DEPLOYMENTS ONLY: credit stand-in lending interest to an active escrow (see test_credit_yield). */
export async function buildTestCreditYield(input: { manifest: DeploymentManifest; tenancy: TenancyAccount; funder: string; source: string; amountAtomic: string }): Promise<Instruction> {
  const { manifest, tenancy: t } = input;
  const derived = await deriveEscrowAddresses(manifest.escrowProgram, t.tenant, t.leaseId);
  const amount = new Uint8Array(8);
  new DataView(amount.buffer).setBigUint64(0, BigInt(input.amountAtomic), true);
  return {
    programAddress: address(manifest.escrowProgram),
    data: concat([Uint8Array.of(20, 213, 145, 106, 246, 95, 216, 159), amount]),
    accounts: [
      meta(input.funder, AccountRole.READONLY_SIGNER),
      meta(t.address, AccountRole.WRITABLE),
      meta(t.depositMint),
      meta(input.source, AccountRole.WRITABLE),
      meta(derived.cash, AccountRole.WRITABLE),
      meta(SOLANA_IDS.token),
    ],
  };
}
