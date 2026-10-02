import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { TEST_USDG_ADDRESS } from './inference-token.ts';
import { BUILDING_RENT_SHARE_BPS, RENT_BUILDING_ID, splitBuildingRent } from '../domain/rent.ts';
import buildingManifest from '../../contracts/evm/deployments/building-revenue-46630.json' with { type: 'json' };
export const RENT_TOKEN_ABI = parseAbi(['function transfer(address to,uint256 amount) returns (bool)', 'function balanceOf(address account) view returns (uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
export type RentTransferReview = { agreementId: string; month: string; buildingId: typeof RENT_BUILDING_ID; shareBps: typeof BUILDING_RENT_SHARE_BPS; rentMonthly: string; tenantWallet: string; landlordWallet: string; distributor: string; kind: 'landlord' | 'building' };
export function rentTransferDetails(review: RentTransferReview) {
  if (review.buildingId !== RENT_BUILDING_ID || review.shareBps !== BUILDING_RENT_SHARE_BPS || !/^\d{4}-(0[1-9]|1[0-2])$/.test(review.month) || !review.agreementId || !['building','landlord'].includes(review.kind)) throw new Error('Invalid fixed building rent review.');
  if (!buildingManifest.distributor || getAddress(review.distributor) !== getAddress(buildingManifest.distributor)) throw new Error('Rent distributor differs from the deployed manifest.');
  const split = splitBuildingRent(review.rentMonthly);
  return { recipient: getAddress(review.kind === 'building' ? review.distributor : review.landlordWallet), amount: BigInt(review.kind === 'building' ? split.buildingRaw : split.landlordRaw) };
}
export function validateRentTransfer(transaction: { chainId?: number; to?: string | null; data?: string | ArrayLike<number>; value?: string | number | bigint }, review: RentTransferReview, signer: string) {
  const { recipient, amount } = rentTransferDetails(review);
  if (getAddress(signer) !== getAddress(review.tenantWallet) || transaction.chainId !== 46630 || !transaction.to || getAddress(transaction.to) !== getAddress(TEST_USDG_ADDRESS) || BigInt(transaction.value ?? 0) !== 0n) throw new Error('Rent requires the tenant’s exact test tUSDG transfer on chain 46630.');
  const decoded = decodeFunctionData({ abi: RENT_TOKEN_ABI, data: transaction.data as Hex });
  const exact = encodeFunctionData({ abi: RENT_TOKEN_ABI, functionName: 'transfer', args: [recipient, amount] });
  if (decoded.functionName !== 'transfer' || transaction.data !== exact) throw new Error('Rent transfer differs from the exact reviewed token, recipient or amount.');
}
