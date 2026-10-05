import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { address, createNoopSigner, generateKeyPairSigner } from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { faucetInstruction, SHARES_PRICE_AUTHORITY } from '../finance/solana/shares.ts';
import type { ShareDepositAction } from '../domain/share-deposit.ts';
import { acceptAgreement, agreementDigest, inviteToAgreement, joinAgreement, type Agreement } from './agreements.ts';
import { applyToListing, chooseApplicant, createListing } from './listings.ts';
import { tenancyJourney } from './journey.ts';
import { LocalStore } from './store.ts';
import { solanaSharesConfiguration } from './solana-shares-config.ts';
import { configuredSolanaOperations } from './solana-operations.ts';
import { assertTestAgreement, assertTestSignerAllowed, signPrepared, testIdentity } from './test-signer.ts';
import { prepareSolanaShareDeposit, readSolanaShareDeposit, submitSolanaShareDeposit } from './share-deposit-solana.ts';

/** Explicit operator fixture proof, not Privy evidence. It generates three ephemeral keys in
 * memory, never reads key files, and uses the configured site sponsor for every transaction.
 * Run only after the shares deployment with SOLANA_SHARE_DEPOSIT_DEVNET_PROOF=1,
 * SOLANA_TEST_SIGNER_MODE=1, SOLANA_SHARES_MANIFEST, SOLANA_RPC_URL and existing sponsor env.
 * The live faucet costs five fictional shares from the shared devnet daily budget. */
