import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, generateKeyPairSigner, getBase58Decoder, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, blockhash } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { houseAddresses, HOUSE_DISCRIMINATORS } from '../finance/solana/house.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { prepareSolanaInferenceApproval } from '../wallets/solana-inference-signing.ts';
import { solanaAiApproval, solanaAiApprovalInstructions, solanaAiRecipient, solanaAiSettlementDeltas, solanaAiSettlementInstructions, settleSolanaAi } from './local-ai-payment.ts';
import type { SolanaAiJournal } from './local-ai-payment.ts';
import { createSolanaOperations } from './solana-operations.ts';
import { LocalStore } from './store.ts';
import type { SolanaHouseManifest } from './solana-house-config.ts';
import type { LocalAiApproval, LocalAiRequest, SolanaInferenceReview } from './local-ai-types.ts';
import type { SolanaOperationsGateway, SponsorshipLimits } from './solana-operations.ts';
import { SolanaServiceError } from './solana-service.ts';
import { paidOwner, readAiRequest } from './local-ai.ts';
type SavedSolanaAi = { id: string; mode?: 'paid'; owner: { subject: string; walletId: string; payer: string; network: 'solana-devnet' }; request: LocalAiRequest; solanaJournal: SolanaAiJournal };
const programId = 'DuFehTh7HJVxTmBhdJiDxsDrd6xXMnQW35jzLPxBeDfb'; // Pure client fixture; never broadcasts to escrow.
const requestId = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const payer = await generateKeyPairSigner(), sponsor = await generateKeyPairSigner();
  const homes = await houseAddresses('neighbourhood-homes', programId), workshop = await houseAddresses('workshop', programId);
  const [source] = await findAssociatedTokenPda({ owner: payer.address, mint: address(SOLANA_TEST_USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const review: SolanaInferenceReview = { walletId: 'payer', operationId: requestId, requestId, requestFingerprint: 'fixed',
    description: 'One finite answer', expiresAt: new Date(Date.now() + 600_000).toISOString(), network: 'solana-devnet',
    asset: SOLANA_TEST_USDC_MINT, payer: payer.address, source, delegate: sponsor.address, payTo: homes.house,
    route: 'house', hostOwnerSubject: 'did:privy:host', maxOutputTokens: 128, amountAtomic: '12800', priceAtomic: '100' };
  const manifest: SolanaHouseManifest = { cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, programId, cashMint: SOLANA_TEST_USDC_MINT,
    houses: { 'neighbourhood-homes': homes, workshop } };
  const request: LocalAiRequest = { id: requestId, mode: 'paid', state: 'settling', model: 'Qwen', prompt: 'A question', maxOutputTokens: 128,
    requestFingerprint: 'fixed', createdAt: new Date().toISOString(), expiresAt: review.expiresAt, answer: 'A measured stub answer used only in a test.',
    usage: { inputTokens: 20, outputTokens: 37, wallMs: 10, totalMs: 10, loadMs: 0, evalMs: 10, tokensPerSecond: 3700 }, error: null,
    payment: { state: 'authorized', amountAtomic: '3700', receipt: null }, review: null, paymentRequired: null,
    approval: { id: 'approved', state: 'completed', budgetAtomic: '12800', request: null, hash: 'approval-signature', error: null }, solanaReview: review };
  return { payer, sponsor, review, manifest, request };
}
async function settlementFixture(t: TestContext, sponsorshipLimits: Partial<SponsorshipLimits> = {}) {
  const f = await fixture(), store = new LocalStore(':memory:');
  t.after(() => store.close());
  const state = { now: Date.now(), signatures: 0, simulations: 0, finalized: false, failed: false, broadcasts: [] as Uint8Array[] };
  const sponsor = { address: f.sponsor.address, sign: async (bytes: Uint8Array) => {
    state.signatures++;
    return new Uint8Array(getTransactionEncoder().encode(await partiallySignTransaction([f.sponsor.keyPair], getTransactionDecoder().decode(bytes))));
  } };
  const gateway: SolanaOperationsGateway = {
    lifetime: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: '999', blockHeight: '1' }),
    blockHeight: async () => '1',
    simulate: async () => { state.simulations++; return { slot: '1', sponsorDebitCeilingLamports: '5000', networkFeeLamports: '5000' }; },
    broadcast: async bytes => { state.broadcasts.push(Uint8Array.from(bytes)); return getBase58Decoder().decode(getTransactionDecoder().decode(bytes).signatures[f.sponsor.address]!); },
    reconcile: async signature => state.finalized ? { status: 'finalized', signature, slot: '2', deltas: [] } :
      state.failed ? { status: 'failed', reason: 'transaction-error' } : { status: 'unknown', reason: 'signature-not-observed-do-not-resubmit-new-intent' },
  };
  const operations = createSolanaOperations({ store, sponsor, gateway, now: () => state.now,
    config: { cluster: 'devnet', genesisHash: f.manifest.genesisHash, maximumSponsorLamports: 10_000_000n, sponsorshipLimits } });
  const key = `local-ai:request:${requestId}`;
  await store.create<SavedSolanaAi>(key, { id: requestId,
    owner: { subject: 'did:privy:payer', walletId: 'payer', payer: f.payer.address, network: 'solana-devnet' },
    request: f.request, solanaJournal: { approvalId: 'approved', settlementId: null } });
  const dependencies = { context: async () => ({ operations, manifest: f.manifest, sponsor }), wallet: async () => null };
  const intent = { kind: 'ai-settle', requestId, sponsorshipSubject: 'did:privy:payer',
    instructions: await solanaAiSettlementInstructions(f.review, 3700n, f.manifest.programId),
    review: { ...f.review, actualAmountAtomic: '3700', sourceKind: 1 },
    expectedDeltas: await solanaAiSettlementDeltas(f.review, 3700n, f.manifest.programId) };
  return { ...f, store, state, sponsor, gateway, operations, key, dependencies, intent,
    saved: async () => (await store.get<SavedSolanaAi>(key))! };
}
async function approvalFixture(t: TestContext) {
  const f = await settlementFixture(t);
  t.mock.method(Date, 'now', () => f.state.now);
  const identity = { subject: 'did:privy:payer', sessionId: 'fixture', expiresAt: 9999999999, passkeyCount: 1,
    wallets: [{ id: 'payer', address: f.payer.address, chainType: 'solana' as const }] };
  const owner = paidOwner(identity, 'solana-devnet');
  await f.store.update<SavedSolanaAi>(f.key, row => {
    row.mode = 'paid';
    row.request.state = 'payment_required'; row.request.answer = null; row.request.usage = null; row.request.approval = null;
    row.request.payment = { state: 'quoted', amountAtomic: f.review.amountAtomic, receipt: null };
    row.solanaJournal = { approvalId: null, settlementId: null };
    return row;
  });
  const prepare = () => solanaAiApproval(f.store, f.key, identity, 'prepare', undefined, f.dependencies);
  const submit = async (approval: LocalAiApproval) => {
    const transaction = getTransactionDecoder().decode(Buffer.from(approval.solanaRequest!.transactionBase64, 'base64'));
    const signed = await partiallySignTransaction([f.payer.keyPair], transaction);
    return solanaAiApproval(f.store, f.key, identity, 'submit', Buffer.from(getTransactionEncoder().encode(signed)).toString('base64'), f.dependencies);
  };
  const nextQuote = async (id: string) => {
    const key = `local-ai:request:${id}`, expiresAt = new Date(Date.now() + 600_000).toISOString(), previous = await f.saved();
    await f.store.create<SavedSolanaAi>(key, { ...previous, id,
      request: { ...f.request, id, state: 'payment_required', answer: null, usage: null, approval: null, error: null, recovery: null,
        requestFingerprint: id, createdAt: new Date().toISOString(), expiresAt,
        payment: { state: 'quoted', amountAtomic: f.review.amountAtomic, receipt: null },
        solanaReview: { ...f.review, operationId: id, requestId: id, requestFingerprint: id, expiresAt } },
      solanaJournal: { approvalId: null, settlementId: null } });
    return key;
  };
  return { ...f, identity, owner, prepare, submit, nextQuote };
}
test('Solana approval has exactly one bounded SPL approve and helper rejects changed amount/delegate/instructions', async () => {
  const f = await fixture();
  const instructions = solanaAiApprovalInstructions(f.review);
  assert.equal(instructions.length, 1); assert.equal(instructions[0].programAddress, TOKEN_PROGRAM_ADDRESS);
  assert.equal(instructions[0].data![0], 4); assert.equal(new DataView(Uint8Array.from(instructions[0].data!).buffer).getBigUint64(1, true), 12800n);
  const compiled = compileTransaction(pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayer(f.sponsor.address, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 999n }, m),
    m => appendTransactionMessageInstructions(instructions, m)));
  const approval: LocalAiApproval = { id: 'approval', state: 'review', budgetAtomic: '12800', request: null, hash: null, error: null,
    solanaRequest: { walletId: 'payer', operationId: `local-ai-approval:${requestId}`, description: 'Approve one answer', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      chain: 'solana:devnet', feePayer: f.sponsor.address, transactionBase64: Buffer.from(getTransactionEncoder().encode(compiled)).toString('base64') } };
  const wallet = { id: 'payer', address: f.payer.address, connected: true, chainType: 'solana' as const };
  assert.equal((await prepareSolanaInferenceApproval(f.request, approval, wallet)).feePayer, f.sponsor.address);
  await assert.rejects(prepareSolanaInferenceApproval(f.request, { ...approval, budgetAtomic: '12801' }, wallet));
  await assert.rejects(prepareSolanaInferenceApproval({ ...f.request, solanaReview: { ...f.review, delegate: f.payer.address } }, approval, wallet));
  const changed = solanaAiApprovalInstructions({ ...f.review, maxOutputTokens: 129, amountAtomic: '12900' });
  const extra = compileTransaction(pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayer(f.sponsor.address, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 999n }, m),
    m => appendTransactionMessageInstructions([...instructions, ...changed], m)));
  await assert.rejects(prepareSolanaInferenceApproval(f.request, { ...approval, solanaRequest: { ...approval.solanaRequest!, transactionBase64: Buffer.from(getTransactionEncoder().encode(extra)).toString('base64') } }, wallet));
});
test('actual amount is bounded and payout instructions route to house source AI or verified host ATA', async () => {
  const f = await fixture();
  const house = await solanaAiSettlementInstructions(f.review, 3700n, programId);
  assert.deepEqual([...house[0].data!.slice(0, 8)], HOUSE_DISCRIMINATORS.deposit_rewards);
  assert.equal(new DataView(Uint8Array.from(house[0].data!).buffer).getBigUint64(8, true), 3700n); assert.equal(house[0].data![16], 1);
  const host = await generateKeyPairSigner(); const walletReview = { ...f.review, route: 'wallet' as const, payTo: host.address };
  const transfer = await solanaAiSettlementInstructions(walletReview, 3700n, programId);
  assert.equal(transfer.length, 2); assert.equal(transfer[1].programAddress, TOKEN_PROGRAM_ADDRESS); assert.equal(transfer[1].data![0], 12); assert.equal(transfer[1].data![9], 6);
  const [ata] = await findAssociatedTokenPda({ owner: host.address, mint: address(f.review.asset), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  assert.equal(transfer[1].accounts![2].address, ata);
  await assert.rejects(solanaAiSettlementInstructions(f.review, 12801n, programId));
  const dependencies = { manifest: f.manifest, distributor: '0x1111111111111111111111111111111111111111', wallet: async () => ({ id: 'host', address: host.address }) };
  assert.equal((await solanaAiRecipient({ ownerSubject: 'host', payoutWallet: dependencies.distributor }, dependencies)).route, 'house');
  assert.equal((await solanaAiRecipient({ ownerSubject: 'host', payoutWallet: '0x2222222222222222222222222222222222222222' }, dependencies)).payTo, host.address);
  await assert.rejects(solanaAiRecipient({ ownerSubject: 'host', payoutWallet: '0x2222222222222222222222222222222222222222' }, { ...dependencies, wallet: async () => null }), /no Solana wallet yet/);
});
test('pending settlement reconciles identical journal, records actual receipt and never settles a completed answer twice', async () => {
  const f = await fixture(), store = new LocalStore(':memory:'); let broadcasts = 0, finalized = false;
  const sponsor = { address: f.sponsor.address, sign: async (bytes: Uint8Array) => new Uint8Array(getTransactionEncoder().encode(await partiallySignTransaction([f.sponsor.keyPair], getTransactionDecoder().decode(bytes)))) };
  const gateway: SolanaOperationsGateway = {
    lifetime: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: '999', blockHeight: '1' }),
    blockHeight: async () => '1',
    simulate: async () => ({ slot: '1', sponsorDebitCeilingLamports: '5000', networkFeeLamports: '5000' }),
    broadcast: async bytes => { broadcasts++; return getBase58Decoder().decode(getTransactionDecoder().decode(bytes).signatures[f.sponsor.address]!); },
    reconcile: async signature => finalized ? ({ status: 'finalized', signature, slot: '2', deltas: [] }) : ({ status: 'pending', reason: 'awaiting-finality' }),
  };
  const operations = createSolanaOperations({ store, sponsor, gateway, config: { cluster: 'devnet', genesisHash: f.manifest.genesisHash, maximumSponsorLamports: 10_000_000n } });
  const executeAsSponsor = operations.executeAsSponsor.bind(operations);
  operations.executeAsSponsor = async input => {
    assert.equal(input.sponsorshipSubject, 'did:privy:payer');
    const linked = await store.get<{ solanaJournal: SolanaAiJournal }>(`local-ai:request:${requestId}`);
    assert.ok(linked!.solanaJournal.settlementId, 'settlement must be linked before sponsor execution');
    return executeAsSponsor(input);
  };
  const key = `local-ai:request:${requestId}`;
  await store.create(key, { id: requestId, owner: { subject: 'did:privy:payer', walletId: 'payer', payer: f.payer.address, network: 'solana-devnet' }, request: f.request, solanaJournal: { approvalId: 'approved', settlementId: null } });
  const dependencies = { context: async () => ({ operations, manifest: f.manifest, sponsor }), wallet: async () => null };
  await settleSolanaAi(store, key, dependencies);
  assert.equal((await store.get<{ request: LocalAiRequest }>(key))!.request.payment.state, 'pending');
  finalized = true;
  await settleSolanaAi(store, key, dependencies); await settleSolanaAi(store, key, dependencies);
  const saved = await store.get<{ request: LocalAiRequest }>(key);
  assert.equal(saved!.request.payment.state, 'settled'); assert.equal(saved!.request.payment.receipt!.amount, '3700'); assert.ok(saved!.request.payment.receipt!.transaction); assert.equal(broadcasts, 1);
  await store.close();
});

