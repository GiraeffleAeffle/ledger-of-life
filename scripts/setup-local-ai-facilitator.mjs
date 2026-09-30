#!/usr/bin/env node
// Explicit --prepare creates a dedicated fee account; explicit --fund signs at most one
// bounded operator-funded testnet transfer. No action is a default, no user wallet is used.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, open, link, unlink, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getStore } from '../src/server/store.ts';
import { acquireOperatorNonceLane, releaseOperatorNonceLane } from '../src/server/operator-nonce-lane.ts';
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress } from '@x402/evm';
import { aiRpc as rpc, assertInferenceContracts } from '../src/server/local-ai-runtime.ts';
import { TEST_USDG_ADDRESS } from '../src/wallets/inference-token.ts';

const mode = process.argv[2];
if (!['--check', '--prepare', '--fund'].includes(mode) || process.argv.length !== 3)
  throw new Error('Usage: node scripts/setup-local-ai-facilitator.mjs --check|--prepare|--fund');
await assertInferenceContracts();
const keyPath = resolve(process.env.LOCAL_AI_FACILITATOR_KEY_FILE || '.testnet-secrets/local-ai/facilitator.key');
const journalPath = resolve('.testnet-secrets/local-ai/facilitator-funding.json');
const manifestPath = resolve('contracts/evm/deployments/local-ai-facilitator-46630.json');
async function existingKey() {
  const metadata = await stat(keyPath);
  if (metadata.mode & 0o077) throw new Error('Facilitator key permissions must be owner-only (0600).');
  const value = (await readFile(keyPath, 'utf8')).trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error('Invalid dedicated facilitator key file.');
  return privateKeyToAccount(value);
}
async function publish(path, contents, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', mode);
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
  try { await link(temp, path); } finally { await unlink(temp); }
}
if (mode === '--prepare') {
  let exists = false;
  try { await stat(keyPath); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!exists) await publish(keyPath, `0x${randomBytes(32).toString('hex')}\n`, 0o600);
}
const account = await existingKey();
let manifest;
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT' || mode === '--check') throw error;
  manifest = { version: 1, chainId: 46630, facilitator: account.address, purpose: 'local-ai-exact-permit2-fee-only',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3', exactProxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
    asset: TEST_USDG_ADDRESS };
  await publish(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o644);
}
if (manifest.version !== 1 || manifest.chainId !== 46630 ||
    manifest.facilitator.toLowerCase() !== account.address.toLowerCase() ||
    manifest.purpose !== 'local-ai-exact-permit2-fee-only' ||
    manifest.permit2.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase() ||
    manifest.exactProxy.toLowerCase() !== x402ExactPermit2ProxyAddress.toLowerCase() ||
    manifest.asset.toLowerCase() !== TEST_USDG_ADDRESS.toLowerCase())
  throw new Error('Dedicated facilitator manifest differs from the reviewed chain, key, token or purpose.');
