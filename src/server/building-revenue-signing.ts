import { encodeFunctionData, isAddress, parseAbi, type Address } from 'viem';
import investments from '../../contracts/evm/deployments/local-investments-46630.json' with { type: 'json' };

export type BuildingOperation = 'approve' | 'stake' | 'unstake' | 'claim' | 'exit' | 'sync';
export type BuildingActionReview = {
  distributor: string;
  unitToken: string;
  account: string;
  operation: BuildingOperation;
  quantityRaw: string | null;
};
export const BUILDING_ACTION_ABI = parseAbi([
  'function stake(uint256 amount)',
  'function unstake(uint256 amount)',
  'function claim()',
  'function exit()',
  'function sync()',
]);
export const BUILDING_TOKEN_ABI = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
]);

/** Claims and withdrawals always use msg.sender; there is no arbitrary receiver or operator. */
export function validateBuildingActionTransaction(
  transaction: { chainId?: number; to?: string | null; data?: string | ArrayLike<number>; value?: string | number | bigint },
  review: BuildingActionReview,
  signer: string,
  pinned: { distributor: string | null; unitToken: string; chainId: number; version: number; rewardDuration: number; rewardsSpec: { scheme: string; scale: string } },
) {
  if (pinned.version !== 3 || !pinned.distributor || pinned.chainId !== 46630 || pinned.rewardDuration !== 604800 ||
      pinned.rewardsSpec?.scheme !== 'staking_stream_v1' || pinned.rewardsSpec.scale !== '1000000000000000000000000000000000000' ||
      !isAddress(review.distributor) || !isAddress(review.unitToken) ||
      review.distributor.toLowerCase() !== pinned.distributor.toLowerCase() ||
      review.unitToken.toLowerCase() !== pinned.unitToken.toLowerCase())
    throw new Error('Building staking distributor is not deployed and pinned.');
  if (transaction.chainId !== 46630 || BigInt(transaction.value ?? 0) !== 0n)
    throw new Error('Building staking requires testnet chain 46630 and zero native value.');
  if (!isAddress(review.account) || review.account.toLowerCase() !== signer.toLowerCase())
    throw new Error('Building staking review belongs to another account.');
  const quantities = ['approve', 'stake', 'unstake'];
  let data: string;
  if (quantities.includes(review.operation)) {
    if (typeof review.quantityRaw !== 'string' || !/^[1-9][0-9]{0,77}$/.test(review.quantityRaw) ||
        BigInt(review.quantityRaw) > BigInt(investments.assets['demo-neighbourhood-homes'].totalSupplyRaw))
      throw new Error('Review an exact finite positive tHOME amount.');
    const amount = BigInt(review.quantityRaw);
    data = review.operation === 'approve'
      ? encodeFunctionData({ abi: BUILDING_TOKEN_ABI, functionName: 'approve', args: [review.distributor as Address, amount] })
      : encodeFunctionData({ abi: BUILDING_ACTION_ABI, functionName: review.operation as 'stake' | 'unstake', args: [amount] });
  } else if (review.operation === 'claim' || review.operation === 'exit' || review.operation === 'sync') {
    if (review.quantityRaw !== null) throw new Error('Claim, exit and sync have no caller-chosen amount or recipient.');
    data = encodeFunctionData({ abi: BUILDING_ACTION_ABI, functionName: review.operation });
  } else throw new Error('Unknown building staking operation.');
  const target = review.operation === 'approve' ? pinned.unitToken : pinned.distributor;
  if (transaction.to?.toLowerCase() !== target.toLowerCase() || typeof transaction.data !== 'string' ||
      transaction.data.toLowerCase() !== data.toLowerCase())
    throw new Error('Building action differs from the exact reviewed contract and calldata.');
}
