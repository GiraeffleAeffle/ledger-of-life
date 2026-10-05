import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { LocalAiRequest } from '../server/local-ai-types.ts';

const codec = new x402HTTPClient(new x402Client());
const terminalStatuses: Record<string, number> = { failed: 502, interrupted: 503, expired: 410 };

/** A failed job is still an owned resource that must replace a stale running view. */
export async function readLocalAiResponse<T>(response: Response, expectedRequestId?: string): Promise<T> {
  const data = await response.json() as { error?: string; request?: LocalAiRequest };
  const request = data.request;
  const ownedTerminal = Boolean(expectedRequestId && request?.id === expectedRequestId &&
    (request.mode === 'paid' || request.mode === 'library') && terminalStatuses[request.state] === response.status);
  if (!response.ok && response.status !== 402 && !ownedTerminal)
    throw new Error(typeof data.error === 'string' ? data.error : `The request failed (${response.status}).`);
  if (expectedRequestId && (!request || request.id !== expectedRequestId))
    throw new Error('The saved result does not match this request.');
  if (response.status === 402 && !request?.solanaReview) {
    if (!request) throw new Error('The node returned a payment challenge without a request.');
    request.paymentRequired = codec.getPaymentRequiredResponse((name) => response.headers.get(name));
  }
  if (response.headers.has('PAYMENT-RESPONSE')) {
    const receipt = codec.getPaymentSettleResponse((name) => response.headers.get(name));
    if (!request || !receipt.success || receipt.transaction !== request.payment.receipt?.transaction)
      throw new Error('The payment receipt does not match the saved answer.');
  }
  return data as T;
}