test('context outages preserve the saved answer and expose only a safe stage/code until settlement resolves', async t => {
  const f = await settlementFixture(t), logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  await settleSolanaAi(f.store, f.key, { ...f.dependencies, context: async () => { throw new Error('Private RPC token and endpoint response'); } });
  const pending = await f.saved();
  assert.equal(pending.request.state, 'settling');
  assert.equal(pending.request.payment.state, 'pending');
  assert.equal(pending.request.payment.receipt, null);
  assert.equal(pending.request.answer, f.request.answer);
  assert.deepEqual(pending.request.recovery, { stage: 'settlement_context', code: 'settlement_unavailable', retryable: true });
  assert.equal(JSON.stringify(pending.request).includes('Private RPC'), false);
  assert.deepEqual(logs, [['local-ai-settlement', { requestId, stage: 'settlement_context', code: 'settlement_unavailable' }]]);
  assert.equal(f.state.signatures, 0);
  f.state.finalized = true;
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const completed = await f.saved();
  assert.equal(completed.request.state, 'completed');
  assert.equal(completed.request.payment.receipt!.amount, '3700');
  assert.equal(completed.request.recovery, undefined);
});

test('prepare simulation failures map exact reviewed messages and never disclose arbitrary error text or codes', async t => {
  const cases = [
    { error: new Error('Atomic simulation native balances unavailable'), code: 'simulation_evidence_unavailable', retryable: true },
    { error: new Error('Atomic simulation token balances unavailable'), code: 'simulation_evidence_unavailable', retryable: true },
    { error: new Error('Exact transaction simulation failed'), code: 'simulation_failed', retryable: true },
    { error: new Error('Wrong simulated token owner or mint'), code: 'simulation_token_owner', retryable: false },
    { error: new Error('Missing simulated token balance'), code: 'simulation_balance_missing', retryable: false },
    { error: new Error('Simulated token delta differs from review'), code: 'simulation_delta_mismatch', retryable: false },
    { error: new Error('RPC unavailable'), code: 'rpc_unavailable', retryable: true },
    { error: new Error('RPC request failed'), code: 'rpc_unavailable', retryable: true },
    { error: new SolanaServiceError(429, 'sponsor_subject_budget', 'Private response'), code: 'sponsor_subject_budget', retryable: true },
    { error: new SolanaServiceError(503, 'private-token-as-code', 'Private response'), code: 'settlement_unavailable', retryable: true },
    { error: new Error('RPC unavailable: private token'), code: 'settlement_unavailable', retryable: true },
    { error: new Error('__proto__'), code: 'settlement_unavailable', retryable: true },
  ];
  for (const scenario of cases) await t.test(scenario.code, async t => {
    const f = await settlementFixture(t), logs: unknown[][] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
    f.gateway.simulate = async () => { throw scenario.error; };
    await settleSolanaAi(f.store, f.key, f.dependencies);
    const saved = await f.saved();
    assert.equal(saved.request.state, 'settling');
    assert.equal(saved.request.payment.state, 'pending');
    assert.equal(saved.request.payment.receipt, null);
    assert.deepEqual(saved.request.recovery, { stage: 'settlement_prepare', code: scenario.code, retryable: scenario.retryable });
    assert.equal(saved.request.answer, f.request.answer);
    assert.equal(saved.solanaJournal.settlementId, null);
    assert.equal((await f.store.scan('solana-operation:')).length, 0);
    assert.equal(f.state.signatures, 0);
    assert.equal(f.state.broadcasts.length, 0);
    assert.deepEqual(logs, [['local-ai-settlement', { requestId, stage: 'settlement_prepare', code: scenario.code }]]);
  });
});

