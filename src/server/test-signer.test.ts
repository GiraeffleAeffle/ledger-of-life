import assert from 'node:assert/strict';
import test from 'node:test';
import { SOLANA_MAINNET_MANIFEST } from '../finance/solana/index.ts';
import { assertTestAgreement, assertTestSignerAllowed, nextTestStep } from './test-signer.ts';

const devnet = { cluster: 'devnet' as const, genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' };

test('test-signer mode requires the explicit flag, the local database and a non-mainnet cluster', () => {
  assert.throws(() => assertTestSignerAllowed({}, devnet), /off/);
  assert.throws(() => assertTestSignerAllowed({ SOLANA_TEST_SIGNER_MODE: 'true' }, devnet), /off/);
  assert.throws(
    () => assertTestSignerAllowed({ SOLANA_TEST_SIGNER_MODE: '1', DATABASE_URL: 'postgres://x' }, devnet),
    /local test database/,
  );
  assert.throws(
    () => assertTestSignerAllowed({ SOLANA_TEST_SIGNER_MODE: '1' }, { cluster: 'devnet', genesisHash: SOLANA_MAINNET_MANIFEST.genesisHash }),
    /devnet or localnet/,
  );
  assert.doesNotThrow(() => assertTestSignerAllowed({ SOLANA_TEST_SIGNER_MODE: '1' }, devnet));
});

test('test signers refuse any agreement with a real participant', () => {
  const party = (subject: string) => ({ subject });
  assert.throws(
    () => assertTestAgreement({ parties: { tenant: party('test-signer:tenant'), landlord: party('did:privy:real'), arbitrator: party('test-signer:arbitrator') } }),
    /test-signer agreements/,
  );
  assert.doesNotThrow(() =>
    assertTestAgreement({ parties: { tenant: party('test-signer:tenant'), landlord: party('test-signer:landlord'), arbitrator: party('test-signer:arbitrator') } }),
  );
});

const tenancy = (phase: string, extra: Record<string, string> = {}) => ({
  phase,
  accountedIdleAtomic: '0',
  accountedReceiptsAtomic: '0',
  claimAtomic: '0',
  tenantOwedAtomic: '0',
  landlordOwedAtomic: '0',
  ...extra,
}) as Parameters<typeof nextTestStep>[0]['tenancy'];
const base = { initialized: true, supplied: false, claimAtomic: '0', dispute: false };

test('the happy path supplies once, redeems before the claim and before settlement', () => {
  assert.equal(nextTestStep({ ...base, initialized: false }).kind, 'initialize');
  const active = tenancy('active', { accountedIdleAtomic: '10000000' });
  assert.deepEqual(nextTestStep({ ...base, tenancy: active }).kind === 'action' && nextTestStep({ ...base, tenancy: active }), {
    role: 'tenant', kind: 'action', action: { kind: 'supply', amountAtomic: '10000000' }, label: 'Tenant supplies the deposit to lending',
  });
  const lent = nextTestStep({ ...base, tenancy: tenancy('active', { accountedReceiptsAtomic: '9' }), receiptValueAtomic: '10000000' });
  assert.equal(lent.kind === 'action' && lent.action.kind, 'redeem');
  const afterRedeem = nextTestStep({ ...base, supplied: true, tenancy: active, claimAtomic: '120' });
  assert.deepEqual(afterRedeem.kind === 'action' && [afterRedeem.role, afterRedeem.action], ['landlord', { kind: 'propose_claim', amountAtomic: '120' }]);
  const settling = nextTestStep({ ...base, tenancy: tenancy('settling', { accountedReceiptsAtomic: '1' }) });
  assert.equal(settling.kind === 'action' && settling.action.kind, 'redeem');
  assert.equal(nextTestStep({ ...base, tenancy: tenancy('closed') }).kind, 'done');
});

test('disputes route to the arbitrator and pull payouts are paid before completion', () => {
  const disputed = nextTestStep({ ...base, dispute: true, tenancy: tenancy('claim-proposed') });
  assert.deepEqual(disputed.kind === 'action' && disputed.action, { kind: 'respond_to_claim', accept: false });
  const decision = nextTestStep({ ...base, tenancy: tenancy('disputed', { claimAtomic: '50' }) });
  assert.deepEqual(decision.kind === 'action' && [decision.role, decision.action], ['arbitrator', { kind: 'resolve_claim', amountAtomic: '50' }]);
  const owed = nextTestStep({ ...base, tenancy: tenancy('closed', { landlordOwedAtomic: '50' }) });
  assert.deepEqual(owed.kind === 'action' && owed.action, { kind: 'payout', landlord: true });
});

test('in-app test helpers need the flag, a devnet deployment and a loopback request', async () => {
  const { testHelpersEnabled } = await import('./test-helpers.ts');
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(
    new URL('../../docs/evidence/SOLANA_PULL_DEVNET_DEPLOYMENT_2026-09-25.json', import.meta.url), 'utf8'));
  const env = {
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    SOLANA_DEPLOYMENT_MANIFEST: JSON.stringify({
      ...manifest, maxObservationAgeMs: 15000, maximumSponsorLamports: '10000000',
      agreementId: 'a', tenancyAddress: manifest.escrowProgram,
    }),
  };
  const local = new Request('http://localhost:4175/api/test-helpers');
  assert.equal(testHelpersEnabled(local, env), false);
  assert.equal(testHelpersEnabled(local, { ...env, SOLANA_TEST_SIGNER_MODE: '1' }), true);
  assert.equal(testHelpersEnabled(new Request('https://deposit.example/api/test-helpers'), { ...env, SOLANA_TEST_SIGNER_MODE: '1' }), false);
  assert.equal(testHelpersEnabled(local, { ...env, SOLANA_TEST_SIGNER_MODE: '1', DATABASE_URL: 'postgres://x' }), false);
});