test('devnet: three fixture accounts create, pledge, activate, claim, accept and pay out in kind', { skip: process.env.SOLANA_SHARE_DEPOSIT_DEVNET_PROOF !== '1', timeout: 600_000 }, async () => {
  const config = await solanaSharesConfiguration();
  assert.ok(config, 'The actual deployed shares manifest is required.');
  assertTestSignerAllowed(process.env, config);
  assert.equal(config.cluster, 'devnet');
  const store = new LocalStore(':memory:');
  const { operations, sponsor } = await configuredSolanaOperations(store, { cluster: config.cluster, genesisHash: config.genesisHash, maximumSponsorLamports: 10_000_000n });
  assert.equal(sponsor.address, SHARES_PRICE_AUTHORITY, 'Local sponsor differs from hosted issuer: defer to hosted release; never swap keys.');
  const people = { tenant: await generateKeyPairSigner(), landlord: await generateKeyPairSigner(), arbitrator: await generateKeyPairSigner() };
  const identities = { tenant: testIdentity('tenant', people.tenant.address), landlord: testIdentity('landlord', people.landlord.address), arbitrator: testIdentity('arbitrator', people.arbitrator.address) };
  const signatures: { action: string; signature: string; explorerUrl: string }[] = [];
  try {
    const listing = await createListing(store, identities.landlord, { title: 'Solana share deposit devnet fixture', city: 'Berlin', rentMonthly: '1000000', requiredSecurity: '1000000', releaseAllowed: false, depositForm: 'shares-solana' });
    await applyToListing(store, identities.tenant, listing.id, { name: 'Ephemeral test tenant', message: 'Explicit devnet evidence fixture, no monetary value.' });
    const selected = (await store.get<typeof listing>(`listing:${listing.id}`))!;
    const applicant = selected.applications?.[0];
    assert.ok(applicant, 'The fixture tenant application must be recorded before selection.');
    await chooseApplicant(store, identities.landlord, listing.id, applicant.id);
    const agreementId = `listing-${listing.id}`;
    const invitation = await inviteToAgreement(store, agreementId, identities.landlord, 'arbitrator');
    await joinAgreement(store, agreementId, identities.arbitrator, 'arbitrator', invitation.token);
    const agreement = (await store.get<Agreement>(`agreement:${agreementId}`))!;
    assertTestAgreement(agreement);
    await acceptAgreement(store, agreementId, identities.tenant, agreementDigest(agreement)!);
    await acceptAgreement(store, agreementId, identities.landlord, agreementDigest(agreement)!);
    const dependencies = { operations, sponsor: sponsor.address };
    const finalize = async (id: string) => {
      for (let attempt = 0; attempt < 120; attempt++) { const result = await operations.reconcile({ id }); if (result.state === 'confirmed') return result; if (result.state === 'failed' || result.state === 'expired') throw new Error(`Devnet fixture transaction ${id}: ${result.state}`); await delay(2000); }
      throw new Error(`Devnet fixture still pending: ${id}; do not replace its immutable signed bytes.`);
    };
    const [destination] = await findAssociatedTokenPda({ owner: people.tenant.address, mint: address(config.shareMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const faucet = await operations.prepare({ identity: identities.tenant, actor: people.tenant.address, walletId: identities.tenant.wallets[0].id, kind: 'share-deposit-fixture-faucet', requestId: randomUUID(), instructions: [getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(address(sponsor.address)), owner: people.tenant.address, mint: address(config.shareMint), ata: destination, tokenProgram: TOKEN_PROGRAM_ADDRESS }), await faucetInstruction({ payer: sponsor.address, issuer: sponsor.address, owner: people.tenant.address, destination })], review: { network: 'solana-devnet', amount: '5 tTSLA', actor: people.tenant.address, destination, note: 'Explicit ephemeral fixture; uses real faucet and daily budget, not Privy or monetary evidence.' } });
    console.log(JSON.stringify({ phase: 'exact-review-before-signature', action: 'fixture-faucet', feePayer: sponsor.address, review: faucet.review }));
    const faucetSubmitted = await operations.submit({ identity: identities.tenant, id: faucet.id, signedTransactionBase64: await signPrepared(people.tenant, faucet.transactionBase64) });
    await finalize(faucet.id);
    signatures.push({ action: 'fixture-faucet', signature: faucetSubmitted.signature, explorerUrl: `https://explorer.solana.com/tx/${faucetSubmitted.signature}?cluster=devnet` });
    const act = async (role: keyof typeof identities, action: ShareDepositAction, input: Record<string, unknown> = {}) => {
      const plan = await prepareSolanaShareDeposit(store, identities[role], agreementId, action, { ...input, requestId: randomUUID() }, dependencies);
      console.log(JSON.stringify({ phase: 'exact-review-before-signature', action, feePayer: sponsor.address, review: plan.review }));
      const submitted = await submitSolanaShareDeposit(store, identities[role], plan.id, await signPrepared(people[role], plan.transactionBase64), dependencies);
      assert.ok(submitted.transactionHash);
      await finalize(plan.id);
      const confirmed = await submitSolanaShareDeposit(store, identities[role], plan.id, undefined, dependencies);
      assert.equal(confirmed.status, 'confirmed');
      signatures.push({ action, signature: confirmed.transactionHash!, explorerUrl: confirmed.explorerUrl! });
      return confirmed.view;
    };
    await act('landlord', 'create');
    let view = await readSolanaShareDeposit(store, identities.tenant, agreementId, dependencies);
    assert.equal(view.state, 'AwaitingLock'); assert.ok(view.requiredShares);
    await act('tenant', 'pledge', { shares: view.requiredShares });
    view = await readSolanaShareDeposit(store, identities.tenant, agreementId, dependencies);
    if (view.state === 'AwaitingLock') await act('tenant', 'activate');
    assert.equal((await tenancyJourney(store, identities.tenant, (await store.get<Agreement>(`agreement:${agreementId}`))!)).stage, 'living');
    await act('landlord', 'proposeClaim', { usd6: '250000', evidence: 'Explicit fixture move-out damage claim of 0.25 test USD.' });
    view = await readSolanaShareDeposit(store, identities.tenant, agreementId, dependencies);
    assert.equal(view.state, 'ClaimPending');
    await act('tenant', 'acceptClaim', { maxShares: view.claim!.shares });
    await act('tenant', 'payout', { side: 'landlord' });
    await act('tenant', 'payout', { side: 'tenant' });
    const complete = await readSolanaShareDeposit(store, identities.tenant, agreementId, dependencies);
    assert.equal(complete.paidOut, true); assert.equal(complete.lockedShares, '0'); assert.equal(complete.landlordOwed, '0');
    console.log(JSON.stringify({ evidenceKind: 'ephemeral-test-signer-devnet-not-privy', network: 'solana-devnet', agreementId, agreementDigest: agreementDigest(agreement), escrow: complete.escrow, programId: config.programId, mint: config.shareMint, parties: Object.fromEntries(Object.entries(people).map(([role, signer]) => [role, signer.address])), signatures, state: 'Closed', paidOut: true, note: 'Actual sponsored devnet signatures. Fictional shares have no value; locally generated fixture signers, not Privy evidence.' }, null, 2));
  } finally { await store.close(); }
});
