import { createHash } from 'node:crypto';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { declarePaymentIdentifierExtension } from '@x402/extensions/payment-identifier';
import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types';
import { getAddress, type Address, type Hex } from 'viem';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { walletFor } from './agreements.ts';
import type { Store } from './store.ts';
import { ConflictError, AccessError } from './errors.ts';
import { WorkflowError } from '../domain/errors.ts';
import { AI_BUDGET, AI_CONTEXT_TOKENS, AI_MAX_OUTPUT, AI_MODEL, AI_PRICE, aiRpc, aiTokenAbi, assertInferenceAvailable, assertInferenceContracts, inferencePayee, instructions, releaseHost, reserveHost, runLocalInference } from './local-ai-runtime.ts';
import { TEST_USDG_ADDRESS } from '../wallets/inference-token.ts';
import { PERMIT2_ADDRESS } from '@x402/evm';
import { createAiResource, facilitatorAccount, inspectAiReceipt, recoverExpiredUnsignedSettlement, validatePaymentPayload, type AiPayment } from './local-ai-payment.ts';
import { assertVisitorActive } from './local-ai-session.ts';
import type { LocalAiApproval, LocalAiContext, LocalAiMode, LocalAiRequest } from './local-ai-types.ts';
import { purged, textDue, textGraceMs } from './local-ai-retention.ts';
import { cancelConnectorInference, chooseConnectorHost, enqueueConnectorInference } from './local-ai-hosts.ts';

