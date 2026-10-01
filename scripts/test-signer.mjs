#!/usr/bin/env node

// Passkey-free devnet test cycle. Operator-held test keys act as tenant, landlord and
// arbitrator; every step goes through the real agreement, initialization and operation
// services. Results are fixtures, never Privy/wallet evidence. Dry-run unless --send.
//
//   SOLANA_TEST_SIGNER_MODE=1 node --env-file-if-exists=.env.local --experimental-strip-types \
//     scripts/test-signer.mjs new|status|next|run [--send] [--claim=ATOMIC] [--dispute]
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import {
  acceptAgreement,
  agreementDigest,
  createAgreement,
  inviteToAgreement,
  joinAgreement,
} from '../src/server/agreements.ts';
import { deriveEscrowAddresses } from '../src/finance/solana/program.ts';
import {
  createSolanaInitializationService,
  leaseIdForAgreement,
  RpcInitializationGateway,
} from '../src/server/solana-initialization.ts';
import { RpcSolanaGateway, solanaConfiguration } from '../src/server/solana-rpc.ts';
import { configuredFeeSponsor, createSolanaService } from '../src/server/solana-service.ts';
import { getStore } from '../src/server/store.ts';
import {
  assertTestAgreement,
  assertTestSignerAllowed,
  nextBundledStep,
  nextTestStep,
  signPrepared,
  testIdentity,
} from '../src/server/test-signer.ts';

const [command = 'status', ...flags] = process.argv.slice(2);
const send = flags.includes('--send');
const dispute = flags.includes('--dispute');
const bundled = flags.includes('--bundled');
const claimAtomic = flags.find((flag) => flag.startsWith('--claim='))?.slice(8) ?? '0';
if (!['new', 'status', 'next', 'run'].includes(command) || !/^(0|[1-9]\d{0,9})$/.test(claimAtomic)) {
  console.error('Usage: scripts/test-signer.mjs new|status|next|run [--send] [--claim=ATOMIC] [--dispute] [--bundled]');
  process.exit(2);
}
const dir = resolve(process.env.SOLANA_TEST_SIGNER_DIR || '.testnet-secrets/test-signer');
const statePath = resolve(dir, 'state.json');
const roles = ['tenant', 'landlord', 'arbitrator'];
const log = (value) => console.log(JSON.stringify(value));

