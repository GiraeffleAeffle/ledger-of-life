import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRole, generateKeyPairSigner, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, type Instruction } from '@solana/kit';
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_IDS } from '../finance/solana/manifest.ts';
import type { SignatureReconciliation } from '../finance/solana/reconcile.ts';
import { LocalStore } from './store.ts';
import { createSolanaOperations, DEFAULT_SPONSORSHIP_LIMITS, sponsorshipLimitsFromEnvironment, type SolanaOperationsConfig, type SolanaOperationsGateway, type SponsorshipLimits } from './solana-operations.ts';
type LedgerView = { reservations: Record<string, { amountLamports: string; subject: string | null; state: 'reserved' | 'charged'; reservedAt: number; chargedAt?: number; ownerToken: string }> };

async function fixture(sponsorshipLimits: Partial<SponsorshipLimits> = {}) {
  const [actor, payer, stranger] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const store = new LocalStore(':memory:');
  const identity: VerifiedIdentity = { subject: 'did:privy:operation', sessionId: 'session', expiresAt: 9999999999, passkeyCount: 1, wallets: [{ id: 'sol-wallet', chainType: 'solana', address: actor.address }] };
  let height = 10n, confirmedHeight = 10n, lastValidBlockHeight = 100n, clock = 1000, simulationDebit = 20_000n;
  let sponsorCalls = 0, broadcastError = false;
  let observation: SignatureReconciliation = { status: 'unknown', reason: 'signature-not-observed-do-not-resubmit-new-intent' };
  let nextObservation: SignatureReconciliation | null = null;
  const broadcasts: Uint8Array[] = [], simulations: Uint8Array[] = [];
  const gateway: SolanaOperationsGateway = {
    lifetime: async () => ({ blockhash: SOLANA_IDS.system, lastValidBlockHeight: lastValidBlockHeight.toString(), blockHeight: height.toString() }),
    blockHeight: async commitment => (commitment === 'confirmed' ? confirmedHeight : height).toString(),
    simulate: async bytes => { simulations.push(bytes); return { slot: '10', sponsorDebitCeilingLamports: simulationDebit.toString(), networkFeeLamports: '10000' }; },
    broadcast: async bytes => { broadcasts.push(bytes); if (broadcastError) throw new Error('Ambiguous broadcast timeout'); return getBase58Decoder().decode(getTransactionDecoder().decode(bytes).signatures[payer.address]!); },
    reconcile: async () => { const current = observation; if (nextObservation) { observation = nextObservation; nextObservation = null; } return current; },
  };
  const sponsor = { address: payer.address, sign: async (bytes: Uint8Array) => { sponsorCalls++; return new Uint8Array(getTransactionEncoder().encode(await partiallySignTransaction([payer.keyPair], getTransactionDecoder().decode(bytes)))); } };
  const config: SolanaOperationsConfig = { cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, maximumSponsorLamports: 10_000_000n, sponsorshipLimits };
  const operations = createSolanaOperations({ store, gateway, sponsor, config, now: () => clock });
  const instructions: Instruction[] = [{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [{ address: actor.address, role: AccountRole.READONLY_SIGNER }], data: new TextEncoder().encode('exact house review') }];
  const input = { identity, actor: actor.address, walletId: 'sol-wallet', kind: 'house:buy', requestId: 'request-one', instructions, review: { unitsRaw: '5000000', cashRaw: '5000000' } };
  const sign = async (transactionBase64: string, signer = actor) => Buffer.from(getTransactionEncoder().encode(await partiallySignTransaction([signer.keyPair], getTransactionDecoder().decode(Buffer.from(transactionBase64, 'base64'))))).toString('base64');
  return {
    operations, store, identity, actor, payer, sponsor, stranger, input, sign, broadcasts, simulations, gateway, config,
    createAgain: () => createSolanaOperations({ store, gateway, sponsor, config, now: () => clock }),
    signerCalls: () => sponsorCalls,
    readLedger: async () => { const rows = await store.scan<LedgerView>('solana-sponsorship:'); return rows[0]?.value.reservations ?? {}; },
    complete: async (id: string) => {
      const op = await operations.get(id);
      if (!op.signature) throw new Error('Signed operation required');
      observation = { status: 'finalized', signature: op.signature, slot: '20', deltas: [] }; nextObservation = null;
      const result = await operations.reconcile({ id });
      observation = { status: 'unknown', reason: 'signature-not-observed-do-not-resubmit-new-intent' };
      return result;
    },
    setBroadcastError: (value: boolean) => { broadcastError = value; },
    setLastValidHeight: (value: bigint) => { lastValidBlockHeight = value; },
    setHeight: (value: bigint) => { height = value; confirmedHeight = value; }, setConfirmedHeight: (value: bigint) => { confirmedHeight = value; },
    setClock: (value: number) => { clock = value; }, setDebit: (value: bigint) => { simulationDebit = value; },
    setObservation: (value: SignatureReconciliation, next: SignatureReconciliation | null = null) => { observation = value; nextObservation = next; },
  };
}

test('prepare pins sponsor as first account, wallet signer and one idempotent exact review', async () => {
  const f = await fixture();
  const first = await f.operations.prepare(f.input), second = await f.operations.prepare(f.input);
  assert.deepEqual(first, second);
  assert.equal(f.simulations.length, 1);
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(first.transactionBase64, 'base64')).messageBytes);
  assert.equal(message.staticAccounts[0], f.payer.address);
  assert.equal(message.header.numSignerAccounts, 2);
  await assert.rejects(f.operations.prepare({ ...f.input, review: { unitsRaw: '6000000' } }), /different action/);
  await f.store.close();
});

