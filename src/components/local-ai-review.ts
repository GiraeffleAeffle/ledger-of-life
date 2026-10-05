import type { LocalAiApproval, LocalAiRequest } from '../server/local-ai-types.ts';

// Solana approvals use prepareSolanaInferenceApproval, which decodes the complete SPL transaction.
/** Never let server-supplied operation metadata select a weaker generic signing policy. */
export function inferenceApprovalForReview(request: LocalAiRequest, approval: LocalAiApproval) {
  const signing = approval.request;
  if (request.mode !== 'paid' || !request.review || request.review.requestId !== request.id ||
      request.review.requestFingerprint !== request.requestFingerprint || approval.state !== 'review' ||
      approval.budgetAtomic !== '100000' || !signing || signing.operationId !== `local-ai-approval:${request.id}` ||
      signing.walletId !== request.review.walletId)
    throw new Error('The access-budget transaction does not match this question and wallet.');
  return signing;
}

export function inferenceNextAction(request: LocalAiRequest | null): 'payment-review' | 'resume' | null {
  if (!request) return null;
  if (request.state === 'ready') return 'resume';
  if (request.mode === 'paid' && request.payment.state === 'quoted' &&
      (request.state === 'payment_required' || request.state === 'approval_required')) return 'payment-review';
  return null;
}

export const LOCAL_AI_RECEIPT_KEY = 'ledger-of-life:local-ai:receipt';