let balance = await rpc.getBalance({ address: account.address });
console.log(JSON.stringify({ address: account.address, chainId: 46630, nativeGasWei: balance.toString(), manifest: manifestPath }));
if (mode !== '--fund') process.exit(0);
const required = 2_000_000_000_000_000n;
const operatorPath = resolve(process.env.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet', 'operator.key');
const operator = privateKeyToAccount((await readFile(operatorPath, 'utf8')).trim());
if (operator.address.toLowerCase() === account.address.toLowerCase()) throw new Error('Facilitator must not reuse the operator key.');
let journal;
try { journal = JSON.parse(await readFile(journalPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (balance >= required && !journal) { console.log(JSON.stringify({ funding: 'already-sufficient' })); process.exit(0); }
const store = await getStore();
const operation = `local-ai-facilitator-funding:${account.address.toLowerCase()}`;
await acquireOperatorNonceLane(store, operator.address, operation);
let signedPersisted = !!journal;
try {
if (!journal) {
  const [nonce, latest, fees, operatorGas, estimatedGas] = await Promise.all([
    rpc.getTransactionCount({ address: operator.address, blockTag: 'pending' }),
    rpc.getTransactionCount({ address: operator.address, blockTag: 'latest' }),
    rpc.estimateFeesPerGas(), rpc.getBalance({ address: operator.address }),
    rpc.estimateGas({ account: operator.address, to: account.address, value: required }),
  ]);
  const gas = (estimatedGas * 12n + 9n) / 10n;
  if (nonce !== latest || !fees.maxFeePerGas || fees.maxFeePerGas > 100000000000n ||
      estimatedGas < 21000n || gas > 500000n || operatorGas < required + fees.maxFeePerGas * gas)
    throw new Error('Operator nonce busy, fee estimate unsafe, or insufficient testnet native gas. No funding was sent.');
  const signed = await operator.signTransaction({ type: 'eip1559', chainId: 46630, to: account.address,
    value: required, nonce, gas, maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n });
  journal = { version: 1, from: operator.address, to: account.address, amountWei: required.toString(), signed,
    hash: keccak256(signed), nonce, gasLimit: gas.toString() };
  await publish(journalPath, `${JSON.stringify(journal)}\n`, 0o600);
  signedPersisted = true;
}
const parsed = parseTransaction(journal.signed);
if (journal.version !== 1 || journal.from.toLowerCase() !== operator.address.toLowerCase() ||
    journal.to.toLowerCase() !== account.address.toLowerCase() || journal.amountWei !== required.toString() ||
    keccak256(journal.signed) !== journal.hash || parsed.chainId !== 46630 || parsed.type !== 'eip1559' ||
    parsed.to?.toLowerCase() !== account.address.toLowerCase() || parsed.value !== required ||
    parsed.nonce !== journal.nonce || parsed.gas !== BigInt(journal.gasLimit) ||
    parsed.gas < 21000n || parsed.gas > 500000n || (parsed.data ?? '0x') !== '0x' ||
    (await recoverTransactionAddress({ serializedTransaction: journal.signed })).toLowerCase() !== operator.address.toLowerCase())
  throw new Error('Existing funding journal does not match this bounded fee transfer.');
let receipt;
try { receipt = await rpc.getTransactionReceipt({ hash: journal.hash }); } catch { /* indeterminate */ }
if (!receipt) {
  try { await rpc.sendRawTransaction({ serializedTransaction: journal.signed }); } catch { /* same bytes only */ }
}
try { receipt = await rpc.waitForTransactionReceipt({ hash: journal.hash, confirmations: 3, timeout: 30000 }); }
catch {
  console.log(JSON.stringify({ funding: 'pending', hash: journal.hash }));
  await store.close();
  process.exit(0);
}
const [tx, block, tip] = await Promise.all([
  rpc.getTransaction({ hash: journal.hash }), rpc.getBlock({ blockNumber: receipt.blockNumber }), rpc.getBlockNumber(),
]);
if (receipt.status !== 'success' || receipt.transactionHash !== journal.hash || tx.hash !== journal.hash ||
    !block.hash || block.hash !== receipt.blockHash || tx.blockHash !== receipt.blockHash ||
    tip < receipt.blockNumber + 2n || tx.chainId !== 46630 || tx.nonce !== journal.nonce ||
    tx.gas !== parsed.gas || tx.maxFeePerGas !== parsed.maxFeePerGas ||
    (tx.maxPriorityFeePerGas ?? 0n) !== (parsed.maxPriorityFeePerGas ?? 0n) ||
    tx.to?.toLowerCase() !== account.address.toLowerCase() || tx.from.toLowerCase() !== operator.address.toLowerCase() ||
    tx.value !== required || (tx.input ?? '0x') !== '0x')
  throw new Error('Funding receipt does not prove the confirmed canonical journaled transfer.');
balance = await rpc.getBalance({ address: account.address });
console.log(JSON.stringify({ funding: 'confirmed', hash: journal.hash, nativeGasWei: balance.toString() }));
await releaseOperatorNonceLane(store, operator.address, operation);
await store.close();
} catch (error) {
  if (!signedPersisted) await releaseOperatorNonceLane(store, operator.address, operation);
  await store.close();
  throw error;
}