test('submit refuses any message change and requires the reviewed actor signature', async () => {
  const f = await fixture(), prepared = await f.operations.prepare(f.input);
  await assert.rejects(f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: prepared.transactionBase64 }), /wallet signature is invalid/);
  const tx = getTransactionDecoder().decode(Buffer.from(prepared.transactionBase64, 'base64'));
  const changedBytes = Buffer.from(prepared.transactionBase64, 'base64'); changedBytes[changedBytes.length - 1] ^= 1;
  const changed = changedBytes.toString('base64');
  await assert.rejects(f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: changed }), /differ from the exact review/);
  const unsigned = new Uint8Array(getTransactionEncoder().encode(tx));
  const actorSignature = getTransactionDecoder().decode(Buffer.from(await f.sign(prepared.transactionBase64), 'base64')).signatures[f.actor.address]!;
  const invalid = new Uint8Array(actorSignature); invalid[0] ^= 1;
  const invalidBytes = Buffer.from(getTransactionEncoder().encode({ ...getTransactionDecoder().decode(unsigned), signatures: { ...tx.signatures, [f.actor.address]: invalid as typeof actorSignature } })).toString('base64');
  await assert.rejects(f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: invalidBytes }), /wallet signature is invalid/);
  assert.equal(f.broadcasts.length, 0);
  await f.store.close();
});

test('submit refuses a sponsor signature supplied by the client', async () => {
  const f = await fixture(), prepared = await f.operations.prepare(f.input);
  const signed = await f.sign(await f.sign(prepared.transactionBase64), f.payer);
  await assert.rejects(f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: signed }), /sponsor signature/);
  await f.store.close();
});

test('submit persists exact signed bytes and only rebroadcasts those bytes while valid', async () => {
  const f = await fixture(), prepared = await f.operations.prepare(f.input);
  const submitted = await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  assert.equal(submitted.state, 'broadcast');
  assert.ok(submitted.signature);
  await f.operations.reconcile({ identity: f.identity, id: prepared.id });
  assert.ok(f.broadcasts.length >= 2);
  assert.ok(f.broadcasts.every(bytes => Buffer.from(bytes).equals(Buffer.from(f.broadcasts[0]))));
  f.setObservation({ status: 'finalized', signature: submitted.signature, slot: '20', deltas: [] });
  assert.equal((await f.operations.reconcile({ identity: f.identity, id: prepared.id })).state, 'confirmed');
  await f.store.close();
});

test('expiry requires finalized height beyond lifetime and a fresh missing-signature lookup', async () => {
  const f = await fixture(), prepared = await f.operations.prepare(f.input);
  const submitted = await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  f.setHeight(100n);
  assert.equal((await f.operations.reconcile({ id: prepared.id })).state, 'broadcast');
  f.setHeight(101n);
  f.setObservation({ status: 'unknown', reason: 'signature-not-observed-do-not-resubmit-new-intent' }, { status: 'pending', reason: 'awaiting-finality' });
  assert.equal((await f.operations.reconcile({ id: prepared.id })).state, 'broadcast');
  f.setObservation({ status: 'unknown', reason: 'receipt-unavailable' });
  assert.equal((await f.operations.reconcile({ id: prepared.id })).state, 'broadcast');
  f.setObservation({ status: 'unknown', reason: 'signature-not-observed-do-not-resubmit-new-intent' });
  const expired = await f.operations.reconcile({ id: prepared.id });
  assert.equal(expired.state, 'expired'); assert.equal(expired.signature, submitted.signature);
  await f.store.close();
});

test('unsigned canonical expiry uses the original confirmed block-height bound and never refreshes its envelope', async () => {
  const f = await fixture(), prepared = await f.operations.prepare(f.input);
  f.setLastValidHeight(200n);
  f.setConfirmedHeight(101n);
  assert.equal((await f.operations.reconcile({ identity: f.identity, id: prepared.id })).state, 'expired');
  const same = await f.operations.prepare(f.input);
  assert.equal(same.id, prepared.id);
  assert.equal(same.transactionBase64, prepared.transactionBase64);
  assert.equal((await f.operations.get(prepared.id)).state, 'expired');
  assert.equal(f.signerCalls(), 0);
  assert.equal(f.broadcasts.length, 0);
  assert.deepEqual(await f.readLedger(), {});
  await f.store.close();
});

test('house lifetime metadata uses the original inclusive last-valid height and the actual confirmed tip', async () => {
  const f = await fixture(), prepared = await f.operations.prepare(f.input);
  assert.equal(prepared.lastValidBlockHeight, '100');
  f.setLastValidHeight(200n);
  f.setConfirmedHeight(100n);
  const valid = await f.operations.reconcile({ id: prepared.id });
  assert.equal(valid.state, 'prepared');
  assert.equal(valid.blockHeight, '100');
  assert.equal(valid.blockhashValid, true, 'the original last-valid block remains valid');
  f.setConfirmedHeight(101n);
  const expired = await f.operations.reconcile({ id: prepared.id });
  assert.equal(expired.state, 'expired');
  assert.equal(expired.blockHeight, '101');
  assert.equal(expired.blockhashValid, false);
  assert.equal((await f.operations.get(prepared.id)).lastValidBlockHeight, '100');
  assert.equal((await f.operations.get(prepared.id)).transactionBase64, prepared.transactionBase64);
  assert.equal(f.signerCalls(), 0);
  await f.store.close();
});

