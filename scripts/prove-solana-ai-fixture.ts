import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { address, createNoopSigner, generateKeyPairSigner } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { LocalStore } from '../src/server/store.ts';
import { loadSolanaHouseManifest } from '../src/server/solana-house-config.ts';
import { configuredSolanaOperations } from '../src/server/solana-operations.ts';
import { assertTestSignerAllowed, testIdentity, signPrepared } from '../src/server/test-signer.ts';
import { paidOwner } from '../src/server/local-ai.ts';
import { solanaAiApproval, settleSolanaAi } from '../src/server/local-ai-payment.ts';
import type { LocalAiRequest, SolanaInferenceReview } from '../src/server/local-ai-types.ts';
import { mintTestUsdc } from '../src/server/test-usdc.ts';
import { testUsdcPayoutContext } from '../src/server/test-usdc-payout.ts';

/** Operator-only payment plumbing evidence: ephemeral signer, no Privy or GPU claim.
 * Requires --stub-answer and SOLANA_TEST_SIGNER_MODE=1. The existing site sponsor
 * funds from the existing faucet, or explicitly --sponsor-cash transfers 0.0128 tUSDC.
 * No alternative fee payer or funding fallback is used.
 * No key files are read. Run only after launch-owner send authorization. */
export async function proveSolanaAiFixture() {
  if (!process.argv.includes('--stub-answer')) throw new Error('Explicit --stub-answer is required; no GPU inference is claimed.');
  const manifest = loadSolanaHouseManifest();
  if (!manifest) throw new Error('The deployed devnet house manifest is required.');
  assertTestSignerAllowed(process.env, manifest);
  const store = new LocalStore(':memory:');
  try {
    const { operations, sponsor } = await configuredSolanaOperations(store, { cluster: manifest.cluster, genesisHash: manifest.genesisHash, maximumSponsorLamports: 10_000_000n });
    const signer = await generateKeyPairSigner();
    const identity = testIdentity('tenant', signer.address);
    const owner = paidOwner(identity, 'solana-devnet');
    const id = randomUUID(), key = `local-ai:request:${id}`;
    const [source] = await findAssociatedTokenPda({ owner: signer.address, mint: address(manifest.cashMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const sponsorCashMode = process.argv.includes('--sponsor-cash');
    let fundingSignature: string;
    if (sponsorCashMode) {
      const [sponsorCash] = await findAssociatedTokenPda({ owner: address(sponsor.address), mint: address(manifest.cashMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const fundingReview = { network: 'solana-devnet', amountAtomic: '12800', token: manifest.cashMint, source: sponsorCash, recipient: source, owner: signer.address, feePayer: sponsor.address, note: 'Explicit --sponsor-cash transfers exactly 0.0128 fictional tUSDC from the existing sponsor; no mint or fallback.' };
      console.log(JSON.stringify({ phase: 'exact-review-before-signature', action: 'fixture-sponsor-cash', review: fundingReview }));
      const funding = await operations.executeAsSponsor({ kind: 'ai-fixture-funding', requestId: id, sponsorshipSubject: identity.subject, review: fundingReview,
        instructions: [getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(address(sponsor.address)), ata: source, owner: signer.address, mint: address(manifest.cashMint), tokenProgram: TOKEN_PROGRAM_ADDRESS }),
          getTransferCheckedInstruction({ source: sponsorCash, destination: source, mint: address(manifest.cashMint), authority: createNoopSigner(address(sponsor.address)), amount: 12800n, decimals: 6 })],
        expectedDeltas: [{ account: source, mint: manifest.cashMint, owner: signer.address, direction: 'credit', minimumAtomic: '12800', maximumAtomic: '12800', allowCreated: true }] });
      let state = funding.state;
      for (let attempt = 0; state !== 'confirmed' && attempt < 120; attempt++) {
        if (state === 'failed' || state === 'expired') throw new Error(`Fixture funding ${state}; never replace pending signed bytes.`);
        await delay(2000);
        state = (await operations.reconcile({ id: funding.id })).state;
      }
      if (state !== 'confirmed') throw new Error(`Funding pending: ${funding.id}; do not replace signed bytes.`);
      fundingSignature = funding.signature;
    } else {
      const fundingEnvironment = { ...process.env, SOLANA_TEST_USDC_AMOUNT: '1' };
      const fundingContext = await testUsdcPayoutContext(signer.address, fundingEnvironment);
      if (!fundingContext || fundingContext.sponsor.address !== sponsor.address || fundingContext.ata !== source)
        throw new Error('Configure the existing site faucet authority and same sponsor; no funding fallback.');
      const fundingReview = { network: 'solana-devnet', amountAtomic: '1000000', token: manifest.cashMint, recipient: source, owner: signer.address, mintAuthority: fundingContext.authority.address, feePayer: sponsor.address, note: 'Mint exactly 1 fictional tUSDC through the existing site faucet; test tokens have no value.' };
      console.log(JSON.stringify({ phase: 'exact-review-before-signature', action: 'fixture-faucet', review: fundingReview }));
      let funding = await mintTestUsdc(store, identity.subject, signer.address, { environment: fundingEnvironment });
      for (let attempt = 0; funding.status === 'pending' && attempt < 120; attempt++) {
        await delay(2000);
        funding = await mintTestUsdc(store, identity.subject, signer.address, { environment: fundingEnvironment });
      }
      if (funding.status !== 'confirmed') throw new Error('Faucet not confirmed; do not replace its durable signed journal.');
      fundingSignature = funding.signature;
    }
    const review: SolanaInferenceReview = { walletId: owner.walletId, operationId: id, requestId: id, requestFingerprint: `fixture:${id}`,
      description: 'At most 0.0128 tUSDC; host-reported tokens capped by job limit and received text bytes. Explicit stub, no GPU claim.',
      expiresAt: new Date(Date.now() + 18 * 60_000).toISOString(), network: 'solana-devnet', asset: manifest.cashMint,
      payer: signer.address, source, delegate: sponsor.address, payTo: manifest.houses['neighbourhood-homes'].house,
      route: 'house', hostOwnerSubject: null, maxOutputTokens: 128, amountAtomic: '12800', priceAtomic: '100' };
    const request: LocalAiRequest = { id, mode: 'paid', state: 'payment_required', model: 'explicit-test-stub-not-a-model', prompt: 'Payment plumbing evidence only.',
      maxOutputTokens: 128, requestFingerprint: review.requestFingerprint, createdAt: new Date().toISOString(), expiresAt: review.expiresAt,
      answer: null, usage: null, error: null, payment: { state: 'quoted', amountAtomic: '12800', receipt: null }, review: null, paymentRequired: null, approval: null, solanaReview: review };
    await store.create(key, { id, mode: 'paid', owner, request, solanaJournal: { approvalId: null, settlementId: null } });
    let approval = await solanaAiApproval(store, key, identity, 'prepare');
    if (!approval.solanaRequest) throw new Error('Sponsored approval was not prepared.');
    console.log(JSON.stringify({ phase: 'exact-review-before-signature', action: 'ai-approval', review, allowanceNote: 'Unused allowance remains at most this maximum until replaced.' }));
    approval = await solanaAiApproval(store, key, identity, 'submit', await signPrepared(signer, approval.solanaRequest.transactionBase64));
    for (let attempt = 0; approval.state === 'pending' && attempt < 120; attempt++) { await delay(2000); approval = await solanaAiApproval(store, key, identity, 'reconcile'); }
    if (approval.state !== 'completed') throw new Error(`Approval ${approval.state}; never replace pending signed bytes.`);
    await store.update<{ request: LocalAiRequest }>(key, row => {
      row.request.answer = 'Explicit test stub: not generated by the GPU host. Payment plumbing only.';
      row.request.usage = { inputTokens: 0, outputTokens: 37, wallMs: 0, totalMs: 0, loadMs: 0, evalMs: 0, tokensPerSecond: null };
      row.request.payment.amountAtomic = '3700'; row.request.state = 'settling'; return row;
    });
    console.log(JSON.stringify({ phase: 'exact-review-before-signature', action: 'ai-settlement', review: { ...review, actualAmountAtomic: '3700', syntheticUsage: true } }));
    for (let attempt = 0; attempt < 120; attempt++) {
      try { await settleSolanaAi(store, key); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'Simulation bank changed; request a fresh review') throw error;
        console.log(JSON.stringify({ phase: 'fresh-exact-review-before-signature', action: 'ai-settlement', reason: error.message, review: { ...review, actualAmountAtomic: '3700', syntheticUsage: true } }));
        await delay(2000);
        continue;
      }
      const row = await store.get<{ request: LocalAiRequest }>(key);
      if (row?.request.state === 'completed') break;
      if (row?.request.state === 'failed') throw new Error(row.request.error ?? 'Settlement failed.');
      await delay(2000);
    }
    const saved = await store.get<{ request: LocalAiRequest }>(key);
    const signature = saved?.request.payment.receipt?.transaction;
    if (saved?.request.state !== 'completed' || !signature || !approval.hash) throw new Error('No completed real settlement receipt; no success evidence written.');
    const evidence = { evidenceKind: 'ephemeral-test-signer-devnet-stub-payment-only-not-privy-not-gpu', network: 'solana-devnet', requestId: id, payer: signer.address, feePayer: sponsor.address,
      house: review.payTo, programId: manifest.programId, mint: manifest.cashMint, maxAtomic: '12800', actualAtomic: '3700', outputTokens: 37, syntheticUsage: true, route: 'house', sourceKind: 1,
      fundingMode: sponsorCashMode ? 'explicit-sponsor-owned-cash' : 'existing-site-faucet',
      signatures: [fundingSignature, approval.hash, signature].map((transaction, index) => ({ action: ['fixture-funding', 'ai-approval', 'ai-settlement'][index], signature: transaction, explorerUrl: `https://explorer.solana.com/tx/${transaction}?cluster=devnet` })),
      state: saved.request.state, note: 'Real sponsored devnet transactions; synthetic answer, no GPU or Privy evidence. Test tokens have no value. Fictional units carry no rights; deposit earnings belong to the tenant.' };
    await writeFile('docs/evidence/SOLANA_AI_APP_PROOFS_2026-10-05.json', `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await store.close(); }
}
