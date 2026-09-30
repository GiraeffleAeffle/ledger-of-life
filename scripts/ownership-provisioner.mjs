#!/usr/bin/env node
// Robinhood TESTNET only. Provisioning never runs during GET or workspace browsing.
// prepare creates a private dedicated key; check is read-only; fund --send is an explicit operator transaction.
import { readFile, mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPublicClient, defineChain, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { executeFundingStep } from '../src/server/local-investment-provisioning.ts';
import { operatorTestCapability } from '../src/server/test-capability.ts';
import { publishProvisionerJournal, readProvisionerJournal } from '../src/server/ownership-funding-journal.ts';
import { reviewedOperatorFees, reviewedOperatorGas } from '../src/server/ownership-gas.ts';

const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } }, testnet: true });
const rpc = createPublicClient({ chain, transport: http() });
const keyFile = resolve(process.env.ROBINHOOD_OWNERSHIP_PROVISIONER_KEY_FILE || '.testnet-secrets/robinhood-testnet/ownership-provisioner.key');
const operatorFile = resolve(process.env.ROBINHOOD_TEST_KEYS_DIR || '.testnet-secrets/robinhood-testnet', 'operator.key');
const journalFile = resolve(dirname(keyFile), 'ownership-provisioner-funding.json');
// One explicit small test-gas budget; the API never tops it up from the shared operator.
const funding = 1_000_000_000_000_000n;
async function accountFrom(filename) {
  if ((await stat(filename)).mode & 0o077) throw new Error('A test signer file must be owner-only (chmod 600).');
  return privateKeyToAccount((await readFile(filename, 'utf8')).trim());
}
async function checkpoint(entry) {
  await mkdir(dirname(journalFile), { recursive: true, mode: 0o700 });
  const temporary = `${journalFile}.${process.pid}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(entry)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, journalFile);
  const directory = await open(dirname(journalFile), 'r');
  try { await directory.sync(); }
  finally { await directory.close(); }
}
class FundingReservationLost extends Error {
  constructor(winner) { super('A concurrent funding reservation won; reconciling its exact signed transaction.'); this.winner = winner; }
}
const command = process.argv[2];
if (!operatorTestCapability()) throw new Error('Dedicated ownership provisioning requires approved test mode.');
if (command === 'prepare') {
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  try {
    const file = await open(keyFile, 'wx', 0o600);
    try { await file.writeFile(`${generatePrivateKey()}\n`); await file.sync(); }
    finally { await file.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const account = await accountFrom(keyFile);
  console.log(JSON.stringify({ state: 'prepared', address: account.address }));
} else if (command === 'check' || command === 'fund') {
  const account = await accountFrom(keyFile);
  if (await rpc.getChainId() !== 46630) throw new Error('Robinhood testnet chain ID required.');
  const balance = await rpc.getBalance({ address: account.address });
  if (command === 'check') {
    console.log(JSON.stringify({ address: account.address, nativeBalanceWei: balance.toString(), ready: balance >= funding }));
  } else {
    if (!process.argv.includes('--send')) throw new Error('Explicit fund --send required; check remains read-only.');
    const signer = await accountFrom(operatorFile);
    if (signer.address.toLowerCase() === account.address.toLowerCase()) throw new Error('Provisioner cannot use the shared operator key.');
    const signedFile = `${journalFile}.signed`;
    let journal = (await readProvisionerJournal(signedFile)) ?? (await readProvisionerJournal(journalFile));
    function validate(entry) {
      if (entry && (entry.recipient !== account.address || entry.operator !== signer.address || entry.amountWei !== funding.toString()))
        throw new Error('Funding reservation belongs to a different signer or amount.');
    }
    validate(journal);
    if (!journal) {
      if (balance !== 0n) throw new Error('Provisioner already has native gas; refusing a second or unknown grant.');
      journal = await publishProvisionerJournal(journalFile, { recipient: account.address, operator: signer.address, amountWei: funding.toString(), step: {} });
      validate(journal);
    }
    async function reconcile(entry, sign) {
      return executeFundingStep(entry.step, sign, async () => {
        const winner = await publishProvisionerJournal(signedFile, { ...entry, step: { ...entry.step } });
        validate(winner);
        if (winner.step.signed !== entry.step.signed || winner.step.hash !== entry.step.hash)
          throw new FundingReservationLost(winner);
        // Keep the existing fsynced progress mirror; the immutable .signed file is authoritative.
        await checkpoint(winner);
      }, rpc);
    }
    let hash;
    try {
      hash = await reconcile(journal, async () => {
        const [pending, latest, fees, estimate] = await Promise.all([
          rpc.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
          rpc.getTransactionCount({ address: signer.address, blockTag: 'latest' }),
          rpc.estimateFeesPerGas(),
          rpc.estimateGas({ account: signer.address, to: account.address, value: funding }),
        ]);
        if (pending !== latest) throw new Error('The shared operator has an unresolved nonce; reconcile it before explicitly funding this signer.');
        return signer.signTransaction({ type: 'eip1559', chainId: 46630, to: account.address, value: funding,
          nonce: latest, gas: reviewedOperatorGas(estimate, 'transfer'), ...reviewedOperatorFees(fees) });
      });
    } catch (error) {
      const winner = error instanceof FundingReservationLost ? error.winner : await readProvisionerJournal(signedFile);
      if (!winner?.step?.signed || winner.step.signed === journal.step.signed) throw error;
      validate(winner);
      hash = await reconcile(winner, async () => { throw new Error('The winning envelope is missing its recoverable signature.'); });
    }
    console.log(JSON.stringify({ state: 'funded', address: account.address, hash }));
  }
} else throw new Error('Usage: prepare | check | fund --send');