test('house review-policy expiry is separate from observed blockhash validity and remains terminal', async () => {
  const f = await fixture(), prepared = await f.operations.prepare(f.input);
  f.setClock(121_001);
  const policyExpired = await f.operations.reconcile({ id: prepared.id });
  assert.equal(policyExpired.state, 'expired');
  assert.equal(policyExpired.blockHeight, '10');
  assert.equal(policyExpired.blockhashValid, true, 'a closed review does not imply an expired blockhash');
  f.setConfirmedHeight(101n);
  const observedAgain = await f.operations.reconcile({ id: prepared.id });
  assert.equal(observedAgain.state, 'expired');
  assert.equal(observedAgain.blockHeight, '101');
  assert.equal(observedAgain.blockhashValid, false);
  assert.equal((await f.operations.prepare(f.input)).transactionBase64, prepared.transactionBase64);
  assert.equal(f.signerCalls(), 0);
  assert.equal(f.broadcasts.length, 0);
  await f.store.close();
});

test('confirmed tip expiry cannot release signed ambiguity before the finalized absence proof', async () => {
  const f = await fixture({ globalDailyLamports: 20_000n }), prepared = await f.operations.prepare(f.input);
  const submitted = await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  f.setConfirmedHeight(101n);
  const stillAmbiguous = await f.createAgain().reconcile({ id: prepared.id });
  assert.equal(stillAmbiguous.state, 'broadcast');
  assert.equal(stillAmbiguous.signature, submitted.signature);
  assert.equal(stillAmbiguous.blockHeight, undefined);
  assert.equal(stillAmbiguous.blockhashValid, undefined);
  assert.equal((await f.readLedger())[prepared.id].state, 'reserved');
  assert.equal(f.signerCalls(), 1);
  f.setHeight(101n);
  const provenAbsent = await f.operations.reconcile({ id: prepared.id });
  assert.equal(provenAbsent.state, 'expired');
  assert.deepEqual(await f.readLedger(), {});
  assert.equal(f.signerCalls(), 1);
  await f.store.close();
});

test('confirmed-height expiry atomically fences an in-flight unsigned signer and releases only its unsent reservation', async () => {
  const f = await fixture({ globalDailyLamports: 20_000n }), prepared = await f.operations.prepare(f.input);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), originalSign = f.sponsor.sign;
  f.sponsor.sign = async bytes => { started.resolve(); await release.promise; return originalSign(bytes); };
  const submission = f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  await started.promise;
  assert.equal((await f.readLedger())[prepared.id].state, 'reserved');
  f.setConfirmedHeight(101n);
  assert.equal((await f.operations.reconcile({ id: prepared.id })).state, 'expired');
  assert.deepEqual(await f.readLedger(), {});
  release.resolve();
  await assert.rejects(submission, /Sponsorship reservation changed/);
  assert.equal(f.broadcasts.length, 0);
  assert.equal((await f.operations.get(prepared.id)).signature, undefined);
  await f.store.close();
});

test('submission expiry is durably terminal before returning a fresh-review error', async t => {
  for (const bound of ['clock', 'confirmed height']) await t.test(bound, async () => {
    const f = await fixture(), prepared = await f.operations.prepare(f.input), signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    if (bound === 'clock') f.setClock(121_001);
    else { f.setLastValidHeight(200n); f.setConfirmedHeight(101n); }
    await assert.rejects(f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 }), /review expired/);
    assert.equal((await f.operations.get(prepared.id)).state, 'expired');
    assert.equal((await f.operations.get(prepared.id)).signature, undefined);
    assert.equal(f.signerCalls(), 0);
    assert.equal(f.broadcasts.length, 0);
    await f.store.close();
  });
});

test('sponsor-only execution terminalizes its expired original envelope without preparing a replacement', async () => {
  const f = await fixture();
  const input = { kind: 'ai-settle', requestId: 'sponsor-expired', sponsorshipSubject: f.identity.subject,
    instructions: [{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [], data: new TextEncoder().encode('bounded answer') }],
    review: { amount: '3700' } };
  const prepared = await f.operations.prepareAsSponsor(input);
  f.setLastValidHeight(200n); f.setHeight(100n);
  await assert.rejects(f.operations.executeAsSponsor(input), /Server operation lifetime expired/);
  assert.equal((await f.operations.get(prepared.id)).state, 'expired');
  assert.equal((await f.operations.get(prepared.id)).transactionBase64, prepared.transactionBase64);
  assert.equal((await f.store.scan('solana-operation:')).length, 1);
  assert.equal(f.signerCalls(), 0);
  assert.equal(f.broadcasts.length, 0);
  await f.store.close();
});

test('simulation ceiling and identity binding prevent unauthorized sponsorship', async () => {
  const f = await fixture(); f.setDebit(10_000_001n);
  await assert.rejects(f.operations.prepare(f.input), /ceiling exceeded/);
  f.setDebit(10_000n);
  const prepared = await f.operations.prepare(f.input);
  await assert.rejects(f.operations.submit({ identity: { ...f.identity, subject: 'another-person' }, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) }), /not available/);
  f.setClock(122000);
  assert.equal((await f.operations.reconcile({ id: prepared.id })).state, 'expired');
  await f.store.close();
});

