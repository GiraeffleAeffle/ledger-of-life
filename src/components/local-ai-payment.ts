import { x402Client, x402HTTPClient } from '@x402/core/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { appendPaymentIdentifierToExtensions } from '@x402/extensions/payment-identifier';
import { hashTypedData, type TypedData, type TypedDataDomain } from 'viem';
import { prepareInferencePayment } from '../wallets/inference-signing.ts';
import type { RentalWalletAccess } from '../wallets/types.ts';
import type { LocalAiRequest, InferencePaymentSigningRequest } from '../server/local-ai-types.ts';
import { AI_PRICE, AI_MAX_OUTPUT } from '../domain/ai-pricing.ts';

/** Called only after the user accepts this request's finite payment review. */
export async function localAiPaymentHeaders(access: RentalWalletAccess, request: LocalAiRequest) {
  const review = request.review;
  const required = request.paymentRequired;
  const wallet = access.wallets.find((item) => item.id === review?.walletId && item.connected && item.chainType === 'ethereum');
  if (!review || !required || !wallet || required.x402Version !== 2 || required.resource.url !== review.resourceUrl ||
      review.requestId !== request.id || review.requestFingerprint !== request.requestFingerprint ||
      !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0 || request.maxOutputTokens > AI_MAX_OUTPUT ||
      review.maxOutputTokens !== request.maxOutputTokens || review.amountAtomic !== (BigInt(request.maxOutputTokens) * AI_PRICE).toString())
    throw new Error('The payment quote does not match this request and wallet.');
  const scheme = new UptoEvmScheme({
    address: wallet.address as `0x${string}`,
    async signTypedData(typed) {
      const witness = typed.message.witness as Record<string, unknown> | undefined;
      const signing: InferencePaymentSigningRequest = {
        ...review, nonce: String(typed.message.nonce), deadline: String(typed.message.deadline), validAfter: String(witness?.validAfter),
      };
      const expected = prepareInferencePayment(signing, wallet);
      // JSON-RPC carries uint256 values as decimal strings; use the codec's wire-data form.
      if (hashTypedData({ ...typed, types: typed.types as TypedData, domain: typed.domain as TypedDataDomain }) !== hashTypedData<TypedData, 'PermitWitnessTransferFrom'>(expected))
        throw new Error('The x402 authorization differs from the reviewed payment.');
      return access.signInferencePayment(signing);
    },
  });
  const client = new x402Client().register('eip155:46630', scheme)
    .setSpendControls({ allowedAssets: [{ network: 'eip155:46630', asset: review.asset, maxAmountPerPayment: (BigInt(request.maxOutputTokens) * AI_PRICE).toString() }] })
    .registerPolicy((version, choices) => version === 2 ? choices.filter((choice) =>
      choice.scheme === 'upto' && choice.network === 'eip155:46630' &&
      choice.asset.toLowerCase() === review.asset.toLowerCase() && choice.amount === review.amountAtomic &&
      choice.payTo.toLowerCase() === review.payTo.toLowerCase() && choice.maxTimeoutSeconds <= 1200 &&
      choice.extra?.assetTransferMethod === 'permit2' && choice.extra?.paymentFlow === 'authorization' &&
      typeof choice.extra?.facilitatorAddress === 'string' &&
      choice.extra.facilitatorAddress.toLowerCase() === review.facilitatorAddress.toLowerCase()) : []);
  const http = new x402HTTPClient(client);
  const payload = await http.createPaymentPayload(required);
  payload.extensions = appendPaymentIdentifierToExtensions({ ...payload.extensions }, request.id);
  return http.encodePaymentSignatureHeader(payload);
}
