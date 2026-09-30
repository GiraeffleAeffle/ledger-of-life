import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLocalAiResponse } from './local-ai-response.ts';
import type { LocalAiRequest } from '../server/local-ai-types.ts';
import { inferenceApprovalForReview, inferenceNextAction } from './local-ai-review.ts';
import type { LocalAiApproval } from '../server/local-ai-types.ts';

const id = 'd8c41f72-286a-4b35-b6cb-088705975952';
function request(state: LocalAiRequest['state']): LocalAiRequest {
  return { id, mode: 'paid', state, model: 'local-model', prompt: 'A saved question', maxOutputTokens: 64,
    requestFingerprint: '0x' + '1'.repeat(64), createdAt: '2026-09-28T12:00:00Z', expiresAt: '2026-09-28T12:10:00Z',
    answer: null, usage: null, error: 'The model did not produce a complete answer.',
    payment: { state: 'failed', amountAtomic: '10000', receipt: null }, review: null, paymentRequired: null, approval: null };
}

test('reloading failed, interrupted and expired owned requests replaces stale running state without another inference', async () => {
  for (const [state, status] of [['failed', 502], ['interrupted', 503], ['expired', 410]] as const) {
    let saved = request('running');
    const result = await readLocalAiResponse<{ request: LocalAiRequest }>(Response.json({ request: request(state) }, { status }), id);
    saved = result.request;
    assert.equal(saved.state, state);
    assert.equal(saved.answer, null);
    assert.equal(saved.payment.receipt, null);
  }
});

test('authentication failures and another request ID never become an owned terminal result', async () => {
  await assert.rejects(readLocalAiResponse(Response.json({ request: request('failed') }, { status: 403 }), id));
  await assert.rejects(readLocalAiResponse(Response.json({ request: request('failed') }, { status: 502 }), 'other-request'));
  await assert.rejects(readLocalAiResponse(Response.json({ error: 'Unavailable' }, { status: 503 }), id));
  await assert.rejects(readLocalAiResponse(Response.json({ request: request('running') }, { status: 503 }), id));
});

test('busy-host ready requests resume without creating a second payment or asking a library visitor to pay', () => {
  const paid = request('ready');
  paid.payment.state = 'authorized';
  assert.equal(inferenceNextAction(paid), 'resume');
  assert.equal(inferenceNextAction({ ...paid, mode: 'library', payment: { ...paid.payment, state: 'none' } }), 'resume');
  assert.equal(inferenceNextAction({ ...paid, state: 'payment_required', payment: { ...paid.payment, state: 'quoted' } }), 'payment-review');
  assert.equal(inferenceNextAction({ ...paid, state: 'completed' }), null);
});

test('an altered approval cannot bypass the finite policy by changing its operation or wallet metadata', () => {
  const quoted = request('approval_required');
  quoted.review = { walletId: 'reviewed-wallet', requestId: id, requestFingerprint: quoted.requestFingerprint as `0x${string}`,
    operationId: `local-ai:${id}`, description: 'One answer', expiresAt: quoted.expiresAt,
    resourceUrl: `http://localhost/api/local-ai/requests/${id}`, chainId: 46630,
    asset: '0xA6e10E426A738aEF586dB5191177658D67C78A14', payTo: '0x0000000000000000000000000000000000000002', amountAtomic: '6400',
    maxOutputTokens: 64, facilitatorAddress: '0x0000000000000000000000000000000000000003' };
  const approval: LocalAiApproval = { id, state: 'review', budgetAtomic: '100000', hash: null, error: null,
    request: { walletId: 'reviewed-wallet', operationId: `local-ai-approval:${id}`, description: 'Finite budget',
      expiresAt: quoted.expiresAt, transaction: { chainId: 46630, to: quoted.review.asset, value: 0n } } };
  assert.throws(() => inferenceApprovalForReview(quoted, { ...approval, request: { ...approval.request!, operationId: 'unrelated-operation' } }));
  assert.throws(() => inferenceApprovalForReview(quoted, { ...approval, request: { ...approval.request!, walletId: 'another-wallet' } }));
  assert.throws(() => inferenceApprovalForReview(quoted, { ...approval, budgetAtomic: '1000000000' }));
});