test('server-only execute signs with sponsor and remains idempotent', async () => {
  const f = await fixture();
  const input = { kind: 'ai:settle', requestId: 'paid-answer-one', instructions: [{ programAddress: MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode('server settlement') }], review: { amountRaw: '200' } };
  const first = await f.operations.executeAsSponsor(input), second = await f.operations.executeAsSponsor(input);
  assert.equal(first.signature, second.signature); assert.equal(first.id, second.id);
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(f.broadcasts[0]).messageBytes);
  assert.equal(message.header.numSignerAccounts, 1);
  await f.store.close();
});

test('receipt anomalies retain the signed reservation; only proven chain errors fail', async () => {
  const f = await fixture(), prepared = await f.operations.prepare(f.input);
  await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  f.setObservation({ status: 'failed', reason: 'receipt-does-not-match-authorized-message' });
  const anomaly = await f.operations.reconcile({ identity: f.identity, id: prepared.id });
  assert.equal(anomaly.state, 'broadcast'); assert.equal(anomaly.error, 'receipt-does-not-match-authorized-message');
  f.setObservation({ status: 'failed', reason: 'transaction-error' });
  assert.equal((await f.operations.reconcile({ identity: f.identity, id: prepared.id })).state, 'failed');
  await f.store.close();
});

test('cancelling an unsigned review wins atomically against in-flight sponsorship, never broadcasting it', async () => {
  const f = await fixture(), prepared = await f.operations.prepare(f.input);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), originalSign = f.sponsor.sign;
  f.sponsor.sign = async bytes => { started.resolve(); await release.promise; return originalSign(bytes); };
  const submission = f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  await started.promise;
  assert.equal((await f.operations.cancel({ identity: f.identity, id: prepared.id })).state, 'expired');
  release.resolve();
  await assert.rejects(submission, /Sponsorship reservation changed/);
  assert.equal(f.broadcasts.length, 0);
  await f.store.close();
});

test('already signed transactions cannot be cancelled', async () => {
  const f = await fixture(), prepared = await f.operations.prepare(f.input);
  await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  await assert.rejects(f.operations.cancel({ identity: f.identity, id: prepared.id }), /signed transaction cannot be cancelled/);
  await f.store.close();
});

test('sponsorship limits default to 0.05 SOL/60 rolling transactions and 1.5 SOL per UTC day; env can pause or override them', () => {
  assert.deepEqual(sponsorshipLimitsFromEnvironment({}), DEFAULT_SPONSORSHIP_LIMITS);
  assert.deepEqual(sponsorshipLimitsFromEnvironment({ SOLANA_SPONSOR_SUBJECT_ROLLING_LAMPORTS: '12345', SOLANA_SPONSOR_SUBJECT_ROLLING_TRANSACTIONS: '4', SOLANA_SPONSOR_GLOBAL_DAILY_LAMPORTS: '0' }), { subjectRollingLamports: 12345n, subjectRollingTransactions: 4, globalDailyLamports: 0n });
  for (const value of ['-1', '1.5', 'NaN', '18446744073709551616']) assert.throws(() => sponsorshipLimitsFromEnvironment({ SOLANA_SPONSOR_GLOBAL_DAILY_LAMPORTS: value }), /Invalid/);
  assert.throws(() => sponsorshipLimitsFromEnvironment({ SOLANA_SPONSOR_SUBJECT_ROLLING_TRANSACTIONS: '1.5' }), /Invalid/);
});

test('stake/unstake cycling with fresh request IDs stops at the default 60-transaction rolling allowance before signing', async () => {
  const f = await fixture();
  for (let i = 0; i < 60; i++) {
    const operation = i % 2 === 0 ? 'stake' : 'unstake';
    const prepared = await f.operations.prepare({ ...f.input, kind: `house:neighbourhood-homes:${operation}`, requestId: `cycle-${i}`, instructions: [{ ...f.input.instructions[0], data: new TextEncoder().encode(`cycle ${operation} ${i}`) }] });
    await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
    assert.equal((await f.complete(prepared.id)).state, 'confirmed');
  }
  const restarted = f.createAgain();
  const next = await restarted.prepare({ ...f.input, requestId: 'cycle-60' });
  await assert.rejects(restarted.submit({ identity: f.identity, id: next.id, signedTransactionBase64: await f.sign(next.transactionBase64) }), { code: 'sponsor_subject_budget', status: 429, message: /used today's free network fees/ });
  assert.equal(f.signerCalls(), 60);
  const entries = Object.values(await f.readLedger()); assert.equal(entries.length, 60); assert.ok(entries.every(entry => entry.state === 'charged'));
  await f.store.close();
});

test('the default 0.05 SOL subject allowance stops a high-rent cycle even before its transaction-count limit', async () => {
  const f = await fixture(); f.setDebit(10_000_000n);
  for (let i = 0; i < 5; i++) {
    const prepared = await f.operations.prepare({ ...f.input, requestId: `rent-ceiling-${i}`, instructions: [{ ...f.input.instructions[0], data: new TextEncoder().encode(`rent ceiling ${i}`) }] });
    await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) }); await f.complete(prepared.id);
  }
  const next = await f.operations.prepare({ ...f.input, requestId: 'rent-ceiling-5' });
  await assert.rejects(f.operations.submit({ identity: f.identity, id: next.id, signedTransactionBase64: await f.sign(next.transactionBase64) }), /used today's free network fees/);
  assert.equal(f.signerCalls(), 5); assert.equal(Object.values(await f.readLedger()).reduce((sum, entry) => sum + BigInt(entry.amountLamports), 0n), 50_000_000n);
  await f.store.close();
});

