import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address, getAddressDecoder, getBase58Decoder, getTransactionDecoder } from '@solana/kit';
import { getMintEncoder } from '@solana-program/token-2022';
import { SOLANA_DEVNET_MANIFEST, SOLANA_IDS, SOLANA_TEST_USDC_MINT, type ExpectedTokenDelta, type SignatureReconciliation } from '../finance/solana/index.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { accruedDepositYield, claimDepositYield, DEPOSIT_YIELD_YEAR_MS, depositYieldRate, readDepositYield } from './deposit-yield.ts';
import type { Agreement } from './agreements.ts';
import { LocalStore } from './store.ts';
import type { solanaServicesFor } from './solana-tenancies.ts';
import type { SolanaOperation } from './solana-service.ts';

const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
function keypair(byte: number) {
  const seed = Buffer.alloc(32, byte);
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { address: getAddressDecoder().decode(publicBytes), json: JSON.stringify([...seed, ...publicBytes]) };
}
const authority = keypair(31), sponsor = keypair(32), owner = keypair(33);
const funded = Date.UTC(2026, 0, 1);
const base = { requiredAtomic: '3000000000', mint: SOLANA_TEST_USDC_MINT, since: funded, now: funded + DEPOSIT_YIELD_YEAR_MS, rateBps: 500 };

test('simple annual accrual floors atomic units and obeys funding, settlement, cancellation and mint boundaries', () => {
  assert.equal(accruedDepositYield(base), '150000000');
  assert.equal(accruedDepositYield({ ...base, now: funded + DEPOSIT_YIELD_YEAR_MS / 2 }), '75000000');
  assert.equal(accruedDepositYield({ ...base, now: funded + 1 }), '0');
  assert.equal(accruedDepositYield({ ...base, now: funded - 1 }), '0');
  assert.equal(accruedDepositYield({ ...base, since: null }), '0');
  assert.equal(accruedDepositYield({ ...base, until: funded + DEPOSIT_YIELD_YEAR_MS / 2 }), '75000000');
  assert.equal(accruedDepositYield({ ...base, cancelled: true }), '0');
  assert.equal(accruedDepositYield({ ...base, mint: SOLANA_DEVNET_MANIFEST.deposit.mint }), '0');
  assert.equal(depositYieldRate({}), 500); assert.equal(depositYieldRate({ DEPOSIT_TEST_YIELD_BPS: '0' }), 0);
  assert.throws(() => depositYieldRate({ DEPOSIT_TEST_YIELD_BPS: '-1' }));
});

async function fixture(filename = ':memory:') {
  const store = new LocalStore(filename);
  const wallet = { id: 'tenant-wallet', address: owner.address, chainType: 'solana' as const };
  const identity: VerifiedIdentity = { subject: 'tenant', passkeyCount: 1, wallets: [wallet], sessionId: 'verified-session', expiresAt: Number.MAX_SAFE_INTEGER };
  const agreement: Agreement = { id: 'yield-fixture', network: 'solana', property: 'Home', requiredSecurity: '3000000000', releaseAllowed: true,
    createdAt: new Date(funded - 100000).toISOString(), revision: 0, parties: { tenant: { subject: 'tenant', wallet } }, accepted: {}, invitations: {}, records: [] };
  await store.create(`agreement:${agreement.id}`, agreement);
  const state = { time: funded + DEPOSIT_YIELD_YEAR_MS / 2, pending: false, unknown: false, height: 100, blockReads: 0, broadcasts: [] as Uint8Array[] };
  const tenancy = { phase: 'active' as 'active' | 'closed' | 'awaiting-funding', depositMint: SOLANA_TEST_USDC_MINT, requiredSecurityAtomic: agreement.requiredSecurity };
  const operations: Pick<SolanaOperation, 'state' | 'action' | 'receipt'>[] = [{ state: 'finalized', action: { kind: 'fund_and_supply' }, receipt: { status: 'finalized', slot: '10' } }];
  const client = {
    checkedGenesis: async () => SOLANA_DEVNET_MANIFEST.genesisHash,
    multiple: async () => ({ slot: '10', accounts: [{ address: SOLANA_TEST_USDC_MINT, owner: SOLANA_IDS.token, executable: false, lamports: '1000000',
      data: new Uint8Array(getMintEncoder().encode({ mintAuthority: address(authority.address), supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: null, extensions: null })) }] }),
    lifetime: async () => ({ blockhash: key(40), lastValidBlockHeight: '200', blockHeight: '100' }),
    simulate: async () => ({ slot: '50', sponsorDebitCeilingLamports: '2049280', networkFeeLamports: '10000' }),
    broadcast: async (bytes: Uint8Array) => {
      const ledger = await store.get<{ claims: { signed: string }[] }>(`deposit-yield:${agreement.id}`);
      assert.ok(ledger!.claims.some((claim) => claim.signed === Buffer.from(bytes).toString('base64')));
      state.broadcasts.push(bytes); return 'accepted';
    },
    reconcile: async (signature: string, _hash: string, deltas: readonly ExpectedTokenDelta[]): Promise<SignatureReconciliation> => {
      assert.equal(deltas[0].minimumAtomic, deltas[0].maximumAtomic);
      if (state.unknown) return { status: 'unknown', reason: 'rpc-evidence-unavailable' };
      if (!state.broadcasts.some((bytes) => getBase58Decoder().decode(getTransactionDecoder().decode(bytes).signatures[address(sponsor.address)]!) === signature))
        return { status: 'unknown', reason: 'signature-not-observed-do-not-resubmit-new-intent' };
      if (state.pending) return { status: 'pending', reason: 'awaiting-finality' };
      return { status: 'finalized', signature, slot: '55', deltas: [{ account: deltas[0].account, signedAtomic: deltas[0].minimumAtomic }] };
    },
    rpc: async (method: string, params: unknown[]) => {
      if (method === 'getBlockTime') { state.blockReads++; return (Number(params[0]) === 10 ? funded : funded + DEPOSIT_YIELD_YEAR_MS / 2) / 1000; }
      return state.height;
    },
  };
  const environment = { SOLANA_TEST_USDC_MINT_AUTHORITY: authority.json, SOLANA_SPONSOR_KEYPAIR: sponsor.json, SOLANA_RPC_URL: 'https://rpc.example',
    SOLANA_DEPLOYMENT_MANIFEST: JSON.stringify({ cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash,
      escrowProgram: key(10), programSha256: 'a'.repeat(64), programCodeLength: 1000, upgradeAuthority: null,
      depositMint: SOLANA_DEVNET_MANIFEST.deposit.mint, ledgerDepositMint: SOLANA_TEST_USDC_MINT,
      reserve: key(11), market: key(12), receiptMint: key(13), liquiditySupply: key(14), marketAuthority: key(15), oracleAccounts: [],
      maxObservationAgeMs: 15000, agreementId: agreement.id, tenancyAddress: key(16), maximumSponsorLamports: '10000000' }) };
  const resolveServices = (async () => ({ config: {}, service: { snapshot: async () => ({ tenancy, operations }) } })) as unknown as typeof solanaServicesFor;
  const options = { environment, client, now: () => state.time, resolveServices };
  return { store, identity, agreement, state, tenancy, operations, client, options };
}

