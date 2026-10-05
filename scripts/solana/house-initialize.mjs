#!/usr/bin/env node
// Operator-only devnet initialization; fictional units carry no value or rights.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { address, appendTransactionMessageInstruction, blockhash, compileTransaction, createKeyPairSignerFromBytes, createTransactionMessage, getTransactionEncoder, partiallySignTransaction, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { houseAddresses, initializeHouseInstruction, decodeHouse } from '../../src/finance/solana/house.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../../src/finance/solana/manifest.ts';
const [keypairPath, binaryPath, deploymentSignature] = process.argv.slice(2);
if (!keypairPath || !binaryPath) throw new Error('Usage: node --experimental-strip-types scripts/solana/house-initialize.mjs <deployer-keypair-path> <house.so-path> [deployment-signature]');
const rpcUrl = 'https://api.devnet.solana.com';
const programId = 'CWUN8LKoKNEBJ6SQAVAqDFrb3rDP7vbVXMcf2EoAqjQM';
const admin = 'HEZ9ERxb1W9WfBjUGE6A4jFZU3jUMJRSM1kyERgac38G';
async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const data = await response.json(); if (data.error) throw new Error(JSON.stringify(data.error)); return data.result;
}
if (await rpc('getGenesisHash') !== SOLANA_DEVNET_MANIFEST.genesisHash) throw new Error('Refusing non-devnet network');
const deployed = (await rpc('getAccountInfo', [programId, { encoding: 'base64', commitment: 'finalized' }])).value;
if (!deployed?.executable || deployed.owner !== 'BPFLoaderUpgradeab1e11111111111111111111111') throw new Error('House program is not deployed');
const programData = new Uint8Array(Buffer.from(deployed.data[0], 'base64'));
const { getAddressDecoder } = await import('@solana/kit');
const programDataAddress = getAddressDecoder().decode(programData.slice(4, 36));
const programDataRow = (await rpc('getAccountInfo', [programDataAddress, { encoding: 'base64', commitment: 'finalized' }])).value;
const programDataBytes = new Uint8Array(Buffer.from(programDataRow.data[0], 'base64'));
if (programDataBytes[12] !== 1 || getAddressDecoder().decode(programDataBytes.slice(13, 45)) !== admin) throw new Error('Unexpected upgrade authority');
const binary = await readFile(resolve(binaryPath));
if (!Buffer.from(programDataBytes.slice(45, 45 + binary.length)).equals(binary) || programDataBytes.slice(45 + binary.length).some(byte => byte !== 0)) throw new Error('Deployed program bytes differ from reviewed house.so');
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(resolve(keypairPath), 'utf8'))));
if (signer.address !== admin) throw new Error('Wrong devnet deployer');
const manifest = { cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, programId, cashMint: SOLANA_TEST_USDC_MINT, houses: {} };
const inits = {};
const evidencePath = new URL('../../docs/evidence/SOLANA_HOUSE_DEVNET_DEPLOYMENT_2026-10-05.json', import.meta.url);
let previousEvidence;
try { previousEvidence = JSON.parse(await readFile(evidencePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const id of ['neighbourhood-homes', 'workshop']) {
  const a = await houseAddresses(id, programId); manifest.houses[id] = a;
  const existing = (await rpc('getAccountInfo', [a.house, { encoding: 'base64', commitment: 'finalized' }])).value;
  if (existing) {
    const h = decodeHouse(Buffer.from(existing.data[0], 'base64'));
    if (existing.owner !== programId || h.admin !== admin || h.cashMint !== SOLANA_TEST_USDC_MINT || h.id !== id || h.priceCashPerUnit !== 1_000_000n || h.sellCapUnits !== 100_000_000n || h.rewardDuration !== 604_800n) throw new Error('Existing house differs from reviewed initialization');
    const savedSignature = previousEvidence?.programId === programId ? previousEvidence.houses?.[id]?.initSignature : undefined;
    if (savedSignature) {
      const tx = await rpc('getTransaction', [savedSignature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
      if (tx?.meta?.err === null && tx.meta.logMessages?.includes('Program log: Instruction: InitializeHouse')) inits[id] = savedSignature;
    }
    let before;
    while (!inits[id]) {
      const signatures = await rpc('getSignaturesForAddress', [a.house, { limit: 100, commitment: 'finalized', ...(before ? { before } : {}) }]);
      if (signatures.length === 0) throw new Error('Existing house has no observed initialization signature');
      for (const row of signatures) {
        if (row.err !== null) continue;
        const tx = await rpc('getTransaction', [row.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
        if (tx?.meta?.err === null && tx.meta.logMessages?.includes('Program log: Instruction: InitializeHouse')) { inits[id] = row.signature; break; }
      }
      before = signatures.at(-1).signature;
    }
    console.log(`${id} already initialized: ${a.house}; signature ${inits[id]}`); continue;
  }
  const instruction = await initializeHouseInstruction({ admin, cashMint: SOLANA_TEST_USDC_MINT, id, priceCashPerUnit: 1_000_000n, sellCapUnits: 100_000_000n, programId });
  const latest = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  let message = createTransactionMessage({ version: 0 }); message = setTransactionMessageFeePayer(address(admin), message); message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(latest.blockhash), lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) }, message); message = appendTransactionMessageInstruction(instruction, message);
  const signed = await partiallySignTransaction([signer.keyPair], compileTransaction(message)); const wire = Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
  const simulation = await rpc('simulateTransaction', [wire, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]); if (simulation.value.err) throw new Error(JSON.stringify(simulation.value));
  const signature = await rpc('sendTransaction', [wire, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  for (;;) {
    const result = (await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0];
    if (result?.err) throw new Error(JSON.stringify(result.err)); if (result?.confirmationStatus === 'finalized') break;
    if (await rpc('getBlockHeight', [{ commitment: 'finalized' }]) > latest.lastValidBlockHeight) throw new Error(`Initialization lifetime expired; inspect ${signature} before retrying`);
    await delay(1500);
  }
  inits[id] = signature; console.log(`${id}: ${signature}`);
}
const evidence = {
  recordedAt: new Date().toISOString(), network: 'solana-devnet',
  testAssetsOnly: true, unitsCarryNoRights: true, depositEarningsBelongToTenant: true,
  programId, programDataAddress, programSha256: createHash('sha256').update(binary).digest('hex'),
  programDataSha256: createHash('sha256').update(programDataBytes).digest('hex'),
  deployedCodeSha256: createHash('sha256').update(programDataBytes.slice(45, 45 + binary.length)).digest('hex'),
  programDataLength: programDataBytes.length, deployedBytesVerified: true, upgradeAuthority: admin,
  deploymentSignature: deploymentSignature ?? null, genesisHash: manifest.genesisHash, cashMint: manifest.cashMint,
  rewards: {
    scheme: 'staking_stream_v1', durationSeconds: 604800, scale: '1000000000000',
    idleRevenue: 'carry_then_stream_over_fresh_window_never_lump_sum',
    rounding: 'global_and_position_scaled_remainders', fullExitFraction: 'recycle_without_extending_active_finish',
  },
  houses: Object.fromEntries(Object.entries(manifest.houses).map(([id, a]) => [id, {
    ...a, symbol: id === 'workshop' ? 'tWORK' : 'tHOME', priceCashPerUnit: '1000000',
    sellCapUnits: '100000000', rewardDuration: '604800', initSignature: inits[id],
  }])),
  manifest,
};
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
const cacheDir = join(homedir(), '.cache/ledger-solana');
await mkdir(cacheDir, { recursive: true });
await writeFile(join(cacheDir, 'house-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`SOLANA_HOUSE_MANIFEST=${JSON.stringify(manifest)}`);