test('global UTC-day budget is shared by different subjects and server-only price operations', async () => {
  const f = await fixture({ globalDailyLamports: 40_000n });
  for (let i = 0; i < 2; i++) {
    const identity = { ...f.identity, subject: `did:privy:global-${i}` };
    const prepared = await f.operations.prepare({ ...f.input, identity, requestId: `global-${i}`, instructions: [{ ...f.input.instructions[0], data: new TextEncoder().encode(`global ${i}`) }] });
    await f.operations.submit({ identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) }); await f.complete(prepared.id);
  }
  const identity = { ...f.identity, subject: 'did:privy:global-third' }, prepared = await f.operations.prepare({ ...f.input, identity, requestId: 'global-third' });
  await assert.rejects(f.operations.submit({ identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) }), { code: 'sponsor_global_budget', status: 429, message: /site's daily network-fee budget/ });
  await assert.rejects(f.operations.executeAsSponsor({ kind: 'shares:price', requestId: 'global-price', instructions: [{ programAddress: MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode('price') }], review: {} }), /site's daily network-fee budget/);
  assert.equal(f.signerCalls(), 2);
  await f.store.close();
});

test('ambiguous broadcast retains one durable reservation across service restarts and UTC midnight', async () => {
  const f = await fixture({ globalDailyLamports: 20_000n, subjectRollingLamports: 100_000n }); f.setBroadcastError(true);
  const prepared = await f.operations.prepare(f.input), signedTransactionBase64 = await f.sign(prepared.transactionBase64);
  const submitted = await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 });
  assert.equal(submitted.state, 'broadcast'); assert.equal((await f.readLedger())[prepared.id].state, 'reserved');
  const restarted = f.createAgain();
  await restarted.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 });
  assert.equal(f.signerCalls(), 1); assert.equal(Object.keys(await f.readLedger()).length, 1);
  f.setClock(86_401_000);
  const next = await restarted.prepare({ ...f.input, requestId: 'next-utc-day' });
  await assert.rejects(restarted.submit({ identity: f.identity, id: next.id, signedTransactionBase64: await f.sign(next.transactionBase64) }), /site's daily network-fee budget/);
  assert.equal((await f.readLedger())[prepared.id].state, 'reserved'); assert.equal(f.signerCalls(), 1);
  await f.store.close();
});

test('a proven unsigned cancellation releases its in-flight reservation; the cancelled signer can never broadcast', async () => {
  const f = await fixture({ subjectRollingLamports: 20_000n, subjectRollingTransactions: 1 }), prepared = await f.operations.prepare(f.input);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), originalSign = f.sponsor.sign;
  f.sponsor.sign = async bytes => { started.resolve(); await release.promise; return originalSign(bytes); };
  const pending = f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  await started.promise;
  assert.equal((await f.readLedger())[prepared.id].state, 'reserved');
  const next = await f.operations.prepare({ ...f.input, requestId: 'after-cancel', instructions: [{ ...f.input.instructions[0], data: new TextEncoder().encode('after cancel') }] });
  const nextSigned = await f.sign(next.transactionBase64);
  await assert.rejects(f.operations.submit({ identity: f.identity, id: next.id, signedTransactionBase64: nextSigned }), /used today's free network fees/);
  await f.operations.cancel({ identity: f.identity, id: prepared.id }); assert.equal(Object.keys(await f.readLedger()).length, 0);
  f.sponsor.sign = originalSign;
  await f.operations.submit({ identity: f.identity, id: next.id, signedTransactionBase64: nextSigned });
  release.resolve(); await assert.rejects(pending, /reservation changed/);
  assert.equal(Object.keys(await f.readLedger()).length, 1);
  const nextMessage = getTransactionDecoder().decode(Buffer.from(next.transactionBase64, 'base64')).messageBytes;
  assert.ok(f.broadcasts.every(bytes => Buffer.from(getTransactionDecoder().decode(bytes).messageBytes).equals(Buffer.from(nextMessage))));
  await f.store.close();
});

test('expired never-landed signatures release budget only after finalized height and a fresh absent lookup', async () => {
  const f = await fixture({ globalDailyLamports: 20_000n }), prepared = await f.operations.prepare(f.input);
  await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  f.setHeight(100n); await f.operations.reconcile({ id: prepared.id }); assert.equal(Object.keys(await f.readLedger()).length, 1);
  f.setHeight(101n); assert.equal((await f.operations.reconcile({ id: prepared.id })).state, 'expired'); assert.equal(Object.keys(await f.readLedger()).length, 0);
  f.setLastValidHeight(200n);
  const next = await f.operations.prepare({ ...f.input, requestId: 'after-expiry' });
  await f.operations.submit({ identity: f.identity, id: next.id, signedTransactionBase64: await f.sign(next.transactionBase64) });
  assert.equal(f.signerCalls(), 2);
  await f.store.close();
});

