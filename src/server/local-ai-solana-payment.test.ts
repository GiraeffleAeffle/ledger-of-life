import assert from 'node:assert/strict';
import test from 'node:test';
import { address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, generateKeyPairSigner, getBase58Decoder, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, blockhash } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { houseAddresses, HOUSE_DISCRIMINATORS } from '../finance/solana/house.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { prepareSolanaInferenceApproval } from '../wallets/solana-inference-signing.ts';
import { solanaAiApprovalInstructions, solanaAiRecipient, solanaAiSettlementInstructions, settleSolanaAi } from './local-ai-payment.ts';
import { createSolanaOperations } from './solana-operations.ts';
import { LocalStore } from './store.ts';
import type { SolanaHouseManifest } from './solana-house-config.ts';
import type { LocalAiApproval, LocalAiRequest, SolanaInferenceReview } from './local-ai-types.ts';
import type { SolanaOperationsGateway } from './solana-operations.ts';
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
    simulate: async () => ({ slot: '1', sponsorDebitCeilingLamports: '5000', networkFeeLamports: '5000' }),
    broadcast: async bytes => { broadcasts++; return getBase58Decoder().decode(getTransactionDecoder().decode(bytes).signatures[f.sponsor.address]!); },
    reconcile: async signature => finalized ? ({ status: 'finalized', signature, slot: '2', deltas: [] }) : ({ status: 'pending', reason: 'awaiting-finality' }),
  };
  const operations = createSolanaOperations({ store, sponsor, gateway, config: { cluster: 'devnet', genesisHash: f.manifest.genesisHash, maximumSponsorLamports: 10_000_000n } });
  const executeAsSponsor = operations.executeAsSponsor.bind(operations);
  operations.executeAsSponsor = async input => {
    assert.equal(input.sponsorshipSubject, 'did:privy:payer');
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