async function signers() {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const result = {};
  for (const role of roles) {
    const path = resolve(dir, `${role}.json`);
    let bytes;
    try {
      bytes = new Uint8Array(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const jwk = (key) => Buffer.from(key.export({ format: 'jwk' })[key === privateKey ? 'd' : 'x'], 'base64url');
      bytes = new Uint8Array([...jwk(privateKey), ...jwk(publicKey)]);
      await writeFile(path, JSON.stringify([...bytes]), { mode: 0o600, flag: 'wx' });
    }
    result[role] = await createKeyPairSignerFromBytes(bytes);
  }
  return result;
}
async function stagedManifest(agreementId, tenant) {
  const evidence = JSON.parse(await readFile(
    new URL(`../docs/evidence/${process.env.SOLANA_TEST_SIGNER_EVIDENCE || 'SOLANA_PULL_DEVNET_DEPLOYMENT_2026-09-25.json'}`, import.meta.url), 'utf8'));
  const base = {
    setupMode: 'staged', ...(evidence.escrowVersion ? { escrowVersion: evidence.escrowVersion } : {}), cluster: evidence.cluster, genesisHash: evidence.genesisHash,
    escrowProgram: evidence.escrowProgram, programSha256: evidence.programSha256,
    programCodeLength: evidence.programCodeLength, upgradeAuthority: evidence.upgradeAuthority,
    depositMint: evidence.depositMint, reserve: evidence.reserve, market: evidence.market,
    receiptMint: evidence.receiptMint, liquiditySupply: evidence.liquiditySupply,
    marketAuthority: evidence.marketAuthority, oracleAccounts: evidence.oracleAccounts,
    maxObservationAgeMs: 15_000, agreementId, tenancyAddress: '', maximumSponsorLamports: '10000000',
  };
  base.tenancyAddress = (await deriveEscrowAddresses(base.escrowProgram, tenant, leaseIdForAgreement(base, agreementId))).tenancy;
  return base;
}

function configure(manifest) {
  const environment = { SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', SOLANA_DEPLOYMENT_MANIFEST: JSON.stringify(manifest) };
  const config = solanaConfiguration(environment);
  if (!config) throw new Error('Invalid test deployment manifest');
  assertTestSignerAllowed(process.env, config);
  return { config, environment };
}

function operatorScript(script, agreementId, environment) {
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', resolve('scripts', script), agreementId, ...(send ? ['--send'] : []),
  ], { env: { ...process.env, ...environment }, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`${script} failed: ${result.stderr.split('\n').find((line) => line.startsWith('Error')) ?? 'see its output'}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

const store = await getStore();
const keys = await signers();
const identities = Object.fromEntries(roles.map((role) => [role, testIdentity(role, keys[role].address)]));

if (command === 'new') {
  assertTestSignerAllowed(process.env, { cluster: 'devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' });
  const created = await createAgreement(store, identities.landlord, {
    network: 'solana', property: 'Test-signer flat (fixture)', requiredSecurity: '10000000', releaseAllowed: true,
  });
  for (const role of ['tenant', 'arbitrator']) {
    const invite = await inviteToAgreement(store, created.id, identities.landlord, role);
    await joinAgreement(store, created.id, identities[role], role, invite.token);
  }
  const agreement = await store.get(`agreement:${created.id}`);
  const digest = agreementDigest(agreement);
  await acceptAgreement(store, created.id, identities.tenant, digest);
  await acceptAgreement(store, created.id, identities.landlord, digest);
  const manifest = await stagedManifest(created.id, keys.tenant.address);
  const { environment } = configure(manifest);
  await writeFile(statePath, JSON.stringify({ agreementId: created.id, manifest }, null, 2), { mode: 0o600 });
  log({ step: 'agreement', agreementId: created.id, state: 'accepted by test tenant and landlord' });
  log({ step: 'payout-accounts', result: operatorScript('prepare-solana-app-payouts.mjs', created.id, environment).status });
  if (send) {
    try {
      log({ step: 'tenant-test-usdc', result: operatorScript('fund-solana-app-tenant.mjs', created.id, environment).status });
    } catch (error) {
      log({ step: 'tenant-test-usdc', result: 'operator faucet account could not fund the test tenant', reason: error.message,
        action: `Request 10 devnet USDC at https://faucet.circle.com/ for the test tenant wallet ${keys.tenant.address}, then run \`run --send\`.` });
    }
  }
  log({ next: send ? 'Run: scripts/test-signer.mjs run --send' : 'Dry run: nothing was broadcast. Use `new --send` to create payout accounts and give the test tenant 10 test USDC.' });
  process.exit(0);
}

const state = JSON.parse(await readFile(statePath, 'utf8').catch(() => {
  throw new Error('No test tenancy. Run `scripts/test-signer.mjs new --send` first.');
}));
const agreement = await store.get(`agreement:${state.agreementId}`);
if (!agreement) throw new Error('The test agreement is missing from the local database');
assertTestAgreement(agreement);
const { config } = configure(state.manifest);
const sponsor = await configuredFeeSponsor();
if (!sponsor) throw new Error('SOLANA_SPONSOR_KEYPAIR is required');
// Operator-held fixture wallets bypass Privy ownership checks only in this gated CLI.
const accessGate = async (_store, identity) => ({ wallet: identity.wallets[0] });
const init = createSolanaInitializationService({ store, config, gateway: new RpcInitializationGateway(config), sponsor, accessGate });
const service = createSolanaService({ store, config, gateway: new RpcSolanaGateway(config), sponsor, accessGate });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function observe() {
  const setup = (await init.status(identities.landlord)).initialization;
  const initialized = setup?.state === 'finalized';
  const snapshot = initialized ? await service.snapshot(identities.tenant) : null;
  const supplied = Boolean(snapshot?.operations.some((op) => op.action.kind === 'supply' && op.state === 'finalized'));
  const step = (bundled ? nextBundledStep : nextTestStep)({
    initialized, tenancy: snapshot?.tenancy, receiptValueAtomic: snapshot?.receiptValueAtomic, supplied, claimAtomic, dispute,
  });
  return { setup, snapshot, step };
}