test('a transient presign RPC failure resumes the linked exact unsigned settlement without a new approval', async t => {
  const f = await settlementFixture(t), simulate = f.gateway.simulate;
  let failSubmission = true;
  t.mock.method(console, 'warn', () => {});
  f.gateway.simulate = async (...args) => {
    if (f.state.simulations === 1 && failSubmission) {
      failSubmission = false;
      throw new Error('RPC unavailable');
    }
    return simulate(...args);
  };
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const pending = await f.saved(), operationId = pending.solanaJournal.settlementId!;
  assert.ok(operationId);
  assert.deepEqual(pending.request.recovery, { stage: 'settlement_submit', code: 'rpc_unavailable', retryable: true });
  const prepared = await f.operations.get(operationId);
  assert.equal(prepared.state, 'prepared');
  assert.equal(f.state.signatures, 0);
  f.state.finalized = true;
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const completed = await f.saved();
  assert.equal(completed.request.state, 'completed');
  assert.equal(completed.request.payment.state, 'settled');
  assert.equal(completed.request.payment.receipt!.amount, '3700');
  assert.equal(completed.request.recovery, undefined);
  assert.equal(completed.solanaJournal.settlementId, operationId);
  assert.deepEqual(completed.request.approval, pending.request.approval);
  assert.equal((await f.operations.get(operationId)).transactionBase64, prepared.transactionBase64);
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
  assert.equal(f.state.signatures, 1);
  assert.equal(f.state.broadcasts.length, 1);
});

