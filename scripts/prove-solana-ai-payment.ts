import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { address } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { verifyPrivyToken } from '../src/server/identity.ts';
import { paidOwner } from '../src/server/local-ai.ts';
import { LocalStore } from '../src/server/store.ts';
import { loadSolanaHouseManifest } from '../src/server/solana-house-config.ts';
import { configuredFeeSponsor } from '../src/server/solana-service.ts';
import { solanaAiApproval, settleSolanaAi } from '../src/server/local-ai-payment.ts';
import type { LocalAiRequest, SolanaInferenceReview } from '../src/server/local-ai-types.ts';
import { proveSolanaAiFixture } from './prove-solana-ai-fixture.ts';

// Explicit fallback evidence only: never a production model answer. No key files are read.
// Run with Node --conditions=react-server --experimental-strip-types and the server's existing
// SOLANA_RPC_URL, SOLANA_SPONSOR_KEYPAIR, SOLANA_HOUSE_MANIFEST and PRIVY_* environment.
// --prepare emits an unsigned, reviewed approval. Sign it using the user's actual wallet.
// --settle --stub-answer uses SOLANA_AI_PROOF_REQUEST_ID and SOLANA_AI_PROOF_SIGNED_BASE64.
// Both phases require SOLANA_AI_PROOF_ACCESS_TOKEN; the token and signatures are never logged as credentials.
// --fixture --stub-answer opts into ephemeral in-memory signing with SOLANA_TEST_SIGNER_MODE=1.
const phase = process.argv[2];
if (phase === '--fixture') {
  await proveSolanaAiFixture();
  process.exit(0);
}
if (phase !== '--prepare' && !(phase === '--settle' && process.argv.includes('--stub-answer')))
  throw new Error('Use --prepare or explicitly --settle --stub-answer. This script does not run a model.');
const manifest = loadSolanaHouseManifest();
if (!manifest || manifest.cluster !== 'devnet') throw new Error('This proof is devnet-only and requires the deployed house manifest.');
const identity = await verifyPrivyToken(process.env.SOLANA_AI_PROOF_ACCESS_TOKEN ?? '');
const owner = paidOwner(identity, 'solana-devnet');
const sponsor = await configuredFeeSponsor();
if (!sponsor) throw new Error('Use the existing site sponsor, not a second fee payer.');
const store = new LocalStore(process.env.SOLANA_AI_PROOF_STORE ?? join(homedir(), '.cache', 'ledger-lean', 'solana-ai-payment-proof.sqlite'));
try {
  if (phase === '--prepare') {
    const id = randomUUID();
    const [source] = await findAssociatedTokenPda({ owner: address(owner.payer), mint: address(manifest.cashMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const review: SolanaInferenceReview = { walletId: owner.walletId, operationId: id, requestId: id,
      requestFingerprint: `stub-proof:${id}`, description: 'Explicit stub-answer proof: approve at most 0.0128 tUSDC; 0.0001 per measured test output token.',
      expiresAt: new Date(Date.now() + 18 * 60_000).toISOString(), network: 'solana-devnet', asset: manifest.cashMint,
      payer: owner.payer, source, delegate: sponsor.address, payTo: manifest.houses['neighbourhood-homes'].house,
      route: 'house', hostOwnerSubject: null, maxOutputTokens: 128, amountAtomic: '12800', priceAtomic: '100' };
    const request: LocalAiRequest = { id, mode: 'paid', state: 'payment_required', model: 'explicit-test-stub-not-a-model', prompt: 'Payment plumbing evidence only.',
      maxOutputTokens: 128, requestFingerprint: review.requestFingerprint, createdAt: new Date().toISOString(), expiresAt: review.expiresAt,
      answer: null, usage: null, error: null, payment: { state: 'quoted', amountAtomic: '12800', receipt: null }, review: null,
      paymentRequired: null, approval: null, solanaReview: review };
    await store.create(`local-ai:request:${id}`, { id, mode: 'paid', owner, request, solanaJournal: { approvalId: null, settlementId: null } });
    const approval = await solanaAiApproval(store, `local-ai:request:${id}`, identity, 'prepare');
    console.log(JSON.stringify({ evidenceKind: 'explicit-stub-payment-only', request, approval,
      note: 'The site sponsor is delegate and fee payer. Unused allowance remains at most 0.0128 tUSDC until the next approval replaces it. Testnet tokens have no value.' }, null, 2));
  } else {
    const id = process.env.SOLANA_AI_PROOF_REQUEST_ID;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Supply the prepared proof request ID.');
    const key = `local-ai:request:${id}`;
    let approval = await solanaAiApproval(store, key, identity, 'submit', process.env.SOLANA_AI_PROOF_SIGNED_BASE64);
    for (let attempt = 0; approval.state === 'pending' && attempt < 60; attempt++) {
      await delay(2000);
      approval = await solanaAiApproval(store, key, identity, 'reconcile');
    }
    if (approval.state !== 'completed') throw new Error(`Approval is ${approval.state}; rerun with the same request and bytes, never replace a pending signature.`);
    await store.update<{ request: LocalAiRequest }>(key, row => {
      if (row.request.state === 'ready') {
        row.request.answer = 'Explicit test stub: not generated by the GPU host. Payment plumbing only.';
        row.request.usage = { inputTokens: 0, outputTokens: 37, wallMs: 0, totalMs: 0, loadMs: 0, evalMs: 0, tokensPerSecond: null };
        row.request.payment.amountAtomic = '3700'; row.request.state = 'settling';
      }
      return row;
    });
    for (let attempt = 0; attempt < 60; attempt++) {
      await settleSolanaAi(store, key);
      const row = await store.get<{ request: LocalAiRequest }>(key);
      if (row?.request.state === 'completed' || row?.request.state === 'failed') break;
      await delay(2000);
    }
    const row = await store.get<{ request: LocalAiRequest }>(key);
    const signature = row?.request.payment.receipt?.transaction;
    console.log(JSON.stringify({ evidenceKind: 'explicit-stub-payment-only', requestId: id, approvalSignature: approval.hash,
      settlementSignature: signature, state: row?.request.state, maxAtomic: '12800', actualAtomic: row?.request.payment.amountAtomic,
      outputTokens: 37, syntheticUsage: true, route: 'house', sourceKind: 1,
      receipt: signature ? `https://explorer.solana.com/tx/${signature}?cluster=devnet` : null,
      note: 'No GPU inference is claimed. Both transactions use the existing site sponsor. Testnet tokens have no value.' }, null, 2));
    if (row?.request.state !== 'completed') process.exitCode = 1;
  }
} finally { await store.close(); }