test('failed landed transactions remain charged, never refunded as if no fee was paid', async () => {
  const f = await fixture({ globalDailyLamports: 20_000n }), prepared = await f.operations.prepare(f.input);
  await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  f.setObservation({ status: 'failed', reason: 'transaction-error' });
  assert.equal((await f.operations.reconcile({ id: prepared.id })).state, 'failed'); assert.equal((await f.readLedger())[prepared.id].state, 'charged');
  const next = await f.operations.prepare({ ...f.input, requestId: 'after-paid-failure' });
  await assert.rejects(f.operations.submit({ identity: f.identity, id: next.id, signedTransactionBase64: await f.sign(next.transactionBase64) }), /site's daily network-fee budget/);
  assert.equal(f.signerCalls(), 1);
  await f.store.close();
});

test('atomic ledger prevents concurrent feature submits in separate service instances from overspending', async () => {
  const f = await fixture({ subjectRollingLamports: 30_000n }), other = f.createAgain();
  const first = await f.operations.prepare({ ...f.input, kind: 'house:stake', requestId: 'parallel-house' });
  const second = await other.prepare({ ...f.input, kind: 'shares:collateral', requestId: 'parallel-shares', instructions: [{ ...f.input.instructions[0], data: new TextEncoder().encode('other feature') }] });
  const [firstSigned, secondSigned] = await Promise.all([f.sign(first.transactionBase64), f.sign(second.transactionBase64)]);
  const outcomes = await Promise.allSettled([
    f.operations.submit({ identity: f.identity, id: first.id, signedTransactionBase64: firstSigned }),
    other.submit({ identity: f.identity, id: second.id, signedTransactionBase64: secondSigned }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1); assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  assert.equal(f.signerCalls(), 1); assert.equal(Object.keys(await f.readLedger()).length, 1);
  await f.store.close();
});

test('feature hopping and user-attributed AI settlement share the same subject allowance; system price does not bypass global charging', async () => {
  const f = await fixture({ subjectRollingLamports: 20_000n, globalDailyLamports: 100_000n });
  const house = await f.operations.prepare(f.input);
  await f.operations.submit({ identity: f.identity, id: house.id, signedTransactionBase64: await f.sign(house.transactionBase64) }); await f.complete(house.id);
  const shares = await f.createAgain().prepare({ ...f.input, kind: 'shares:market:deposit_collateral', requestId: 'feature-hop' });
  await assert.rejects(f.operations.submit({ identity: f.identity, id: shares.id, signedTransactionBase64: await f.sign(shares.transactionBase64) }), /used today's free network fees/);
  const settlement = { kind: 'ai-settle', requestId: 'user-ai-settle', sponsorshipSubject: f.identity.subject, instructions: [{ programAddress: MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode('AI settlement') }], review: {} };
  await assert.rejects(f.operations.executeAsSponsor(settlement), /used today's free network fees/);
  await assert.rejects(f.operations.executeAsSponsor({ ...settlement, sponsorshipSubject: 'did:privy:somebody-else' }), /different action/);
  const price = await f.operations.executeAsSponsor({ kind: 'shares:price', requestId: 'system-price', instructions: [{ programAddress: MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode('system price') }], review: {} });
  assert.ok(price.signature); assert.equal((await f.readLedger())[price.id].subject, null);
  assert.equal(Object.values(await f.readLedger()).reduce((sum, entry) => sum + BigInt(entry.amountLamports), 0n), 40_000n); assert.equal(f.signerCalls(), 2);
  await f.store.close();
});

test('confirmed charges retain the rolling allowance for 24 hours and then age out without refunding pending operations', async () => {
  const f = await fixture({ subjectRollingTransactions: 1 }), prepared = await f.operations.prepare(f.input);
  await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) }); await f.complete(prepared.id);
  f.setClock(86_400_999);
  const next = await f.operations.prepare({ ...f.input, requestId: 'rolling-renewal', instructions: [{ ...f.input.instructions[0], data: new TextEncoder().encode('rolling renewal') }] });
  const signedTransactionBase64 = await f.sign(next.transactionBase64);
  await assert.rejects(f.operations.submit({ identity: f.identity, id: next.id, signedTransactionBase64 }), /used today's free network fees/);
  f.setClock(86_401_000);
  await f.operations.submit({ identity: f.identity, id: next.id, signedTransactionBase64 });
  assert.equal(f.signerCalls(), 2); assert.equal(Object.keys(await f.readLedger()).length, 1);
  await f.store.close();
});

test('concurrent retries of one operation cannot sign twice or consume two budget reservations', async () => {
  const f = await fixture({ subjectRollingLamports: 20_000n }), prepared = await f.operations.prepare(f.input), signedTransactionBase64 = await f.sign(prepared.transactionBase64);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), originalSign = f.sponsor.sign;
  f.sponsor.sign = async bytes => { started.resolve(); await release.promise; return originalSign(bytes); };
  const first = f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 });
  await started.promise;
  await assert.rejects(f.createAgain().submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 }), /Another request is sponsoring/);
  assert.equal(Object.keys(await f.readLedger()).length, 1);
  release.resolve(); const submitted = await first;
  assert.equal(submitted.state, 'broadcast'); assert.equal(f.signerCalls(), 1);
  await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 });
  assert.equal(f.signerCalls(), 1); assert.equal(Object.keys(await f.readLedger()).length, 1);
  await f.store.close();
});