test('a crash after linking preparation and a later context outage resume the same durable unsigned operation', async t => {
  const f = await settlementFixture(t), prepared = await f.operations.prepareAsSponsor(f.intent);
  await f.store.update<SavedSolanaAi>(f.key, row => { row.solanaJournal.settlementId = prepared.id; return row; });
  t.mock.method(console, 'warn', () => {});
  await settleSolanaAi(f.store, f.key, { ...f.dependencies, context: async () => { throw new Error('RPC unavailable'); } });
  assert.deepEqual((await f.saved()).request.recovery, { stage: 'settlement_context', code: 'rpc_unavailable', retryable: true });
  assert.equal(f.state.signatures, 0);
  const restarted = createSolanaOperations({ store: f.store, gateway: f.gateway, sponsor: f.sponsor, now: () => f.state.now,
    config: { cluster: 'devnet', genesisHash: f.manifest.genesisHash, maximumSponsorLamports: 10_000_000n } });
  f.state.finalized = true;
  await settleSolanaAi(f.store, f.key, { ...f.dependencies, context: async () => ({ operations: restarted, manifest: f.manifest, sponsor: f.sponsor }) });
  const completed = await f.saved();
  assert.equal(completed.request.state, 'completed');
  assert.equal(completed.request.payment.receipt!.amount, '3700');
  assert.equal(completed.solanaJournal.settlementId, prepared.id);
  assert.equal((await restarted.get(prepared.id)).transactionBase64, prepared.transactionBase64);
  assert.equal(f.state.signatures, 1);
  assert.equal(f.state.broadcasts.length, 1);
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
});

test('an expired linked unsigned settlement is terminal and never replaced or charged', async t => {
  const f = await settlementFixture(t), prepared = await f.operations.prepareAsSponsor(f.intent);
  await f.store.update<SavedSolanaAi>(f.key, row => { row.solanaJournal.settlementId = prepared.id; return row; });
  f.state.now += 121_000;
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const failed = await f.saved();
  assert.equal(failed.request.state, 'failed');
  assert.equal(failed.request.payment.state, 'failed');
  assert.equal(failed.request.payment.receipt, null);
  assert.deepEqual(failed.request.recovery, { stage: 'settlement_reconcile', code: 'settlement_expired', retryable: false });
  assert.equal(failed.solanaJournal.settlementId, prepared.id);
  assert.equal((await f.operations.get(prepared.id)).state, 'expired');
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
  assert.equal((await f.store.scan('solana-sponsorship:')).length, 0);
  assert.equal(f.state.signatures, 0);
  assert.equal(f.state.broadcasts.length, 0);
});

test('linked unsigned resume rechecks recipient ownership and never substitutes a new payout wallet', async t => {
  const f = await settlementFixture(t), host = await generateKeyPairSigner(), replacement = await generateKeyPairSigner();
  await f.store.update<SavedSolanaAi>(f.key, row => {
    row.request.solanaReview = { ...f.review, route: 'wallet', payTo: host.address };
    return row;
  });
  let recipient: { id: string; address: string } | null = null, lookups = 0;
  const dependencies = { ...f.dependencies, wallet: async () => { lookups++; return recipient; } };
  t.mock.method(console, 'warn', () => {});
  await settleSolanaAi(f.store, f.key, dependencies);
  const operationId = (await f.saved()).solanaJournal.settlementId!, prepared = await f.operations.get(operationId);
  assert.equal(prepared.state, 'prepared');
  assert.equal(f.state.signatures, 0);
  recipient = { id: 'replacement', address: replacement.address };
  await settleSolanaAi(f.store, f.key, dependencies);
  assert.equal((await f.saved()).request.recovery!.stage, 'settlement_recipient');
  assert.equal(f.state.signatures, 0);
  assert.equal((await f.operations.get(operationId)).transactionBase64, prepared.transactionBase64);
  recipient = { id: 'host', address: host.address };
  f.state.finalized = true;
  await settleSolanaAi(f.store, f.key, dependencies);
  assert.equal((await f.saved()).request.payment.state, 'settled');
  assert.equal((await f.saved()).solanaJournal.settlementId, operationId);
  assert.equal(lookups, 3);
  assert.equal(f.state.signatures, 1);
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
});

