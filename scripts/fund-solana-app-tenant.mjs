#!/usr/bin/env node

// Move only faucet test USDC from the pinned operator account to the accepted
// Privy tenant's own devnet account. The tenant still decides whether to fund escrow.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { agreementDigest } from '../src/server/agreements.ts';
import { decodeClassicTokenAccount } from '../src/finance/solana/observations.ts';
import { derivePayoutAddress } from '../src/finance/solana/program.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_IDS } from '../src/finance/solana/manifest.ts';
import { configuredFeeSponsor } from '../src/server/solana-service.ts';
import {
  RpcInitializationGateway,
} from '../src/server/solana-initialization.ts';
import { solanaConfiguration } from '../src/server/solana-rpc.ts';

const agreementId = process.argv[2];
const send = process.argv[3] === '--send';
if (!/^[a-zA-Z0-9_-]{1,160}$/.test(agreementId ?? '') || process.argv.length !== (send ? 4 : 3)) {
  console.error('Usage: node --env-file-if-exists=.env.local --experimental-strip-types scripts/fund-solana-app-tenant.mjs AGREEMENT_ID [--send]');
  process.exit(2);
}
if (process.env.DATABASE_URL) throw new Error('This requires the local test database');
const config = solanaConfiguration(process.env);
if (!config || config.cluster !== 'devnet' || config.agreementId !== agreementId)
  throw new Error('The pinned app devnet manifest must match this agreement');
const evidence = JSON.parse(await readFile(
  new URL('../docs/evidence/SOLANA_DEVNET_DEPLOYMENT_2026-09-23.json', import.meta.url),
  'utf8',
));
if (
  !evidence.operatorOnly ||
  evidence.genesisHash !== SOLANA_DEVNET_MANIFEST.genesisHash ||
  evidence.depositMint !== SOLANA_DEVNET_MANIFEST.deposit.mint ||
  config.genesisHash !== evidence.genesisHash ||
  config.depositMint !== evidence.depositMint
) throw new Error('The operator faucet source is not pinned to this devnet');
const database = new DatabaseSync(resolve(process.env.LOCAL_DATABASE_PATH || '.data/rental.sqlite'), {
  readOnly: true,
});
const row = database.prepare('SELECT body FROM rental_records WHERE key = ?').get(`agreement:${agreementId}`);
database.close();
const agreement = row ? JSON.parse(row.body) : null;
const digest = agreement && agreementDigest(agreement);
if (
  !agreement || agreement.network !== 'solana' ||
  agreement.requiredSecurity !== '10000000' ||
  agreement.accepted.tenant?.digest !== digest ||
  agreement.accepted.landlord?.digest !== digest
) throw new Error('An accepted 10 test-USDC Solana agreement is required');
const tenant = agreement.parties.tenant.wallet.address;
// This historical operator source holds Circle USDC, not site-owned tUSDC.
const destination = await derivePayoutAddress(tenant, evidence.depositMint);
const source = evidence.tenantUsdcAccount;
const sponsor = await configuredFeeSponsor();
if (!sponsor || new Set([sponsor.address, evidence.tenant, tenant]).size !== 3)
  throw new Error('The source, app tenant and fee sponsor must be separate');