test('funding uses finalized slot time, not agreement creation; missing evidence and closed settlement freeze fail closed', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  const read = () => readDepositYield(f.store, f.agreement, f.tenancy, f.operations, f.client.rpc, f.options);
  assert.equal((await read()).since, new Date(funded).toISOString());
  assert.equal((await read()).accruedAtomic, '75000000'); assert.equal(f.state.blockReads, 1);
  f.tenancy.phase = 'closed'; assert.equal((await read()).claimableAtomic, '0');
  f.operations.push({ state: 'finalized', action: { kind: 'settle' }, receipt: { status: 'finalized', slot: '20' } });
  f.state.time += DEPOSIT_YIELD_YEAR_MS;
  assert.equal((await read()).accruedAtomic, '75000000');
  f.tenancy.phase = 'awaiting-funding'; assert.equal((await read()).accruedAtomic, '0');
});

test('only verified tenant may claim; release policy gates early claims, settlement permits them', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  await assert.rejects(claimDepositYield(f.store, { ...f.identity, subject: 'landlord' }, f.agreement.id, 'claim-1', f.options), /verified party/);
  await assert.rejects(claimDepositYield(f.store, { ...f.identity, passkeyCount: 0 }, f.agreement.id, 'claim-1', f.options), /passkey/);
  await assert.rejects(claimDepositYield(f.store, { ...f.identity, wallets: [] }, f.agreement.id, 'claim-1', f.options), /verified party/);
  await f.store.update<Agreement>(`agreement:${f.agreement.id}`, (value) => ({ ...value, releaseAllowed: false }));
  await assert.rejects(claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-1', f.options), /after settlement/);
  assert.equal(f.state.broadcasts.length, 0);
  f.tenancy.phase = 'closed'; f.operations.push({ state: 'finalized', action: { kind: 'settle' }, receipt: { status: 'finalized', slot: '20' } });
  const result = await claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-1', f.options);
  assert.equal(result.status, 'confirmed'); assert.equal(result.amountAtomic, '75000000');
});

