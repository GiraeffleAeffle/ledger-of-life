import { getAddress, isAddress, type Address } from 'viem';
import { PERMIT2_ADDRESS, uptoPermit2WitnessTypes, x402UptoPermit2ProxyAddress } from '@x402/evm';
import { TEST_USDG_ADDRESS } from './inference-token.ts';
import type { InferencePaymentSigningRequest } from '../server/local-ai-types.ts';
import type { RentalWallet } from './types.ts';
import { AI_PRICE, AI_MAX_OUTPUT } from '../domain/ai-pricing.ts';

const canonical = (value: string) => /^(0|[1-9][0-9]*)$/.test(value);
export function prepareInferencePayment(request: InferencePaymentSigningRequest, wallet: RentalWallet | undefined, now = Date.now()) {
  if (!wallet?.connected || wallet.chainType !== 'ethereum' || wallet.id !== request.walletId ||
      !isAddress(wallet.address) || request.chainId !== 46630 ||
      request.asset !== TEST_USDG_ADDRESS || !isAddress(request.payTo) || !isAddress(request.facilitatorAddress) ||
      getAddress(request.payTo) === getAddress(wallet.address) ||
      !/^[0-9a-fA-F-]{36}$/.test(request.requestId) ||
      !/^0x[a-fA-F0-9]{64}$/.test(request.requestFingerprint) ||
      !request.operationId || !request.description ||
      !request.resourceUrl.endsWith(`/api/local-ai/requests/${request.requestId}`) ||
      !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0 || request.maxOutputTokens > AI_MAX_OUTPUT ||
      request.amountAtomic !== (BigInt(request.maxOutputTokens) * AI_PRICE).toString() || !canonical(request.nonce) ||
      !canonical(request.validAfter) || !canonical(request.deadline))
    throw new Error('Inference payment does not match the selected reviewed operation.');
  const expiry = Date.parse(request.expiresAt);
  const seconds = BigInt(Math.floor(now / 1000));
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 20 * 60_000 ||
      BigInt(request.validAfter) > seconds || BigInt(request.deadline) < seconds + 60n ||
      BigInt(request.deadline) > seconds + 20n * 60n || BigInt(request.nonce) >= 2n ** 256n)
    throw new Error('Inference payment authorization expired or exceeds the bounded review.');
  return {
    domain: { name: 'Permit2', chainId: 46630, verifyingContract: PERMIT2_ADDRESS },
    types: {
      PermitWitnessTransferFrom: [...uptoPermit2WitnessTypes.PermitWitnessTransferFrom],
      TokenPermissions: [...uptoPermit2WitnessTypes.TokenPermissions],
      Witness: [...uptoPermit2WitnessTypes.Witness],
    },
    primaryType: 'PermitWitnessTransferFrom' as const,
    message: {
      permitted: { token: TEST_USDG_ADDRESS, amount: request.amountAtomic },
      spender: x402UptoPermit2ProxyAddress,
      nonce: request.nonce, deadline: request.deadline,
      witness: { to: getAddress(request.payTo) as Address, facilitator: getAddress(request.facilitatorAddress) as Address, validAfter: request.validAfter },
    },
  };
}