async function settle(check) {
  for (let attempt = 0; attempt < 45; attempt++) {
    const result = await check();
    if (['finalized', 'failed'].includes(result.state)) return result;
    await wait(2000);
  }
  throw new Error('Result still unknown; run `status` later. The signed transaction is persisted and will not be re-signed.');
}

async function next() {
  const { setup, snapshot, step } = await observe();
  log({ phase: snapshot?.tenancy.phase ?? setup?.state ?? 'not-initialized', next: step.label });
  if (step.kind === 'done' || !send) return step;
  const identity = identities[step.role];
  if (step.kind === 'initialize') {
    let view = await init.prepare(identity);
    if (view.state === 'prepared') view = await init.sign(identity, await signPrepared(keys[step.role], view.transactionBase64));
    view = await settle(() => init.reconcile(identity));
    log({ step: step.label, state: view.state, signature: view.signature });
    if (view.state !== 'finalized') throw new Error(view.lastError ?? 'Initialization failed');
    return step;
  }
  if (step.kind === 'payouts') {
    const op = await settle(async () => (await service.payout(identity)) ?? { state: 'finalized', signature: null });
    log({ step: step.label, action: op.action?.landlord === undefined ? null : op.action.landlord ? 'landlord' : 'tenant', state: op.state, signature: op.signature });
    if (op.state !== 'finalized') throw new Error(op.lastError ?? 'Payout failed');
    return step;
  }
  // Resume a signed operation left pending by an interrupted run; never sign a second intent.
  const pending = snapshot?.operations.find((item) => item.signature && !['finalized', 'failed', 'expired'].includes(item.state));
  if (pending) {
    const owner = identities[pending.role];
    const resumed = await settle(() => service.reconcile(owner, pending.id));
    log({ step: `resume ${pending.action.kind}`, state: resumed.state, signature: resumed.signature });
    if (resumed.state !== 'finalized') throw new Error(resumed.lastError ?? 'Pending operation failed');
    return step;
  }
  let op = await service.prepare(identity, `ts-${randomUUID()}`, step.action);
  if (op.state === 'prepared') op = await service.authorize(identity, op.id, await signPrepared(keys[step.role], op.transactionBase64));
  op = await settle(() => service.reconcile(identity, op.id));
  log({ step: step.label, state: op.state, signature: op.signature });
  if (op.state !== 'finalized') throw new Error(op.lastError ?? 'Operation failed');
  return step;
}

if (command === 'status') {
  const { snapshot, step } = await observe();
  const t = snapshot?.tenancy;
  log({
    agreementId: state.agreementId, phase: t?.phase ?? 'not-initialized', nonce: t?.nextNonce,
    escrowCashAtomic: t?.accountedIdleAtomic, receiptsAtomic: t?.accountedReceiptsAtomic,
    tenantPayoutAtomic: t && (await payoutBalance(t.tenantDestination)), landlordPayoutAtomic: t && (await payoutBalance(t.landlordDestination)),
    next: step.label,
  });
} else if (command === 'next') {
  await next();
} else {
  if (!send) { await next(); process.exit(0); }
  // Public devnet RPC rate-limits bursts; persisted operations make a retried step safe.
  for (let index = 0, failures = 0; index < 60; index++) {
    try {
      if ((await next()).kind === 'done') break;
      failures = 0;
    } catch (error) {
      // An unsigned review from an interrupted run holds the nonce until it expires (about a minute).
      const transient = error.message === 'RPC unavailable' || error.code === 'nonce_reserved';
      if (!transient || ++failures > 12) throw error;
      log({ retrying: error.code ?? error.message });
      await wait(error.code === 'nonce_reserved' ? 10_000 : 4000);
    }
  }
}
process.exit(0);

async function payoutBalance(account) {
  const gateway = new RpcInitializationGateway(config);
  const value = await gateway.rpc('getTokenAccountBalance', [account, { commitment: 'finalized' }]).catch(() => null);
  return value?.value?.amount ?? null;
}