test('idempotent claim replay, one in-flight claim, exact recovery and subsequent payments never exceed accrued less claimed', async (t) => {
  const f = await fixture(); t.after(() => f.store.close()); f.state.pending = true;
  const first = await claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-1', f.options);
  assert.equal(first.status, 'pending');
  await assert.rejects(claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-2', f.options), /in flight/);
  f.state.time += DEPOSIT_YIELD_YEAR_MS / 2; f.state.pending = false;
  f.client.lifetime = async () => { throw new Error('must recover exact transaction'); };
  const recovered = await claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-1', f.options);
  assert.equal(recovered.signature, first.signature); assert.equal(recovered.amountAtomic, '75000000');
  assert.equal((await claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-1', f.options)).amountAtomic, '75000000');
  assert.equal(f.state.broadcasts.length, 1);
  f.client.lifetime = async () => ({ blockhash: key(41), lastValidBlockHeight: '200', blockHeight: '100' });
  assert.equal((await claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-2', f.options)).amountAtomic, '75000000');
  const ledger = await f.store.get<{ claimedAtomic: string }>(`deposit-yield:${f.agreement.id}`);
  assert.equal(ledger!.claimedAtomic, '150000000');
  await assert.rejects(claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-3', f.options), /No unclaimed/);
});

test('unknown evidence retains exact bytes without broadcast, expiration pays nothing and frees claim lane', async (t) => {
  const f = await fixture(); t.after(() => f.store.close()); f.state.unknown = true;
  assert.equal((await claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-1', f.options)).status, 'pending');
  assert.equal(f.state.broadcasts.length, 0);
  f.state.unknown = false; f.state.height = 201;
  assert.equal((await claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-1', f.options)).status, 'expired');
  assert.equal((await f.store.get<{ claimedAtomic: string }>(`deposit-yield:${f.agreement.id}`))!.claimedAtomic, '0');
  f.state.height = 100;
  assert.equal((await claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-2', f.options)).amountAtomic, '75000000');
});

test('concurrent requests reserve one payment and a failed confirmation write recovers without double credit', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  let failConfirmation = true;
  const store = {
    get: f.store.get.bind(f.store), create: f.store.create.bind(f.store), scan: f.store.scan.bind(f.store), close: async () => {},
    update: (async (key, change) => f.store.update(key, (value) => {
      const next = change(value);
      if (key === `deposit-yield:${f.agreement.id}` && failConfirmation && JSON.stringify(next).includes('"status":"confirmed"')) {
        failConfirmation = false; throw new Error('confirmation storage unavailable');
      }
      return next;
    })) as typeof f.store.update,
  };
  const results = await Promise.allSettled([
    claimDepositYield(store, f.identity, f.agreement.id, 'claim-1', f.options),
    claimDepositYield(store, f.identity, f.agreement.id, 'claim-2', f.options),
  ]);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
  assert.equal(f.state.broadcasts.length, 1);
  const journal = await f.store.get<{ claimedAtomic: string; claims: { requestId: string }[] }>(`deposit-yield:${f.agreement.id}`);
  assert.equal(journal!.claimedAtomic, '0');
  f.client.lifetime = async () => { throw new Error('must not replace the signed payment'); };
  const recovered = await claimDepositYield(f.store, f.identity, f.agreement.id, journal!.claims[0].requestId, f.options);
  assert.equal(recovered.amountAtomic, '75000000');
  assert.equal((await f.store.get<{ claimedAtomic: string }>(`deposit-yield:${f.agreement.id}`))!.claimedAtomic, '75000000');
  assert.equal(f.state.broadcasts.length, 1);
});

test('cancelled and Circle tenancies cannot claim site yield even if they have finalized funding', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  await f.store.update<Agreement>(`agreement:${f.agreement.id}`, (value) => ({ ...value, cancelled: { by: 'tenant', at: new Date(funded).toISOString() } }));
  await assert.rejects(claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-1', f.options), /after funding/);
  await f.store.update<Agreement>(`agreement:${f.agreement.id}`, (value) => ({ ...value, cancelled: undefined }));
  f.tenancy.depositMint = SOLANA_DEVNET_MANIFEST.deposit.mint;
  await assert.rejects(claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-1', f.options), /after funding/);
  assert.equal(f.state.broadcasts.length, 0);
});

test('a restarted process recovers the persisted yield mint and claimed balance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-yield-'));
  const filename = join(directory, 'yield.sqlite');
  let restarted: LocalStore | undefined;
  let originalClosed = false;
  const f = await fixture(filename);
  try {
    f.state.pending = true;
    const first = await claimDepositYield(f.store, f.identity, f.agreement.id, 'claim-1', f.options);
    await f.store.close();
    originalClosed = true;
    restarted = new LocalStore(filename);
    f.state.pending = false;
    f.client.lifetime = async () => { throw new Error('restart must recover signed bytes'); };
    const result = await claimDepositYield(restarted, f.identity, f.agreement.id, 'claim-1', f.options);
    assert.equal(result.signature, first.signature);
    assert.equal(result.amountAtomic, '75000000');
    assert.equal((await restarted.get<{ claimedAtomic: string }>(`deposit-yield:${f.agreement.id}`))!.claimedAtomic, '75000000');
    await assert.rejects(claimDepositYield(restarted, f.identity, f.agreement.id, 'claim-2', f.options), /No unclaimed/);
    assert.equal(f.state.broadcasts.length, 1);
  } finally {
    await restarted?.close();
    if (!originalClosed) await f.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