export type AiInput = { mode: LocalAiMode; prompt: string; maxOutputTokens: number; context: LocalAiContext; hostScope: 'own' | 'city'; publicQuestion: boolean };
export type PaidAiOwner = { subject: string; walletId: string; payer: Address };
export type VisitorAiOwner = { visitor: string };
export type AiOwner = PaidAiOwner | VisitorAiOwner;
type AiRecord = {
  id: string; mode: LocalAiMode; owner: AiOwner; request: LocalAiRequest; context: LocalAiContext;
  payee: Address | null; resourceUrl: string; paymentJournal: AiPayment | null; runningAt?: number; completedAt?: string;
  approvalJournal: { signed: Hex | null; hash: Hex | null; transaction: NonNullable<LocalAiApproval['request']>['transaction'] } | null;
};
const prefix = 'local-ai:request:';
const own = (record: AiRecord, owner: AiOwner) => {
  if ('visitor' in record.owner) {
    if (!('visitor' in owner) || !owner.visitor || record.owner.visitor !== owner.visitor) throw new AccessError('This answer belongs to another visitor.');
  } else if (!('subject' in owner) || record.owner.subject !== owner.subject || record.owner.walletId !== owner.walletId ||
      record.owner.payer.toLowerCase() !== owner.payer.toLowerCase()) throw new AccessError('This answer belongs to another account.');
};
const fingerprint = (parts: unknown[]): Hex => `0x${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
function inputFingerprint(id: string, owner: AiOwner, input: AiInput, resourceUrl: string, payee: Address | null, hostId?: string): Hex {
  return fingerprint(['local-ai-v2', id, input.mode, input.prompt, input.context, input.maxOutputTokens,
    AI_MODEL, AI_CONTEXT_TOKENS, 'think:false', 'temperature:0.35', owner, resourceUrl,
    input.hostScope, input.publicQuestion, hostId ?? 'direct',
    input.mode === 'paid' ? ['eip155:46630', TEST_USDG_ADDRESS, AI_PRICE.toString(), payee] : ['library', '0']]);
}
function validId(id: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new WorkflowError('Use a UUID request ID.'); }
export function paidOwner(identity: VerifiedIdentity): PaidAiOwner {
  const wallet = walletFor(identity, 'robinhood');
  return { subject: identity.subject, walletId: wallet.id, payer: getAddress(wallet.address) };
}
export function libraryOwner(visitor: string): VisitorAiOwner {
  if (!/^[a-f0-9]{64}$/.test(visitor)) throw new AccessError('A private visitor session is required.');
  return { visitor };
}
function publicRequest(record: AiRecord): LocalAiRequest {
  const request = record.request;
  if (record.mode === 'paid' && request.payment.state !== 'settled') return { ...request, answer: null, usage: null };
  return request;
}
function canClearText(record: AiRecord) {
  return !record.request.purgedAt && record.request.state !== 'running' && record.request.state !== 'settling' &&
    record.request.payment.state !== 'authorized' && record.request.payment.state !== 'pending';
}
async function purgeDueText(store: Store, id: string, now: number, graceMs = textGraceMs()) {
  return store.update<AiRecord>(prefix + id, (current) =>
    textDue(current, now, graceMs) ? purged(current, now) : current);
}
export async function sweepAiText(store: Store, after: string, now = Date.now()) {
  const rows = await store.scan<AiRecord>(prefix, after, 200);
  const graceMs = textGraceMs();
  let scrubbed = 0;
  for (const { key, value: scanned } of rows) {
    let value = scanned;
    if (value.request.host && value.request.state === 'running' && value.runningAt && now - value.runningAt >= 95000) {
      await cancelConnectorInference(store, value.id);
      value = await store.update<AiRecord>(key, (current) => {
        if (current.request.state === 'running' && current.runningAt && now - current.runningAt >= 95000) {
          current.request.state = 'interrupted'; current.request.error = 'Connector answer timed out. No inference tokens were charged.';
          current.completedAt = new Date(current.runningAt + 95000).toISOString();
        }
        return current;
      });
    }
    if (!textDue(value, now, graceMs)) continue;
    let changed = false;
    await store.update<AiRecord>(key, (current) => {
      if (!textDue(current, now, graceMs)) return current;
      changed = true;
      return purged(current, now);
    });
    if (changed) scrubbed++;
  }
  // The last page of a sweep also covers text removed lazily by reads since the previous sweep.
  if (rows.length < 200) await store.reclaim?.();
  return { scrubbed, next: rows.length === 200 ? rows[rows.length - 1].key : null };
}
export async function purgeVisitorText(store: Store, visitor: string) {
  libraryOwner(visitor);
  let after = '';
  do {
    const rows = await store.scan<AiRecord>(prefix, after, 200);
    for (const { key, value } of rows) {
      after = key;
      if (!('visitor' in value.owner) || value.owner.visitor !== visitor || !canClearText(value)) continue;
      await store.update<AiRecord>(key, (current) =>
        'visitor' in current.owner && current.owner.visitor === visitor && canClearText(current) ? purged(current, Date.now()) : current);
    }
    if (rows.length < 200) break;
  } while (true);
  await store.reclaim?.();
}

export async function readAiRequest(store: Store, id: string, owner: AiOwner) {
  validId(id);
  let record = await store.get<AiRecord>(prefix + id);
  if (!record) throw new WorkflowError('Unknown inference request.');
  own(record, owner);
  if ('visitor' in owner) await assertVisitorActive(store, owner.visitor);
  if (textDue(record, Date.now(), textGraceMs())) record = await purgeDueText(store, id, Date.now());
  if (!record.paymentJournal && Date.now() >= Date.parse(record.request.expiresAt) &&
      (record.request.state === 'payment_required' || record.request.state === 'approval_required' || record.request.state === 'ready'))
    return publicRequest(await store.update<AiRecord>(prefix + id, (current) => {
      if (!current.paymentJournal && Date.now() >= Date.parse(current.request.expiresAt)) {
        current.request.state = 'expired'; current.request.error = 'Review expired before inference. No inference payment was sent.';
      }
      return current;
    }));
  if (record.request.approval?.state === 'review' && record.request.approval.request &&
      Date.now() >= Date.parse(record.request.approval.request.expiresAt) && !record.approvalJournal?.signed)
    return publicRequest(await store.update<AiRecord>(prefix + id, (current) => {
      if (current.request.approval?.state === 'review' && current.request.approval.request &&
          Date.now() >= Date.parse(current.request.approval.request.expiresAt) && !current.approvalJournal?.signed) {
        current.request.approval.state = 'expired'; current.request.approval.request = null;
        current.request.state = 'payment_required';
      }
      return current;
    }));
  if (record.request.state === 'settling') return publicRequest(await settleStored(store, record));
  if (record.request.state === 'failed' && record.paymentJournal && !record.paymentJournal.signed &&
      record.payee && 'payer' in record.owner) {
    await recoverExpiredUnsignedSettlement(store, prefix + id, record.owner.payer, record.payee);
    return publicRequest((await store.get<AiRecord>(prefix + id))!);
  }
  if (record.request.state === 'running' && record.runningAt && Date.now() - record.runningAt > (record.request.host ? 95000 : 150000)) {
    if (record.request.host) await cancelConnectorInference(store, id);
    const interrupted = await store.update<AiRecord>(prefix + id, (current) => {
      if (current.request.state === 'running') {
        current.request.state = 'interrupted'; current.request.error = 'Inference was interrupted. No inference tokens were charged.';
        if (current.request.host && current.runningAt) current.completedAt = new Date(current.runningAt + 95000).toISOString();
      }
      return current;
    });
    return publicRequest(interrupted);
  }
  return publicRequest(record);
}
function parseInput(body: Record<string, unknown>): AiInput {
  if ((body.mode !== 'paid' && body.mode !== 'library') || typeof body.prompt !== 'string' ||
      body.prompt.trim().length < 3 || body.prompt.length > 2000 ||
      !Number.isSafeInteger(body.maxOutputTokens) || (body.maxOutputTokens as number) < 16 ||
      (body.maxOutputTokens as number) > AI_MAX_OUTPUT ||
      !['general', 'housing', 'business'].includes(String(body.context)))
    throw new WorkflowError('Give a 3–2000 character prompt, a context, and 16–192 output tokens.');
  const hostScope = body.hostScope ?? 'own';
  if (hostScope !== 'own' && hostScope !== 'city') throw new WorkflowError('Choose your own host or city hosts.');
  const publicQuestion = body.publicQuestion === true;
  if (hostScope === 'city' && !publicQuestion) throw new WorkflowError('City hosts may receive only questions you explicitly mark public.');
  return { mode: body.mode, prompt: body.prompt.trim(), maxOutputTokens: body.maxOutputTokens as number, context: body.context as LocalAiContext, hostScope, publicQuestion };
}
async function prepareQuote(store: Store, id: string, owner: AiOwner, input: AiInput, resourceUrl: string) {
  const now = Date.now();
  const connector = process.env.LOCAL_AI_OLLAMA_URL ? null :
    await chooseConnectorHost(store, 'payer' in owner ? owner : {}, AI_MODEL, input.hostScope);
  if (!process.env.LOCAL_AI_OLLAMA_URL && !connector) throw new ConflictError('No online host serves this model within your chosen question privacy scope.');
  const payee = input.mode === 'paid' ? connector ? getAddress(connector.payoutWallet!) : await inferencePayee() : null;
  const payer = 'payer' in owner ? owner.payer : null;
  if (input.mode === 'paid') {
    if (!payer || !payee || payee.toLowerCase() === payer.toLowerCase()) throw new ConflictError('Paid requests require separate payer and provider wallets.');
    if (!connector) await assertInferenceAvailable();
    await assertInferenceContracts();
    const account = await facilitatorAccount();
    if (await aiRpc.getBalance({ address: account.address }) < 50000000000000n)
      throw new ConflictError('Dedicated facilitator account needs testnet gas before paid inference.');
  }
  const signature = inputFingerprint(id, owner, input, resourceUrl, payee, connector?.id);
  let required: PaymentRequired | null = null;
  const expiry = new Date(now + 18 * 60_000).toISOString();
  if (input.mode === 'paid') {
    const resource = await createAiResource(store, prefix + id, payer!, payee!);
    const requirements = await resource.buildPaymentRequirements({ scheme: 'exact', network: 'eip155:46630', payTo: payee!,
      price: { asset: TEST_USDG_ADDRESS, amount: AI_PRICE.toString() }, maxTimeoutSeconds: 1200,
      extra: { assetTransferMethod: 'permit2', paymentFlow: 'authorization' } });
    required = await resource.createPaymentRequiredResponse(requirements, { url: resourceUrl, description: 'One completed local Qwen inference answer', mimeType: 'application/json' }, undefined,
      { 'payment-identifier': declarePaymentIdentifierExtension(true) });
  }
  const request: LocalAiRequest = { id, mode: input.mode,
    state: input.mode === 'paid' ? 'payment_required' : 'ready', model: AI_MODEL, prompt: input.prompt,
    maxOutputTokens: input.maxOutputTokens, requestFingerprint: signature, createdAt: new Date(now).toISOString(), expiresAt: expiry,
    answer: null, purgedAt: null, usage: null, error: null,
    payment: { state: input.mode === 'paid' ? 'quoted' : 'none', amountAtomic: input.mode === 'paid' ? AI_PRICE.toString() : '0', receipt: null },
    review: input.mode === 'paid' ? { walletId: (owner as Extract<AiOwner, { walletId: string }>).walletId,
      operationId: id, description: 'Pay 0.01 tUSDG for one completed local Qwen answer', expiresAt: expiry,
      requestId: id, requestFingerprint: signature, resourceUrl, chainId: 46630,
      asset: TEST_USDG_ADDRESS, payTo: payee!, amountAtomic: AI_PRICE.toString() } : null,
    paymentRequired: required, approval: null,
  };
  if (connector) request.host = { id: connector.id, name: connector.name, ownerSubject: connector.ownerSubject!, payoutWallet: connector.payoutWallet! };
  request.hostScope = input.hostScope; request.publicQuestion = input.publicQuestion;
  const record: AiRecord = { id, mode: input.mode, owner, request, context: input.context, payee, resourceUrl,
    paymentJournal: null, approvalJournal: null };
  await store.create(prefix + id, record);
  return record;
}
async function reserveNonce(store: Store, record: AiRecord, payload: PaymentPayload) {
  const auth = (payload.payload as { permit2Authorization: { nonce: string } }).permit2Authorization;
  const payer = (record.owner as Extract<AiOwner, { payer: Address }>).payer;
  const key = `local-ai:nonce:46630:${PERMIT2_ADDRESS.toLowerCase()}:${payer.toLowerCase()}:${auth.nonce}`;
  try { await store.create(key, { requestId: record.id }); }
  catch {
    const previous = await store.get<{ requestId: string }>(key);
    if (!previous || previous.requestId !== record.id) throw new ConflictError('This Permit2 nonce is already reserved to another operation.');
  }
  const latest = await store.update<AiRecord>(prefix + record.id, (current) => {
    own(current, record.owner);
    if (current.paymentJournal) {
      if (JSON.stringify(current.paymentJournal.payload) !== JSON.stringify(payload)) throw new ConflictError('A different payment already belongs to this request.');
      return current;
    }
    if (current.request.state !== 'payment_required' && current.request.state !== 'approval_required') throw new ConflictError('Inference state changed before authorization.');
    current.paymentJournal = { payload, requirements: current.request.paymentRequired!.accepts[0], signed: null, hash: null, nonce: null };
    current.request.payment.state = 'authorized'; current.request.state = 'ready';
    return current;
  });
  return latest;
}
async function settleStored(store: Store, record: AiRecord): Promise<AiRecord> {
  if (!record.request.answer || !record.paymentJournal || !record.payee || !('payer' in record.owner)) throw new ConflictError('No completed authorized inference is available.');
  if (await recoverExpiredUnsignedSettlement(store, prefix + record.id, record.owner.payer, record.payee))
    return (await store.get<AiRecord>(prefix + record.id))!;
  const resource = await createAiResource(store, prefix + record.id, record.owner.payer, record.payee);
  let receipt: SettleResponse;
  try { receipt = await resource.settlePayment(record.paymentJournal.payload, record.paymentJournal.requirements, record.request.paymentRequired?.extensions); }
  catch {
    return store.update<AiRecord>(prefix + record.id, (value) => {
      if (value.request.state === 'completed' || value.request.state === 'failed') return value;
      value.request.payment.state = 'pending'; value.request.state = 'settling';
      return value;
    });
  }
  const latest = await store.get<AiRecord>(prefix + record.id);
  let outcome: 'settled' | 'pending' | 'failed' = 'pending';
  if (latest?.paymentJournal?.hash && receipt.transaction === latest.paymentJournal.hash) {
    try { outcome = await inspectAiReceipt(latest.paymentJournal, record.owner.payer, record.payee); }
    catch { /* RPC evidence is indeterminate, not a failed payment. */ }
  }
  if (receipt.success && outcome === 'settled') {
    return store.update<AiRecord>(prefix + record.id, (value) => {
      if (value.request.state === 'completed' || value.request.state === 'failed') return value;
      if (value.paymentJournal?.hash !== receipt.transaction) throw new ConflictError('Settlement journal changed.');
      value.request.payment.state = 'settled'; value.request.payment.receipt = receipt;
      value.request.state = 'completed'; value.request.error = null; value.completedAt = new Date().toISOString();
      return value;
    });
  }
  return store.update<AiRecord>(prefix + record.id, (value) => {
    if (value.request.state === 'completed' || value.request.state === 'failed') return value;
    if (outcome === 'failed') {
      value.request.payment.state = 'failed'; value.request.state = 'failed';
      value.request.error = 'The saved fee transaction was canonically reverted. No inference-token revenue was received.';
    } else {
      value.request.payment.state = 'pending'; value.request.state = 'settling';
      value.request.error = 'Payment confirmation is pending. The saved answer remains private.';
    }
    return value;
  });
}
export async function executeAiRequest(store: Store, id: string, owner: AiOwner, body: Record<string, unknown>, resourceUrl: string, paymentHeader: string | null): Promise<LocalAiRequest> {
  validId(id);
  const input = parseInput(body);
  if ('visitor' in owner) await assertVisitorActive(store, owner.visitor);
  if ((input.mode === 'paid') !== ('payer' in owner)) throw new AccessError('Select your personal wallet for paid requests.');
  let record = await store.get<AiRecord>(prefix + id);
  if (record && textDue(record, Date.now(), textGraceMs())) record = await purgeDueText(store, id, Date.now());
  if (record) {
    own(record, owner);
    if (record.request.requestFingerprint !== inputFingerprint(id, owner, input, resourceUrl, record.payee, record.request.host?.id))
      throw new ConflictError('Request ID already belongs to different inference inputs.');
  }
  else {
    try { record = await prepareQuote(store, id, owner, input, resourceUrl); }
    catch (error) {
      record = await store.get<AiRecord>(prefix + id);
      if (!record) throw error;
      own(record, owner);
      if (record.request.requestFingerprint !== inputFingerprint(id, owner, input, resourceUrl, record.payee, record.request.host?.id)) throw new ConflictError('Request ID already belongs to different inference inputs.');
    }
  }
  const payee = record.payee;
  if (record.request.purgedAt) return publicRequest(record);
  if (record.request.state === 'completed' || record.request.state === 'interrupted') return publicRequest(record);
  if (record.request.state === 'failed') {
    if (record.paymentJournal && !record.paymentJournal.signed && record.payee && 'payer' in record.owner)
      await recoverExpiredUnsignedSettlement(store, prefix + id, record.owner.payer, record.payee);
    return publicRequest((await store.get<AiRecord>(prefix + id))!);
  }
  if (record.request.state === 'settling') return publicRequest(await settleStored(store, record));
  if (record.request.state === 'running') return publicRequest(record);
  if (Date.now() > Date.parse(record.request.expiresAt)) return publicRequest(await store.update<AiRecord>(prefix + id, (value) => {
    if (!value.paymentJournal) { value.request.state = 'expired'; value.request.error = 'Inference review expired without a payment.'; }
    return value;
  }));
  if (input.mode === 'paid') {
    if (!paymentHeader && !record.paymentJournal) return publicRequest(record);
    if (!record.paymentJournal) {
      const payer = (owner as Extract<AiOwner, { payer: Address }>).payer;
      const allowance = await aiRpc.readContract({ address: TEST_USDG_ADDRESS, abi: aiTokenAbi, functionName: 'allowance', args: [payer, PERMIT2_ADDRESS] });
      if (allowance < AI_PRICE || allowance > AI_BUDGET)
        throw new ConflictError('Review and confirm the exact finite Permit2 approval before authorizing payment.');
      const payload = decodePaymentSignatureHeader(paymentHeader!);
      const resource = await createAiResource(store, prefix + id, (owner as Extract<AiOwner, { payer: Address }>).payer, payee!);
      const required = record.request.paymentRequired!;
      if (!resource.validateExtensions(required, payload).valid) throw new ConflictError('Invalid payment identifier extension.');
      const matching = resource.findMatchingRequirements(required.accepts, payload);
      if (!matching) throw new ConflictError('Payment differs from the immutable quote.');
      await validatePaymentPayload(payload, matching, id, (owner as Extract<AiOwner, { payer: Address }>).payer, payee!, resourceUrl);
      const result = await resource.verifyPayment(payload, matching, required.extensions);
      if (!result.isValid || result.payer?.toLowerCase() !== (owner as Extract<AiOwner, { payer: Address }>).payer.toLowerCase()) throw new ConflictError('Signed payment could not be verified. Check balance and finite Permit2 allowance.');
      record = await reserveNonce(store, record, payload);
    } else if (paymentHeader && JSON.stringify(decodePaymentSignatureHeader(paymentHeader)) !== JSON.stringify(record.paymentJournal.payload))
      throw new ConflictError('A different authorization cannot replace this operation.');
  }
  if (!record.request.host) {
    try { await reserveHost(store, id); }
    catch { return publicRequest(record); }
  }
  try {
    record = await store.update<AiRecord>(prefix + id, (value) => {
      if (value.request.state !== 'ready') throw new ConflictError('Inference already started.');
      value.request.state = 'running'; value.runningAt = Date.now(); return value;
    });
    if (input.mode === 'library') {
      if (!('visitor' in owner)) throw new AccessError('Library request has no visitor session.');
      const quotaKey = `local-ai:visitor:${owner.visitor}`;
      const dayKey = `local-ai:library-day:${new Date().toISOString().slice(0, 10)}`;
      try {
        try { await store.create(quotaKey, { count: 0 }); } catch { /* existing quota */ }
        const visitor = await store.get<{ count: number }>(quotaKey);
        if (!visitor || visitor.count >= 3) throw new ConflictError('This visitor has used three free local attempts.');
        try { await store.create(dayKey, { attempts: 0 }); } catch { /* existing daily reservation */ }
        await store.update<{ attempts: number }>(dayKey, (day) => {
          if (day.attempts >= 30) throw new ConflictError('The shared library has used its 30 daily inference attempts.');
          return { attempts: day.attempts + 1 };
        });
        await store.update<{ count: number }>(quotaKey, (quota) => {
          if (quota.count >= 3) throw new ConflictError('This visitor has used three free local attempts.');
          return { count: quota.count + 1 };
        });
      } catch (error) {
        await store.update<AiRecord>(prefix + id, (value) => {
          value.request.state = 'failed'; value.request.error = error instanceof Error ? error.message : 'Library quota exhausted.';
          return value;
        });
        throw error;
      }
    }
    try {
      const inference = record.request.host ? await enqueueConnectorInference(store, record.request.host.id, id, {
        model: record.request.model,
        messages: [{ role: 'system', content: instructions[input.context] }, { role: 'user', content: input.prompt }],
        options: { num_ctx: AI_CONTEXT_TOKENS, num_predict: input.maxOutputTokens, temperature: 0.35 },
      }) : await runLocalInference(input);
      // Complete output and actual usage are durable before the settlement signer may write.
      record = await store.update<AiRecord>(prefix + id, (value) => {
        if (value.request.state !== 'running') throw new ConflictError('Inference ownership changed.');
        value.request.answer = inference.answer; value.request.usage = inference.usage;
        value.request.state = input.mode === 'paid' ? 'settling' : 'completed';
        if (input.mode === 'library') value.completedAt = new Date().toISOString();
        return value;
      });
    } catch (error) {
      record = await store.update<AiRecord>(prefix + id, (value) => {
        if (value.request.state === 'running') {
          value.request.state = 'failed'; value.request.error = error instanceof Error ? error.message : 'Local inference failed. No inference payment was sent.';
        }
        return value;
      });
    }
  } finally { if (!record.request.host) await releaseHost(store, id); }
  if (record.request.state === 'settling') record = await settleStored(store, record);
  if ('visitor' in owner) await assertVisitorActive(store, owner.visitor);
  return publicRequest(record);
}