test('the subject allowance spans wallet rotation as well as feature hopping', async () => {
  const f = await fixture({ subjectRollingLamports: 20_000n }), first = await f.operations.prepare(f.input);
  await f.operations.submit({ identity: f.identity, id: first.id, signedTransactionBase64: await f.sign(first.transactionBase64) }); await f.complete(first.id);
  const identity = { ...f.identity, wallets: [...f.identity.wallets, { id: 'second-wallet', chainType: 'solana' as const, address: f.stranger.address }] };
  const second = await f.operations.prepare({ ...f.input, identity, actor: f.stranger.address, walletId: 'second-wallet', requestId: 'other-wallet', instructions: [{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [{ address: f.stranger.address, role: AccountRole.READONLY_SIGNER }], data: new TextEncoder().encode('other wallet') }] });
  await assert.rejects(f.operations.submit({ identity, id: second.id, signedTransactionBase64: await f.sign(second.transactionBase64, f.stranger) }), /used today's free network fees/);
  assert.equal(f.signerCalls(), 1);
  await f.store.close();
});

test('confirmed global charges reset at UTC midnight while recent subject charges remain rolling', async () => {
  const f = await fixture({ globalDailyLamports: 20_000n, subjectRollingLamports: 100_000n });
  const beforeMidnight = Date.UTC(2026, 9, 4, 23, 59, 59); f.setClock(beforeMidnight);
  const first = await f.operations.prepare(f.input);
  await f.operations.submit({ identity: f.identity, id: first.id, signedTransactionBase64: await f.sign(first.transactionBase64) }); await f.complete(first.id);
  f.setClock(beforeMidnight + 2000);
  const next = await f.operations.prepare({ ...f.input, requestId: 'new-utc-budget', instructions: [{ ...f.input.instructions[0], data: new TextEncoder().encode('new UTC day') }] });
  await f.operations.submit({ identity: f.identity, id: next.id, signedTransactionBase64: await f.sign(next.transactionBase64) });
  assert.equal(f.signerCalls(), 2); assert.equal(Object.keys(await f.readLedger()).length, 2);
  await f.store.close();
});

test('zero configured global budget is an emergency stop for user and system signing', async () => {
  const f = await fixture({ globalDailyLamports: 0n }), prepared = await f.operations.prepare(f.input);
  await assert.rejects(f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) }), /site's daily network-fee budget/);
  await assert.rejects(f.operations.executeAsSponsor({ kind: 'system:price', requestId: 'paused', instructions: [{ programAddress: MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode('paused price') }], review: {} }), /site's daily network-fee budget/);
  assert.equal(f.signerCalls(), 0); assert.equal(Object.keys(await f.readLedger()).length, 0);
  await f.store.close();
});

test('a proven failed durable signed-write never broadcasts and releases its unsigned reservation', async () => {
  const f = await fixture({ globalDailyLamports: 20_000n }), prepared = await f.operations.prepare(f.input), originalUpdate = f.store.update.bind(f.store);
  f.store.update = async (key, change) => originalUpdate(key, current => {
    const next = change(current);
    if (key.startsWith('solana-operation:') && typeof next === 'object' && next !== null && 'state' in next && next.state === 'broadcast') throw new Error('Signed write failed before commit');
    return next;
  });
  await assert.rejects(f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) }), /before commit/);
  assert.equal(f.broadcasts.length, 0); assert.equal(Object.keys(await f.readLedger()).length, 0);
  f.store.update = originalUpdate;
  await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  assert.equal((await f.readLedger())[prepared.id].state, 'reserved');
  await f.store.close();
});

test('an ambiguous signed-write acknowledgement retains budget and recovers the immutable transaction without signing twice', async () => {
  const f = await fixture({ globalDailyLamports: 20_000n }), prepared = await f.operations.prepare(f.input), originalUpdate = f.store.update.bind(f.store);
  f.store.update = async (key, change) => {
    const next = await originalUpdate(key, change);
    if (key.startsWith('solana-operation:') && typeof next === 'object' && next !== null && 'state' in next && next.state === 'broadcast') throw new Error('Signed write acknowledgement lost after commit');
    return next;
  };
  const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
  await assert.rejects(f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 }), /after commit/);
  assert.equal(f.broadcasts.length, 0); assert.equal((await f.readLedger())[prepared.id].state, 'reserved');
  f.store.update = originalUpdate;
  const recovered = await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 });
  assert.equal(recovered.state, 'broadcast'); assert.equal(f.signerCalls(), 1); assert.ok(f.broadcasts.length > 0);
  const other = await f.operations.prepare({ ...f.input, requestId: 'cannot-bypass-ambiguous-write' });
  await assert.rejects(f.operations.submit({ identity: f.identity, id: other.id, signedTransactionBase64: await f.sign(other.transactionBase64) }), /site's daily network-fee budget/);
  await f.store.close();
});

