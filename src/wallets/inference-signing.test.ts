import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTypedData, type TypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { uptoPermit2WitnessTypes, x402UptoPermit2ProxyAddress } from '@x402/evm';
import { prepareInferencePayment } from './inference-signing.ts';
import { TEST_USDG_ADDRESS } from './inference-token.ts';
import { localAiPaymentHeaders } from '../components/local-ai-payment.ts';
import type { InferencePaymentSigningRequest, LocalAiRequest } from '../server/local-ai-types.ts';
import type { RentalWalletAccess } from './types.ts';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const wallet = { id: 'wallet', address: account.address, chainType: 'ethereum' as const, connected: true };
const payTo = '0x2222222222222222222222222222222222222222';
const facilitatorAddress = '0x3333333333333333333333333333333333333333';
function fixture(): InferencePaymentSigningRequest {
  const now = Math.floor(Date.now() / 1000);
  return { walletId: wallet.id, operationId: 'inference', description: 'Reviewed answer', expiresAt: new Date((now + 600) * 1000).toISOString(), requestId: '11111111-1111-4111-8111-111111111111', requestFingerprint: `0x${'44'.repeat(32)}`, resourceUrl: 'https://ledger.example/api/local-ai/requests/11111111-1111-4111-8111-111111111111', chainId: 46630, asset: TEST_USDG_ADDRESS, payTo, facilitatorAddress, maxOutputTokens: 128, amountAtomic: '12800', nonce: '1', validAfter: '0', deadline: String(now + 600) };
}
function requestFor(review = fixture()): LocalAiRequest {
  return { id: review.requestId, mode: 'paid', state: 'payment_required', model: 'local', prompt: 'Question', maxOutputTokens: review.maxOutputTokens, requestFingerprint: review.requestFingerprint, createdAt: new Date().toISOString(), expiresAt: review.expiresAt, answer: null, usage: null, error: null, payment: { state: 'quoted', amountAtomic: review.amountAtomic, receipt: null }, review, approval: null, paymentRequired: { x402Version: 2, resource: { url: review.resourceUrl }, accepts: [{ scheme: 'upto', network: 'eip155:46630', asset: review.asset, amount: review.amountAtomic, payTo: review.payTo, maxTimeoutSeconds: 600, extra: { assetTransferMethod: 'permit2', paymentFlow: 'authorization', facilitatorAddress: review.facilitatorAddress } }] } };
}
function accessFor(onSign: (request: InferencePaymentSigningRequest) => Promise<`0x${string}`>): RentalWalletAccess {
  return { wallets: [wallet], signInferencePayment: onSign } as RentalWalletAccess;
}

test('upto typed data binds the token cap, recipient and facilitator cryptographically', async () => {
  const review = fixture();
  const typed = prepareInferencePayment(review, wallet);
  assert.equal(typed.message.spender, x402UptoPermit2ProxyAddress);
  assert.deepEqual(typed.types.Witness, uptoPermit2WitnessTypes.Witness);
  const signature = await account.signTypedData<TypedData, 'PermitWitnessTransferFrom'>(typed);
  assert.equal(await verifyTypedData<TypedData, 'PermitWitnessTransferFrom'>({ ...typed, address: wallet.address, signature }), true);
  for (const changed of [{ amountAtomic: '12700', maxOutputTokens: 127 }, { facilitatorAddress: payTo }, { payTo: facilitatorAddress }]) {
    assert.equal(await verifyTypedData<TypedData, 'PermitWitnessTransferFrom'>({ ...prepareInferencePayment({ ...review, ...changed } as InferencePaymentSigningRequest, wallet), address: wallet.address, signature }), false);
  }
});

test('signing rejects cap mismatches and preserves bounded deadline checks', () => {
  const review = fixture();
  for (const changed of [{ amountAtomic: '10000' }, { maxOutputTokens: 0 }, { maxOutputTokens: 128.5 }, { facilitatorAddress: 'invalid' }, { deadline: String(Math.floor(Date.now() / 1000) + 59) }, { deadline: String(Math.floor(Date.now() / 1000) + 1201) }, { validAfter: String(Math.floor(Date.now() / 1000) + 60) }, { expiresAt: new Date(Date.now() - 1000).toISOString() }]) {
    assert.throws(() => prepareInferencePayment({ ...review, ...changed } as InferencePaymentSigningRequest, wallet));
  }
});

test('real upto SDK creates the reviewed maximum authorization and signed witness', async () => {
  const request = requestFor();
  const headers = await localAiPaymentHeaders(accessFor(async (signing) => account.signTypedData<TypedData, 'PermitWitnessTransferFrom'>(prepareInferencePayment(signing, wallet))), request);
  const payload = JSON.parse(Buffer.from(headers['PAYMENT-SIGNATURE'], 'base64').toString());
  const authorization = payload.payload.permit2Authorization;
  assert.equal(authorization.permitted.amount, '12800');
  assert.equal(authorization.spender, x402UptoPermit2ProxyAddress);
  assert.equal(authorization.witness.facilitator, facilitatorAddress);
  assert.equal(await verifyTypedData<TypedData, 'PermitWitnessTransferFrom'>({ ...prepareInferencePayment({ ...fixture(), nonce: authorization.nonce, deadline: authorization.deadline, validAfter: authorization.witness.validAfter }, wallet), address: wallet.address, signature: payload.payload.signature }), true);
});

test('client rejects substituted quote policies before asking the wallet to sign', async () => {
  const substitutions = [ { scheme: 'exact' }, { amount: '12900' }, { payTo: facilitatorAddress }, { extra: { assetTransferMethod: 'permit2', paymentFlow: 'authorization', facilitatorAddress: payTo } }, { maxTimeoutSeconds: 1201 } ];
  let signatures = 0;
  const access = accessFor(async () => { signatures++; throw new Error('Unexpected signing'); });
  for (const substitution of substitutions) {
    const request = requestFor();
    Object.assign(request.paymentRequired!.accepts[0], substitution);
    await assert.rejects(localAiPaymentHeaders(access, request));
  }
  for (const field of ['requestFingerprint', 'maxOutputTokens', 'id'] as const) {
    const request = requestFor();
    if (field === 'maxOutputTokens') request.maxOutputTokens = 256;
    else request[field] = 'changed';
    await assert.rejects(localAiPaymentHeaders(access, request));
  }
  const request = requestFor();
  request.paymentRequired!.resource.url = 'https://other.example/quote';
  await assert.rejects(localAiPaymentHeaders(access, request));
  assert.equal(signatures, 0);
});

test('client product cap refuses a consistent 193-token quote and inflated amounts before signing', async () => {
  let signatures = 0;
  const access = accessFor(async () => { signatures++; throw new Error('Unexpected signing'); });
  for (const changed of [{ maxOutputTokens: 193, amountAtomic: '19300' }, { maxOutputTokens: 192, amountAtomic: '100000' }]) {
    const review = { ...fixture(), ...changed };
    assert.throws(() => prepareInferencePayment(review, wallet));
    await assert.rejects(localAiPaymentHeaders(access, requestFor(review)));
  }
  assert.equal(signatures, 0);
  const boundary = prepareInferencePayment({ ...fixture(), maxOutputTokens: 192, amountAtomic: '19200' }, wallet);
  assert.equal(boundary.message.permitted.amount, '19200');
});