const keyDir = resolve(process.env.SOLANA_TEST_KEYS_DIR || '.testnet-secrets/solana');
const keyBytes = JSON.parse(await readFile(resolve(keyDir, 'tenant-keypair.json'), 'utf8'));
if (!Array.isArray(keyBytes) || keyBytes.length !== 64 ||
    keyBytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
  throw new Error('Invalid ignored operator test key');
const operator = await createKeyPairSignerFromBytes(new Uint8Array(keyBytes));
if (operator.address !== evidence.tenant) throw new Error('Operator key does not match the pinned source');
const gateway = new RpcInitializationGateway(config);
await gateway.checkedGenesis();
async function balances() {
  const observed = await gateway.multiple([source, destination]);
  if (observed.accounts.some((account) => !account))
    throw new Error('A reviewed test token account is missing');
  const [from, to] = observed.accounts.map((account) => decodeClassicTokenAccount(account));
  if (
    from.authority !== evidence.tenant || to.authority !== tenant ||
    from.mint !== config.depositMint || to.mint !== config.depositMint ||
    !from.initialized || !to.initialized || from.frozen || to.frozen
  ) throw new Error('The faucet source or tenant destination changed');
  return { from: BigInt(from.amountAtomic), to: BigInt(to.amountAtomic) };
}
const amount = 10_000_000n;
const pendingPath = resolve(keyDir, 'app-tenant-funding-pending.json');
let pending;
try { pending = JSON.parse(await readFile(pendingPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (pending) {
  if (pending.agreementId !== agreementId || pending.destination !== destination)
    throw new Error('Another app-tenant funding transfer is pending');
  const status = await gateway.rpc('getSignatureStatuses', [
    [pending.signature], { searchTransactionHistory: true },
  ]);
  const receipt = status.value?.[0];
  if (receipt?.err) throw new Error(`Pending transfer failed: ${pending.signature}`);
  if (receipt?.confirmationStatus !== 'finalized') {
    console.log(JSON.stringify({ status: 'pending-or-unknown', signature: pending.signature }));
    process.exit(1);
  }
  const final = await balances();
  if (final.from !== BigInt(pending.sourceBefore) - amount ||
      final.to !== BigInt(pending.destinationBefore) + amount)
    throw new Error('Finalized token balances differ from the signed transfer');
  await unlink(pendingPath);
  console.log(JSON.stringify({ status: 'finalized', signature: pending.signature,
    slot: receipt.slot, destination, tenantTestUsdcAtomic: final.to.toString() }));
  process.exit(0);
}
const before = await balances();
if (before.to >= amount) {
  console.log(JSON.stringify({ status: 'already-funded', destination,
    tenantTestUsdcAtomic: before.to.toString() }));
  process.exit(0);
}
if (before.to !== 0n || before.from < amount)
  throw new Error('Review the changed token balances before transferring faucet funds');
const lifetime = await gateway.lifetime();
let message = setTransactionMessageLifetimeUsingBlockhash(
  {
    blockhash: blockhash(lifetime.blockhash),
    lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
  },
  setTransactionMessageFeePayer(address(sponsor.address), createTransactionMessage({ version: 0 })),
);
const data = new Uint8Array(10);
data[0] = 12; // SPL Token TransferChecked.
new DataView(data.buffer).setBigUint64(1, amount, true);
data[9] = 6;
message = appendTransactionMessageInstruction({
  programAddress: address(SOLANA_IDS.token), data,
  accounts: [
    { address: address(source), role: AccountRole.WRITABLE },
    { address: address(config.depositMint), role: AccountRole.READONLY },
    { address: address(destination), role: AccountRole.WRITABLE },
    { address: address(operator.address), role: AccountRole.READONLY_SIGNER },
  ],
}, message);
const operatorSigned = await partiallySignTransaction([operator.keyPair], compileTransaction(message));
const signed = await sponsor.sign(new Uint8Array(getTransactionEncoder().encode(operatorSigned)));
if (signed.length > 1232) throw new Error('Test-token transfer is too large');
const simulation = await gateway.simulate(signed, sponsor.address, operator.address);
const checked = await gateway.rpc('simulateTransaction', [
  Buffer.from(signed).toString('base64'),
  { encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false, commitment: 'finalized' },
]);
if (checked.value?.err !== null) throw new Error('Signed test-token transfer failed simulation');
const signature = getBase58Decoder().decode(
  getTransactionDecoder().decode(signed).signatures[address(sponsor.address)],
);
console.log(JSON.stringify({ status: send ? 'ready-to-send' : 'simulation-passed',
  agreementId, cluster: 'devnet', source, destination, amountAtomic: amount.toString(),
  sponsorDebitCeilingLamports: simulation.sponsorDebitCeilingLamports, signature }));
if (!send) process.exit(0);
await writeFile(pendingPath, JSON.stringify({ agreementId, destination, signature,
  sourceBefore: before.from.toString(), destinationBefore: before.to.toString(),
  signedTransactionBase64: Buffer.from(signed).toString('base64'),
}) + '\n', { mode: 0o600, flag: 'wx' });
const returned = await gateway.broadcast(signed);
if (returned !== signature) throw new Error('RPC returned a different signature');
for (let attempt = 0; attempt < 40; attempt++) {
  const status = await gateway.rpc('getSignatureStatuses', [
    [signature], { searchTransactionHistory: true },
  ]);
  const receipt = status.value?.[0];
  if (receipt?.err) throw new Error(`Test-token transfer failed: ${signature}`);
  if (receipt?.confirmationStatus === 'finalized') {
    const final = await balances();
    if (final.from !== before.from - amount || final.to !== before.to + amount)
      throw new Error('Finalized token balances differ from the signed transfer');
    await unlink(pendingPath);
    console.log(JSON.stringify({ status: 'finalized', signature, slot: receipt.slot,
      destination, tenantTestUsdcAtomic: final.to.toString() }));
    process.exit(0);
  }
  await delay(1500);
}
throw new Error(`Transfer status unknown; inspect ${signature} before retrying`);