test('linked unsigned resume requires the still-durable approval, payer ownership and measured intent', async t => {
  const changes: { name: string; change: (row: SavedSolanaAi) => void }[] = [
    { name: 'approval', change: row => { row.request.approval!.state = 'pending'; } },
    { name: 'approval cap', change: row => { row.request.approval!.budgetAtomic = '12900'; } },
    { name: 'owner', change: row => { row.owner.walletId = 'another-wallet'; } },
    { name: 'usage', change: row => { row.request.usage!.outputTokens = 38; } },
    { name: 'recipient intent', change: row => { row.request.solanaReview!.hostOwnerSubject = 'another-owner'; } },
  ];
  for (const scenario of changes) await t.test(scenario.name, async t => {
    const f = await settlementFixture(t), prepared = await f.operations.prepareAsSponsor(f.intent);
    await f.store.update<SavedSolanaAi>(f.key, row => { row.solanaJournal.settlementId = prepared.id; return row; });
    t.mock.method(console, 'warn', () => {});
    await settleSolanaAi(f.store, f.key, { ...f.dependencies, context: async () => {
      await f.store.update<SavedSolanaAi>(f.key, row => { scenario.change(row); return row; });
      return { operations: f.operations, manifest: f.manifest, sponsor: f.sponsor };
    } });
    const saved = await f.saved();
    assert.deepEqual(saved.request.recovery, { stage: 'settlement_prepare', code: 'invalid_operation', retryable: false });
    assert.equal(saved.request.payment.receipt, null);
    assert.equal(saved.solanaJournal.settlementId, prepared.id);
    assert.equal((await f.operations.get(prepared.id)).transactionBase64, prepared.transactionBase64);
    assert.equal(f.state.signatures, 0);
    assert.equal(f.state.broadcasts.length, 0);
    assert.equal((await f.store.scan('solana-operation:')).length, 1);
  });
});

test('a sponsorship pause keeps the linked intent and recovery charges the same subject exactly once', async t => {
  const f = await settlementFixture(t, { subjectRollingLamports: 0n });
  t.mock.method(console, 'warn', () => {});
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const pending = await f.saved(), operationId = pending.solanaJournal.settlementId!, prepared = await f.operations.get(operationId);
  assert.deepEqual(pending.request.recovery, { stage: 'settlement_submit', code: 'sponsor_subject_budget', retryable: true });
  assert.equal(f.state.signatures, 0);
  assert.equal(prepared.state, 'prepared');
  const resumed = createSolanaOperations({ store: f.store, gateway: f.gateway, sponsor: f.sponsor, now: () => f.state.now,
    config: { cluster: 'devnet', genesisHash: f.manifest.genesisHash, maximumSponsorLamports: 10_000_000n,
      sponsorshipLimits: { subjectRollingLamports: 5000n, subjectRollingTransactions: 1, globalDailyLamports: 5000n } } });
  f.state.finalized = true;
  const dependencies = { ...f.dependencies, context: async () => ({ operations: resumed, manifest: f.manifest, sponsor: f.sponsor }) };
  await settleSolanaAi(f.store, f.key, dependencies);
  await settleSolanaAi(f.store, f.key, dependencies);
  const completed = await f.saved(), ledger = await f.store.scan<{ reservations: Record<string, { state: string; subject: string; amountLamports: string }> }>('solana-sponsorship:');
  assert.equal(completed.request.payment.state, 'settled');
  assert.equal(completed.request.payment.receipt!.amount, '3700');
  assert.equal(completed.solanaJournal.settlementId, operationId);
  assert.equal((await resumed.get(operationId)).transactionBase64, prepared.transactionBase64);
  assert.deepEqual(Object.keys(ledger[0].value.reservations), [operationId]);
  assert.equal(ledger[0].value.reservations[operationId].state, 'charged');
  assert.equal(ledger[0].value.reservations[operationId].subject, 'did:privy:payer');
  assert.equal(ledger[0].value.reservations[operationId].amountLamports, '5000');
  assert.equal(f.state.signatures, 1);
  assert.equal(f.state.broadcasts.length, 1);
});

test('concurrent linked prepared recovery signs once and holds one shared sponsorship reservation', async t => {
  const f = await settlementFixture(t, { subjectRollingLamports: 5000n, subjectRollingTransactions: 1, globalDailyLamports: 5000n });
  const prepared = await f.operations.prepareAsSponsor(f.intent);
  await f.store.update<SavedSolanaAi>(f.key, row => { row.solanaJournal.settlementId = prepared.id; return row; });
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), sign = f.sponsor.sign;
  f.sponsor.sign = async bytes => { started.resolve(); await release.promise; return sign(bytes); };
  t.mock.method(console, 'warn', () => {});
  const first = settleSolanaAi(f.store, f.key, f.dependencies);
  await started.promise;
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const pending = await f.saved();
  assert.deepEqual(pending.request.recovery, { stage: 'settlement_submit', code: 'operation_pending', retryable: true });
  const ledger = await f.store.scan<{ reservations: Record<string, { state: string }> }>('solana-sponsorship:');
  assert.deepEqual(Object.keys(ledger[0].value.reservations), [prepared.id]);
  assert.equal(ledger[0].value.reservations[prepared.id].state, 'reserved');
  f.state.finalized = true;
  release.resolve();
  await first;
  assert.equal((await f.saved()).request.payment.state, 'settled');
  assert.equal((await f.saved()).request.recovery, undefined);
  assert.equal(f.state.signatures, 1);
  assert.equal(f.state.broadcasts.length, 1);
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
});

test('legacy orphaned expired sponsor preparation is linked and resolved instead of executing the expired intent forever', async t => {
  const f = await settlementFixture(t), prepared = await f.operations.prepareAsSponsor(f.intent);
  assert.equal(f.state.signatures, 0);
  assert.equal((await f.saved()).solanaJournal.settlementId, null);
  f.state.now += 121_000;
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const saved = await f.saved();
  assert.equal(saved.solanaJournal.settlementId, prepared.id);
  assert.equal(saved.request.state, 'failed');
  assert.equal(saved.request.payment.state, 'failed');
  assert.deepEqual(saved.request.recovery, { stage: 'settlement_reconcile', code: 'settlement_expired', retryable: false });
  assert.equal((await f.operations.get(prepared.id)).state, 'expired');
  assert.equal(f.state.signatures, 0);
  assert.equal(f.state.broadcasts.length, 0);
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
});

