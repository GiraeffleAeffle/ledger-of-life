#!/usr/bin/env node
// Operator-only devnet deployment. The sole argument is a keypair PATH, not key bytes.
import { chmod, access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddressDecoder } from '@solana/kit';
import { houseAddresses, decodeHouse } from '../../src/finance/solana/house.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../../src/finance/solana/manifest.ts';

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0]) throw new Error('Usage: scripts/solana/deploy-house.sh <deployer-keypair-path>');
const deployerPath = resolve(args[0]);
const programId = 'CWUN8LKoKNEBJ6SQAVAqDFrb3rDP7vbVXMcf2EoAqjQM';
const admin = 'HEZ9ERxb1W9WfBjUGE6A4jFZU3jUMJRSM1kyERgac38G';
const rpcUrl = 'https://api.devnet.solana.com';
const programPath = join(homedir(), '.config/solana/house-program.json');
const bufferPath = join(homedir(), '.config/solana/house-buffer.json');
const binaryPath = fileURLToPath(new URL('../../target/deploy/house.so', import.meta.url));
const binary = await readFile(binaryPath);
async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json(); if (body.error) throw new Error(JSON.stringify(body.error)); return body.result;
}
const genesis = await rpc('getGenesisHash');
if (genesis !== SOLANA_DEVNET_MANIFEST.genesisHash) throw new Error('Refusing mainnet or unknown network: pinned Solana devnet required');
const deployer = execFileSync('solana-keygen', ['pubkey', deployerPath], { encoding: 'utf8' }).trim();
if (deployer !== admin) throw new Error('Wrong deployment authority');
const programKey = execFileSync('solana-keygen', ['pubkey', programPath], { encoding: 'utf8' }).trim();
if (programKey !== programId) throw new Error('Wrong house program keypair address');
const accountOptions = { encoding: 'base64', commitment: 'finalized' };
const deployed = (await rpc('getAccountInfo', [programId, accountOptions])).value;
let deploymentSignature;
if (deployed) {
  if (!deployed.executable || deployed.owner !== 'BPFLoaderUpgradeab1e11111111111111111111111') throw new Error('Unexpected existing house program account');
  const programBytes = Buffer.from(deployed.data[0], 'base64');
  const programDataAddress = getAddressDecoder().decode(programBytes.subarray(4, 36));
  const programData = (await rpc('getAccountInfo', [programDataAddress, accountOptions])).value;
  if (!programData || programData.owner !== deployed.owner) throw new Error('Program data unavailable');
  const bytes = Buffer.from(programData.data[0], 'base64');
  if (bytes[12] !== 1 || getAddressDecoder().decode(bytes.subarray(13, 45)) !== admin) throw new Error('Unexpected upgrade authority');
  if (!bytes.subarray(45, 45 + binary.length).equals(binary) || bytes.subarray(45 + binary.length).some(n => n !== 0)) throw new Error('Existing on-chain program differs from reviewed binary; refusing implicit upgrade');
  console.log(`House program already deployed: ${programId}`);
  try {
    const evidence = JSON.parse(await readFile(new URL('../../docs/evidence/SOLANA_HOUSE_DEVNET_DEPLOYMENT_2026-10-05.json', import.meta.url), 'utf8'));
    if (evidence.programId === programId) deploymentSignature = evidence.deploymentSignature;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const houses = await Promise.all(['neighbourhood-homes', 'workshop'].map(id => houseAddresses(id, programId)));
const rows = (await rpc('getMultipleAccounts', [houses.map(h => h.house), accountOptions])).value;
let missing = 0;
for (let index = 0; index < rows.length; index++) {
  const row = rows[index]; if (!row) { missing++; continue; }
  const h = decodeHouse(Buffer.from(row.data[0], 'base64'));
  if (row.owner !== programId || h.admin !== admin || h.cashMint !== SOLANA_TEST_USDC_MINT || h.unitMint !== houses[index].unitMint || h.id !== ['neighbourhood-homes', 'workshop'][index] || h.priceCashPerUnit !== 1_000_000n || h.sellCapUnits !== 100_000_000n || h.rewardDuration !== 604_800n) throw new Error('Existing initialized house differs from manifest');
}
let required = 0;
if (missing > 0) {
  const rents = await Promise.all([314, 82, 165].map(size => rpc('getMinimumBalanceForRentExemption', [size])));
  required = missing * (rents[0] + rents[1] + 3 * rents[2] + 5000) + 1_000_000;
}
if (!deployed) {
  const rents = await Promise.all([2 * binary.length + 45, binary.length + 37, 36].map(size => rpc('getMinimumBalanceForRentExemption', [size])));
  required = Math.max(6_200_000_000, required + rents.reduce((sum, n) => sum + n, 0) + 50_000_000);
}
const balance = (await rpc('getBalance', [admin, { commitment: 'confirmed' }])).value;
console.log(`Devnet deployer ${admin}: ${balance} lamports; required ${required} lamports`);
if (balance < required) throw new Error(`Insufficient devnet SOL: need at least ${required / 1_000_000_000} SOL before deploying/initializing; no transaction sent`);
if (process.env.HOUSE_DEPLOY_DRY_RUN === '1') { console.log('Dry run: genesis, addresses, binary and funding verified; no transaction sent'); process.exit(0); }
if (!deployed) {
  try { await access(bufferPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    execFileSync('solana-keygen', ['new', '--silent', '--no-bip39-passphrase', '-o', bufferPath], { stdio: 'inherit' });
  }
  await chmod(bufferPath, 0o600);
  const output = execFileSync('solana', ['--output', 'json', 'program', 'deploy', '-u', 'devnet', '--keypair', deployerPath, '--program-id', programPath, '--buffer', bufferPath, binaryPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const result = JSON.parse(output);
  if (result.programId !== programId || typeof result.signature !== 'string') throw new Error('Unexpected deployment response');
  deploymentSignature = result.signature;
  console.log(`House program deployed: ${programId}; signature ${deploymentSignature}`);
}
execFileSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./house-initialize.mjs', import.meta.url)), deployerPath, binaryPath, ...(deploymentSignature ? [deploymentSignature] : [])], { stdio: 'inherit' });