test('orphan unsigned reservations resume after a crash without losing their ceiling, subject or window attribution', async t => {
  for (const lease of [false, true]) await t.test(lease ? 'expired durable lease' : 'legacy reservation without a lease', async () => {
    const f = await fixture({ globalDailyLamports: 40_000n, subjectRollingLamports: 40_000n, subjectRollingTransactions: 1 });
    const prepared = await f.operations.prepare(f.input), signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    const paused = createSolanaOperations({ store: f.store, gateway: f.gateway, sponsor: f.sponsor,
      config: { ...f.config, sponsorshipLimits: { globalDailyLamports: 0n } }, now: () => 1000 });
    await assert.rejects(paused.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 }), /site's daily network-fee budget/);
    const ledger = (await f.store.scan<LedgerView>('solana-sponsorship:'))[0];
    await f.store.update<LedgerView>(ledger.key, current => ({ reservations: { ...current.reservations,
      [prepared.id]: { amountLamports: '40000', subject: f.identity.subject, state: 'reserved', reservedAt: 1000, ownerToken: 'terminated-worker' } } }));
    if (lease) {
      await f.store.update<{ signingLease?: { ownerToken: string; expiresAt: number } }>(`solana-operation:${prepared.id}`, current =>
        ({ ...current, signingLease: { ownerToken: 'terminated-worker', expiresAt: 31_000 } }));
      await assert.rejects(f.createAgain().submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 }), /Another request is sponsoring/);
      assert.equal(f.signerCalls(), 0);
      assert.equal((await f.readLedger())[prepared.id].ownerToken, 'terminated-worker');
    }
    f.setClock(31_001);
    const recovered = await f.createAgain().submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 });
    assert.equal(recovered.state, 'broadcast');
    assert.equal((await f.operations.get(prepared.id)).transactionBase64, prepared.transactionBase64);
    assert.equal(f.signerCalls(), 1);
    assert.equal((await f.readLedger())[prepared.id].amountLamports, '40000');
    assert.equal((await f.readLedger())[prepared.id].subject, f.identity.subject);
    assert.equal((await f.readLedger())[prepared.id].reservedAt, 1000);
    await f.complete(prepared.id);
    assert.equal((await f.readLedger())[prepared.id].state, 'charged');
    assert.equal(Object.keys(await f.readLedger()).length, 1);
    const next = await f.operations.prepare({ ...f.input, requestId: 'after-orphan-recovery' });
    await assert.rejects(f.operations.submit({ identity: f.identity, id: next.id, signedTransactionBase64: await f.sign(next.transactionBase64) }), /used today's free network fees/);
    assert.equal(f.signerCalls(), 1);
    await f.store.close();
  });
});

test('lease takeover fences a stale signer at the atomic signed-write even after its budget resize succeeded', async () => {
  const f = await fixture({ globalDailyLamports: 20_000n }), prepared = await f.operations.prepare(f.input);
  const signedTransactionBase64 = await f.sign(prepared.transactionBase64), originalUpdate = f.store.update.bind(f.store);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let writes = 0;
  f.store.update = async (key, change) => {
    if (key === `solana-operation:${prepared.id}` && ++writes === 2) {
      started.resolve();
      await release.promise;
    }
    return originalUpdate(key, change);
  };
  const stale = f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 });
  await started.promise;
  const oldReservation = (await f.readLedger())[prepared.id];
  assert.equal(oldReservation.state, 'reserved');
  assert.equal(f.signerCalls(), 1);
  assert.equal(f.broadcasts.length, 0);
  f.setClock(31_001);
  f.setObservation({ status: 'pending', reason: 'awaiting-finality' });
  const recovered = await f.createAgain().submit({ identity: f.identity, id: prepared.id, signedTransactionBase64 });
  assert.equal(recovered.state, 'broadcast');
  const signed = await f.store.get<{ signedTransactionBase64: string; signature: string }>(`solana-operation:${prepared.id}`);
  assert.notEqual((await f.readLedger())[prepared.id].ownerToken, oldReservation.ownerToken);
  assert.equal(Object.keys(await f.readLedger()).length, 1);
  assert.equal(f.broadcasts.length, 1);
  release.resolve();
  await assert.rejects(stale, /Sponsorship signing lease changed/);
  assert.equal(f.broadcasts.length, 1, 'the fenced signer must never reach broadcast');
  assert.equal((await f.operations.get(prepared.id)).signature, signed!.signature);
  assert.equal(Buffer.from(f.broadcasts[0]).toString('base64'), signed!.signedTransactionBase64);
  assert.equal((await f.readLedger())[prepared.id].state, 'reserved');
  await f.complete(prepared.id);
  assert.equal((await f.readLedger())[prepared.id].state, 'charged');
  assert.equal(Object.keys(await f.readLedger()).length, 1);
  f.store.update = originalUpdate;
  await f.store.close();
});

test('signed ambiguity keeps immutable bytes and its reservation after the unsigned signing lease would expire', async () => {
  const f = await fixture({ globalDailyLamports: 20_000n }), prepared = await f.operations.prepare(f.input);
  f.setBroadcastError(true);
  const submitted = await f.operations.submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  const signed = await f.store.get<{ signedTransactionBase64: string; signingLease?: unknown }>(`solana-operation:${prepared.id}`);
  assert.equal(signed!.signingLease, undefined);
  f.setClock(31_001);
  await f.createAgain().submit({ identity: f.identity, id: prepared.id, signedTransactionBase64: await f.sign(prepared.transactionBase64) });
  assert.equal(f.signerCalls(), 1);
  assert.equal((await f.operations.get(prepared.id)).signature, submitted.signature);
  assert.equal((await f.readLedger())[prepared.id].state, 'reserved');
  assert.equal(Object.keys(await f.readLedger()).length, 1);
  assert.ok(f.broadcasts.every(bytes => Buffer.from(bytes).toString('base64') === signed!.signedTransactionBase64));
  await f.store.close();
});