test('legacy orphaned failed settlement is linked to its proven failure without signing or broadcasting again', async t => {
  const f = await settlementFixture(t);
  f.state.failed = true;
  const failed = await f.operations.executeAsSponsor(f.intent), broadcasts = f.state.broadcasts.length;
  assert.equal(failed.state, 'failed');
  assert.equal((await f.saved()).solanaJournal.settlementId, null);
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const saved = await f.saved();
  assert.equal(saved.solanaJournal.settlementId, failed.id);
  assert.equal(saved.request.payment.state, 'failed');
  assert.equal(saved.request.state, 'failed');
  assert.equal(saved.request.payment.receipt, null);
  assert.deepEqual(saved.request.recovery, { stage: 'settlement_reconcile', code: 'settlement_failed', retryable: false });
  assert.equal(f.state.signatures, 1);
  assert.equal(f.state.broadcasts.length, broadcasts);
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
});

test('a lost signed-write acknowledgement recovers the same signed bytes and budget without signing another settlement', async t => {
  const f = await settlementFixture(t), update = f.store.update.bind(f.store), sign = f.sponsor.sign;
  t.mock.method(console, 'warn', () => {});
  f.sponsor.sign = async bytes => {
    assert.ok((await f.saved()).solanaJournal.settlementId, 'the inference link must be durable before signing');
    return sign(bytes);
  };
  let loseAcknowledgement = true;
  f.store.update = async (key, change) => {
    const next = await update(key, change);
    if (loseAcknowledgement && key.startsWith('solana-operation:') && typeof next === 'object' && next !== null && 'state' in next && next.state === 'broadcast') {
      loseAcknowledgement = false;
      throw new Error('Private signed-write acknowledgement lost');
    }
    return next;
  };
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const pending = await f.saved(), operationId = pending.solanaJournal.settlementId!;
  const signed = await f.store.get<{ signedTransactionBase64: string; signature: string }>(`solana-operation:${operationId}`);
  assert.ok(signed!.signature);
  assert.equal(pending.request.payment.state, 'pending');
  assert.deepEqual(pending.request.recovery, { stage: 'settlement_submit', code: 'settlement_unavailable', retryable: true });
  assert.equal(f.state.signatures, 1);
  assert.equal(f.state.broadcasts.length, 0);
  const ledger = await f.store.scan<{ reservations: Record<string, { state: string }> }>('solana-sponsorship:');
  assert.equal(ledger[0].value.reservations[operationId].state, 'reserved');
  f.store.update = update;
  await settleSolanaAi(f.store, f.key, f.dependencies);
  assert.equal((await f.saved()).request.payment.state, 'pending');
  assert.equal((await f.saved()).request.recovery, undefined, 'a canonical broadcast observation resumes normal polling');
  assert.equal((await f.saved()).request.payment.receipt, null);
  assert.equal(f.state.signatures, 1);
  assert.equal(f.state.broadcasts.length, 1);
  assert.equal(Buffer.from(f.state.broadcasts[0]).toString('base64'), signed!.signedTransactionBase64);
  f.state.finalized = true;
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const completed = await f.saved();
  assert.equal(completed.request.state, 'completed');
  assert.equal(completed.request.payment.receipt!.transaction, signed!.signature);
  assert.equal(completed.request.recovery, undefined);
  assert.equal(completed.solanaJournal.settlementId, operationId);
  assert.equal(f.state.signatures, 1);
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
});

test('reconciliation errors preserve ambiguity and proven on-chain failure resolves the same operation', async t => {
  const f = await settlementFixture(t);
  t.mock.method(console, 'warn', () => {});
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const operationId = (await f.saved()).solanaJournal.settlementId!;
  const reconcile = f.operations.reconcile;
  f.operations.reconcile = async () => { throw new Error('RPC unavailable'); };
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const pending = await f.saved();
  assert.deepEqual(pending.request.recovery, { stage: 'settlement_reconcile', code: 'rpc_unavailable', retryable: true });
  assert.equal(pending.request.payment.state, 'pending');
  assert.equal(pending.request.answer, f.request.answer);
  assert.equal(pending.request.payment.receipt, null);
  f.operations.reconcile = reconcile;
  f.state.failed = true;
  await settleSolanaAi(f.store, f.key, f.dependencies);
  const failed = await f.saved();
  assert.equal(failed.request.payment.state, 'failed');
  assert.equal(failed.request.state, 'failed');
  assert.deepEqual(failed.request.recovery, { stage: 'settlement_reconcile', code: 'settlement_failed', retryable: false });
  assert.equal(failed.solanaJournal.settlementId, operationId);
  assert.equal((await f.operations.get(operationId)).state, 'failed');
  assert.equal(f.state.signatures, 1);
});

test('recipient lookup failures are classified before signing but do not hide a legacy signed settlement', async t => {
  const f = await settlementFixture(t), host = await generateKeyPairSigner();
  await f.store.update<SavedSolanaAi>(f.key, row => {
    row.request.solanaReview = { ...f.review, route: 'wallet', payTo: host.address };
    return row;
  });
  t.mock.method(console, 'warn', () => {});
  await settleSolanaAi(f.store, f.key, { ...f.dependencies, wallet: async () => { throw new Error('Private identity endpoint failure'); } });
  const pending = await f.saved();
  assert.deepEqual(pending.request.recovery, { stage: 'settlement_recipient', code: 'settlement_unavailable', retryable: true });
  assert.ok(pending.solanaJournal.settlementId);
  assert.equal(f.state.signatures, 0);
  const review = pending.request.solanaReview!;
  const intent = { ...f.intent, instructions: await solanaAiSettlementInstructions(review, 3700n, f.manifest.programId),
    review: { ...review, actualAmountAtomic: '3700', sourceKind: 1 }, expectedDeltas: await solanaAiSettlementDeltas(review, 3700n, f.manifest.programId) };
  await f.operations.executeAsSponsor(intent);
  await f.store.update<SavedSolanaAi>(f.key, row => { row.solanaJournal.settlementId = null; return row; });
  f.state.finalized = true;
  let lookups = 0;
  await settleSolanaAi(f.store, f.key, { ...f.dependencies, wallet: async () => { lookups++; return null; } });
  assert.equal((await f.saved()).request.state, 'completed');
  assert.equal(lookups, 0, 'reconciliation of already signed bytes must not depend on a current recipient lookup');
  assert.equal(f.state.signatures, 1);
});

