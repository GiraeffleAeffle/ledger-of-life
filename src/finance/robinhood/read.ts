import { getAddress, type Address, type PublicClient } from 'viem';
import { rentalEscrowAbi } from './abi.ts';
import { sameAddress, validateManifest, type RobinhoodManifest } from './manifest.ts';

export interface EscrowSnapshot {
  status: 'available';
  address: Address;
  chainId: number;
  blockNumber: string;
  blockHash: string;
  observedAt: string;
  state: number;
  nonce: string;
  asset: Address;
  vault: Address;
  tenant: Address;
  landlord: Address;
  arbitrator: Address;
  personalWallet: Address;
  agreementHash: string;
  securityRequirement: string;
  fundingReserve: string;
  earningsReleaseAllowed: boolean;
  tenantAccepted: boolean;
  landlordAccepted: boolean;
  arbitratedDecision: boolean;
  trackedShares: string;
  totalSupplied: string;
  totalRedeemed: string;
  releasedEarnings: string;
  securityValue: string;
  releasableEarnings: string;
  claimAmount: string;
  approvedLandlordAmount: string;
  minimumSettlementAssets: string;
  settledLandlordAmount: string;
  settledTenantAmount: string;
  cashWithdrawalStatus: 'requires-exact-call-simulation';
}

export async function readEscrow(
  client: PublicClient,
  manifest: RobinhoodManifest,
  address: Address,
): Promise<EscrowSnapshot> {
  validateManifest(manifest);
  if ((await client.getChainId()) !== manifest.chainId) throw new Error('RPC chain mismatch');
  const block = await client.getBlock();
  if (block.number === null || !block.hash) throw new Error('RPC returned an unconfirmed block');
  const code = await client.getCode({ address, blockNumber: block.number });
  if (!code || code === '0x') throw new Error('Escrow is not deployed on this network');
  const functions = [
    'fixedChainId',
    'state',
    'nonce',
    'asset',
    'vault',
    'tenant',
    'landlord',
    'arbitrator',
    'personalWallet',
    'agreementHash',
    'tenantAccepted',
    'arbitratedDecision',
    'landlordAccepted',
    'securityRequirement',
    'fundingReserve',
    'earningsReleaseAllowed',
    'trackedShares',
    'totalSupplied',
    'totalRedeemed',
    'releasedEarnings',
    'securityValue',
    'releasableEarnings',
    'claimAmount',
    'approvedLandlordAmount',
    'minimumSettlementAssets',
    'settledLandlordAmount',
    'settledTenantAmount',
  ] as const;
  const values = await Promise.all(
    functions.map((functionName) =>
      client.readContract({
        address,
        abi: rentalEscrowAbi,
        functionName,
        blockNumber: block.number,
      }),
    ),
  );
  const record = Object.fromEntries(functions.map((key, i) => [key, values[i]]));
  if (
    record.fixedChainId !== BigInt(manifest.chainId) ||
    !sameAddress(String(record.asset), manifest.asset.address) ||
    !sameAddress(String(record.vault), manifest.vault)
  )
    throw new Error('Escrow dependency mismatch');
  return {
    status: 'available',
    address: getAddress(address),
    chainId: manifest.chainId,
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    observedAt: block.timestamp.toString(),
    state: Number(record.state),
    nonce: String(record.nonce),
    asset: getAddress(String(record.asset)),
    vault: getAddress(String(record.vault)),
    tenant: getAddress(String(record.tenant)),
    landlord: getAddress(String(record.landlord)),
    arbitrator: getAddress(String(record.arbitrator)),
    personalWallet: getAddress(String(record.personalWallet)),
    fundingReserve: String(record.fundingReserve),
    agreementHash: String(record.agreementHash),
    securityRequirement: String(record.securityRequirement),
    tenantAccepted: record.tenantAccepted === true,
    arbitratedDecision: record.arbitratedDecision === true,
    landlordAccepted: record.landlordAccepted === true,
    earningsReleaseAllowed: record.earningsReleaseAllowed === true,
    trackedShares: String(record.trackedShares),
    totalSupplied: String(record.totalSupplied),
    totalRedeemed: String(record.totalRedeemed),
    releasedEarnings: String(record.releasedEarnings),
    securityValue: String(record.securityValue),
    releasableEarnings: String(record.releasableEarnings),
    claimAmount: String(record.claimAmount),
    approvedLandlordAmount: String(record.approvedLandlordAmount),
    minimumSettlementAssets: String(record.minimumSettlementAssets),
    settledLandlordAmount: String(record.settledLandlordAmount),
    settledTenantAmount: String(record.settledTenantAmount),
    cashWithdrawalStatus: 'requires-exact-call-simulation',
  };
}

/** Convert raw 18-decimal Stock Token units to 18-decimal represented share exposure. */
export function stockExposure(rawBalance: bigint, multiplier: bigint): bigint {
  if (rawBalance < 0n || multiplier <= 0n) throw new Error('Invalid stock balance or multiplier');
  return (rawBalance * multiplier) / 10n ** 18n;
}

/** Chainlink prices already include corporate actions: use RAW token units here. */
export function stockValueFromAdjustedFeed(
  rawBalance: bigint,
  adjustedPrice: bigint,
  feedDecimals: number,
): bigint {
  if (
    rawBalance < 0n ||
    adjustedPrice <= 0n ||
    !Number.isInteger(feedDecimals) ||
    feedDecimals < 0 ||
    feedDecimals > 36
  )
    throw new Error('Invalid valuation input');
  return (rawBalance * adjustedPrice) / 10n ** BigInt(feedDecimals); // USD with 18 decimals.
}
