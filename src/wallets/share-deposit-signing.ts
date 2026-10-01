import { encodeAbiParameters, encodeFunctionData, getContractAddress, isAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import manifest from '../../contracts/evm/deployments/share-deposit-46630.json' with { type: 'json' };
import type { ShareDepositTerms } from '../domain/share-deposit.ts';

export const SHARE_DEPOSIT_ABI = parseAbi([
  'function pledge(uint256 shares)', 'function activate()', 'function withdraw(uint256 shares)',
  'function proposeClaim(uint256 usd6,bytes32 evidenceHash)', 'function acceptClaim(uint256 maxShares)',
  'function contestClaim()', 'function lowerClaim(uint256 usd6)', 'function escalateClaim()',
  'function resolveClaim(uint256 shares)', 'function requestReturn()', 'function closeUnclaimed()',
  'function closeUnresolved()', 'function payout(bool toLandlord)',
]);
export const SHARE_FACTORY_ABI = parseAbi(['function create((address tenant,address landlord,address arbitrator,uint256 depositValue,bytes32 agreementHash,uint256 responseWindow,uint256 returnWindow,uint256 arbitrationWindow) terms) returns (address)']);
export const SHARE_APPROVE_ABI = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
export const DEPOSIT_STOCK = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E';
export type ShareDepositSigningReview = {
  factory: string; escrow: string | null; stock: string;
  functionName: string; args: readonly unknown[];
  terms: ShareDepositTerms;
  role: 'tenant' | 'landlord' | 'arbitrator';
  approvalShares: string | null;
  priceUsd6: string | null;
};

/** A share operation never opens the generic EVM signing path. Only the finite, reviewed call is allowed. */
export function validateShareDepositTransaction(
  transaction: { chainId: number; to: string; data?: string | ArrayLike<number>; value?: string | number | bigint },
  review: ShareDepositSigningReview,
  signer: string,
) {
  if (transaction.chainId !== 46630 || BigInt(transaction.value ?? 0) !== 0n)
    throw new Error('Share deposits require chain 46630 and zero native value.');
  if (!isAddress(review.factory) || !manifest.factory || !manifest.implementation ||
      review.factory.toLowerCase() !== String(manifest.factory).toLowerCase() ||
      review.stock.toLowerCase() !== DEPOSIT_STOCK.toLowerCase())
    throw new Error('Share deposit deployment is not pinned.');
  const terms = review.terms;
  if (!terms || ![terms.tenant, terms.landlord, terms.arbitrator].every(address => isAddress(address)) ||
      new Set([terms.tenant, terms.landlord, terms.arbitrator].map(address => address.toLowerCase())).size !== 3 ||
      !/^0x[0-9a-fA-F]{64}$/.test(terms.agreementHash) || BigInt(terms.agreementHash) === 0n ||
      !/^\d+$/.test(terms.depositValue) || BigInt(terms.depositValue) < 1000000n || BigInt(terms.depositValue) > 10000000000n ||
      ![terms.responseWindow, terms.returnWindow, terms.arbitrationWindow].every(value => /^\d+$/.test(value) && BigInt(value) >= 3600n && BigInt(value) <= 34560000n))
    throw new Error('Review all eight valid accepted deposit terms.');
  const encodedTerms = encodeAbiParameters(SHARE_FACTORY_ABI[0].inputs, [{
    tenant: terms.tenant as Address, landlord: terms.landlord as Address, arbitrator: terms.arbitrator as Address,
    depositValue: BigInt(terms.depositValue), agreementHash: terms.agreementHash as Hex,
    responseWindow: BigInt(terms.responseWindow), returnWindow: BigInt(terms.returnWindow), arbitrationWindow: BigInt(terms.arbitrationWindow),
  }]);
  const escrow = getContractAddress({
    opcode: 'CREATE2', from: manifest.factory as Address, salt: keccak256(encodedTerms),
    bytecodeHash: keccak256(`0x3d602d80600a3d3981f3363d3d373d3d3d363d73${String(manifest.implementation).slice(2)}5af43d82803e903d91602b57fd5bf3`),
  });
  if (review.escrow?.toLowerCase() !== escrow.toLowerCase())
    throw new Error('The reviewed escrow does not match the pinned CREATE2 deposit.');
  const roles: Record<string, 'tenant' | 'landlord' | 'arbitrator'> = {
    create: 'landlord', approve: 'tenant', pledge: 'tenant', withdraw: 'tenant', acceptClaim: 'tenant',
    contestClaim: 'tenant', requestReturn: 'tenant', proposeClaim: 'landlord', lowerClaim: 'landlord', resolveClaim: 'arbitrator',
  };
  const requiredRole = roles[review.functionName];
  if (!['tenant', 'landlord', 'arbitrator'].includes(review.role) ||
      signer.toLowerCase() !== terms[review.role]?.toLowerCase() ||
      (requiredRole && requiredRole !== review.role))
    throw new Error('The signing wallet is not the matching deposit party.');
  let abi: typeof SHARE_DEPOSIT_ABI | typeof SHARE_FACTORY_ABI | typeof SHARE_APPROVE_ABI = SHARE_DEPOSIT_ABI;
  let target: string = escrow;
  if (review.functionName === 'create') {
    abi = SHARE_FACTORY_ABI; target = review.factory;
    if (encodeFunctionData({ abi: SHARE_FACTORY_ABI, functionName: 'create', args: review.args } as Parameters<typeof encodeFunctionData>[0]) !== encodeFunctionData({ abi: SHARE_FACTORY_ABI, functionName: 'create', args: [terms] } as Parameters<typeof encodeFunctionData>[0]))
      throw new Error('Factory creation differs from the reviewed accepted terms.');
  } else if (review.functionName === 'approve') {
    abi = SHARE_APPROVE_ABI; target = review.stock;
    const quotedPrice = review.priceUsd6 && /^\d+$/.test(review.priceUsd6) ? BigInt(review.priceUsd6) : 0n;
    const numerator = 15000n * 1000000n * 10n ** 18n;
    const cap = quotedPrice > 0n ? (numerator + quotedPrice - 1n) / quotedPrice : numerator;
    if (String(review.args[0]).toLowerCase() !== escrow.toLowerCase() ||
        !/^\d+$/.test(String(review.args[1])) || BigInt(String(review.args[1])) <= 0n ||
        String(review.args[1]) !== review.approvalShares || BigInt(String(review.args[1])) > cap)
      throw new Error('Approve only the exact finite TSLA amount to this escrow.');
  } else if (!SHARE_DEPOSIT_ABI.some((entry) => entry.name === review.functionName)) {
    throw new Error('This share deposit function is not allowed.');
  }
  if (!target || !isAddress(target) || transaction.to.toLowerCase() !== target.toLowerCase())
    throw new Error('The transaction is not addressed to the bound deposit contract.');
  const data = encodeFunctionData({ abi, functionName: review.functionName, args: review.args } as Parameters<typeof encodeFunctionData>[0]);
  if (typeof transaction.data !== 'string' || transaction.data.toLowerCase() !== data.toLowerCase())
    throw new Error('The transaction differs from the exact reviewed deposit call.');
}