test('unrecoverable storage writes reject rather than fabricating a saved pending result', async t => {
  const f = await settlementFixture(t), update = f.store.update.bind(f.store);
  f.store.update = async (key, change) => {
    if (key === f.key) throw new Error('Saved resource storage is unavailable');
    return update(key, change);
  };
  await assert.rejects(settleSolanaAi(f.store, f.key, f.dependencies), /storage is unavailable/);
  assert.equal(f.state.signatures, 0);
  assert.equal(f.state.broadcasts.length, 0);
  assert.equal((await f.saved()).solanaJournal.settlementId, null);
});

test('an ambiguous legacy settlement cannot replace the bounded allowance even if the outer request already failed', async t => {
  const f = await settlementFixture(t), nextId = '22222222-2222-4222-8222-222222222222', nextKey = `local-ai:request:${nextId}`;
  const operation = await f.operations.executeAsSponsor(f.intent), broadcasts = f.state.broadcasts.length;
  assert.equal(operation.state, 'broadcast');
  assert.equal((await f.saved()).solanaJournal.settlementId, null);
  await f.store.update<SavedSolanaAi>(f.key, row => { row.request.state = 'failed'; row.request.payment.state = 'pending'; return row; });
  await f.store.create(`local-ai:solana-allowance:${f.payer.address}`, { requestId });
  const current = await f.saved();
  await f.store.create<SavedSolanaAi>(nextKey, { ...current, id: nextId,
    request: { ...current.request, id: nextId, state: 'payment_required', answer: null, usage: null, approval: null,
      solanaReview: { ...f.review, operationId: nextId, requestId: nextId }, payment: { state: 'quoted', amountAtomic: '12800', receipt: null } },
    solanaJournal: { approvalId: null, settlementId: null } });
  const identity = { subject: current.owner.subject, sessionId: 'fixture', expiresAt: 9999999999, passkeyCount: 1,
    wallets: [{ id: 'payer', address: f.payer.address, chainType: 'solana' as const }] };
  await assert.rejects(solanaAiApproval(f.store, nextKey, identity, 'prepare', undefined, f.dependencies), /earlier Solana settlement must be reconciled/);
  assert.deepEqual(await f.store.get(`local-ai:solana-allowance:${f.payer.address}`), { requestId });
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
  assert.equal(f.state.signatures, 1);
  assert.equal(f.state.broadcasts.length, broadcasts);
  assert.equal((await f.operations.get(operation.id)).signature, operation.signature);
});

test('expired unsigned approval bytes are terminalized instead of being re-served as a fresh deterministic review', async t => {
  const f = await approvalFixture(t), approval = await f.prepare();
  assert.equal(approval.state, 'review');
  const operationId = approval.id;
  f.state.now += 121_000;
  const expired = await f.prepare(), saved = await f.saved();
  assert.equal(expired.id, operationId);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.solanaRequest, null);
  assert.equal(saved.request.state, 'expired');
  assert.deepEqual(saved.request.recovery, { stage: 'approval', code: 'approval_expired', retryable: false });
  assert.match(saved.request.error!, /unsigned Solana approval review expired/);
  assert.doesNotMatch(saved.request.error!, /allowance.*expired/i);
  assert.equal(saved.request.payment.receipt, null);
  assert.equal((await f.operations.get(operationId)).state, 'expired');
  await assert.rejects(f.prepare(), /no longer available for approval/);
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
  assert.equal(f.state.signatures, 0);
  assert.equal(f.state.broadcasts.length, 0);
});

test('explicit reconcile-to-expired never enables reprepare of the same approval operation', async t => {
  const f = await approvalFixture(t), approval = await f.prepare();
  f.state.now += 121_000;
  const expired = await solanaAiApproval(f.store, f.key, f.identity, 'reconcile', undefined, f.dependencies);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.solanaRequest, null);
  assert.equal((await f.saved()).request.state, 'expired');
  await assert.rejects(f.prepare(), /no longer available for approval/);
  assert.equal((await f.operations.get(approval.id)).state, 'expired');
  assert.equal(f.state.signatures, 0);
});

test('owned saved reads reconcile expired Solana reviews and an explicit new question receives a new bounded approval', async t => {
  const f = await approvalFixture(t), approval = await f.prepare();
  f.state.now += 121_000;
  const expired = await readAiRequest(f.store, requestId, f.owner, f.dependencies);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.approval!.state, 'expired');
  assert.equal(expired.approval!.solanaRequest, null);
  assert.deepEqual(expired.recovery, { stage: 'approval', code: 'approval_expired', retryable: false });
  const nextId = '33333333-3333-4333-8333-333333333333', nextKey = await f.nextQuote(nextId);
  const next = await solanaAiApproval(f.store, nextKey, f.identity, 'prepare', undefined, f.dependencies);
  assert.equal(next.state, 'review');
  assert.notEqual(next.id, approval.id);
  assert.equal(next.budgetAtomic, '12800');
  assert.ok(Date.parse(next.solanaRequest!.expiresAt) > Date.now());
  assert.deepEqual(await f.store.get(`local-ai:solana-allowance:${f.payer.address}`), { requestId: nextId });
  assert.equal(f.state.signatures, 0);
});

test('changing question without revisiting the old ID lazily resolves its unsigned expiry before handing off the allowance lane', async t => {
  const f = await approvalFixture(t), oldApproval = await f.prepare();
  f.state.now += 121_000;
  const nextId = '44444444-4444-4444-8444-444444444444', nextKey = await f.nextQuote(nextId);
  const next = await solanaAiApproval(f.store, nextKey, f.identity, 'prepare', undefined, f.dependencies);
  assert.equal(next.state, 'review');
  const previous = await f.saved();
  assert.equal(previous.request.state, 'expired');
  assert.equal(previous.request.approval!.state, 'expired');
  assert.deepEqual(previous.request.recovery, { stage: 'approval', code: 'approval_expired', retryable: false });
  assert.equal((await f.operations.get(oldApproval.id)).state, 'expired');
  assert.deepEqual(await f.store.get(`local-ai:solana-allowance:${f.payer.address}`), { requestId: nextId });
  assert.equal((await f.store.scan('solana-operation:')).length, 2);
  assert.equal(f.state.signatures, 0);
  assert.equal(f.state.broadcasts.length, 0);
});

test('quote expiry cannot terminalize or replace a potentially signed pending approval before canonical resolution', async t => {
  const f = await approvalFixture(t), approval = await f.prepare(), pending = await f.submit(approval);
  assert.equal(pending.state, 'pending');
  f.state.now += 601_000;
  const saved = await readAiRequest(f.store, requestId, f.owner, f.dependencies);
  assert.equal(saved.state, 'approval_required');
  assert.equal(saved.approval!.state, 'pending');
  assert.equal(saved.payment.state, 'quoted');
  assert.equal(saved.payment.receipt, null);
  assert.equal(saved.recovery, undefined);
  const nextId = '55555555-5555-4555-8555-555555555555', nextKey = await f.nextQuote(nextId);
  await assert.rejects(solanaAiApproval(f.store, nextKey, f.identity, 'prepare', undefined, f.dependencies), /earlier signed Solana approval/);
  assert.deepEqual(await f.store.get(`local-ai:solana-allowance:${f.payer.address}`), { requestId });
  assert.equal((await f.operations.get(approval.id)).state, 'broadcast');
  assert.equal(f.state.signatures, 1);
  f.state.finalized = true;
  const confirmed = await readAiRequest(f.store, requestId, f.owner, f.dependencies);
  assert.equal(confirmed.approval!.state, 'completed');
  assert.equal(confirmed.state, 'expired', 'the inference quote may expire only after pending approval resolves');
  assert.equal(confirmed.payment.state, 'authorized', 'the SPL allowance itself has no TTL');
  assert.equal(confirmed.payment.receipt, null);
  assert.deepEqual(confirmed.recovery, { stage: 'approval', code: 'inference_quote_expired', retryable: false });
  const next = await solanaAiApproval(f.store, nextKey, f.identity, 'prepare', undefined, f.dependencies);
  assert.equal(next.state, 'review');
  assert.equal(f.state.signatures, 1);
});

test('approval reconciliation outages preserve the pending fence despite quote expiry and never expose RPC details', async t => {
  const f = await approvalFixture(t), approval = await f.prepare();
  await f.submit(approval);
  f.state.now += 601_000;
  const logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  f.operations.reconcile = async () => { throw new Error('Private RPC token response'); };
  const pending = await readAiRequest(f.store, requestId, f.owner, f.dependencies);
  assert.equal(pending.state, 'approval_required');
  assert.equal(pending.approval!.state, 'pending');
  assert.deepEqual(pending.recovery, { stage: 'approval', code: 'approval_unavailable', retryable: true });
  assert.equal(JSON.stringify(pending).includes('Private RPC'), false);
  assert.deepEqual(logs, [['local-ai-approval', { requestId, stage: 'approval', code: 'approval_unavailable' }]]);
  const nextId = '66666666-6666-4666-8666-666666666666', nextKey = await f.nextQuote(nextId);
  await assert.rejects(solanaAiApproval(f.store, nextKey, f.identity, 'prepare', undefined, f.dependencies), /earlier signed Solana approval/);
  assert.deepEqual(await f.store.get(`local-ai:solana-allowance:${f.payer.address}`), { requestId });
  assert.equal(f.state.signatures, 1);
});

test('a legacy quote-expired row with pending signed approval is restored to waiting rather than releasing its allowance lane', async t => {
  const f = await approvalFixture(t), approval = await f.prepare();
  await f.submit(approval);
  f.state.now += 601_000;
  await f.store.update<SavedSolanaAi>(f.key, row => { row.request.state = 'expired'; return row; });
  const pending = await readAiRequest(f.store, requestId, f.owner, f.dependencies);
  assert.equal(pending.state, 'approval_required');
  assert.equal(pending.approval!.state, 'pending');
  assert.equal(pending.payment.receipt, null);
  assert.equal((await f.operations.get(approval.id)).state, 'broadcast');
  assert.equal(f.state.signatures, 1);
});

test('discarding a pending question does not strand a canonically confirmed approval after its inference quote expires', async t => {
  const f = await approvalFixture(t), approval = await f.prepare();
  await f.submit(approval);
  f.state.now += 601_000;
  f.state.finalized = true;
  const nextId = '77777777-7777-4777-8777-777777777777', nextKey = await f.nextQuote(nextId);
  const next = await solanaAiApproval(f.store, nextKey, f.identity, 'prepare', undefined, f.dependencies);
  assert.equal(next.state, 'review');
  const previous = await f.saved();
  assert.equal(previous.request.approval!.state, 'completed');
  assert.equal(previous.request.state, 'expired');
  assert.equal(previous.request.payment.state, 'authorized');
  assert.deepEqual(previous.request.recovery, { stage: 'approval', code: 'inference_quote_expired', retryable: false });
  assert.deepEqual(await f.store.get(`local-ai:solana-allowance:${f.payer.address}`), { requestId: nextId });
  assert.equal(f.state.signatures, 1);
});

test('canonical signed approval failure is distinguishable from an expired unsigned approval review', async t => {
  const f = await approvalFixture(t), approval = await f.prepare();
  await f.submit(approval);
  f.state.failed = true;
  const failed = await readAiRequest(f.store, requestId, f.owner, f.dependencies);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.approval!.state, 'failed');
  assert.ok(failed.approval!.hash);
  assert.deepEqual(failed.recovery, { stage: 'approval', code: 'approval_failed', retryable: false });
  assert.equal(failed.payment.receipt, null);
  assert.equal((await f.operations.get(approval.id)).state, 'failed');
  const nextId = '88888888-8888-4888-8888-888888888888', nextKey = await f.nextQuote(nextId);
  const next = await solanaAiApproval(f.store, nextKey, f.identity, 'prepare', undefined, f.dependencies);
  assert.equal(next.state, 'review');
  assert.equal(f.state.signatures, 1);
});
