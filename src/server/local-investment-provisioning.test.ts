import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executeFundingStep, publishInvestmentManifest, type SignedFundingStep } from './local-investment-provisioning.ts';

const signer = privateKeyToAccount(`0x${'56'.repeat(32)}`);
const recipient = '0x1111111111111111111111111111111111111111' as const;
const missing = () => { const error = new Error('not found'); error.name = 'TransactionReceiptNotFoundError'; return error; };

async function signedFunding(nonce: number) {
  return signer.signTransaction({ type: 'eip1559', chainId: 46630, to: recipient, value: 300_000_000_000_000n,
    nonce, gas: 21_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n });
}

test('funding persists exact signed intent before send and resumes once after a lost response and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'funding-recovery-'));
  const file = join(directory, 'progress.json');
  const step: SignedFundingStep = {};
  let nonce = 0, credited = 0n, connected = false;
  const accepted = new Set<Hex>();
  const sign = async () => signedFunding(nonce++);
  const client = {
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!connected || !accepted.has(hash)) throw missing();
      return { transactionHash: hash, status: 'success' };
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const persisted = JSON.parse(await readFile(file, 'utf8')) as SignedFundingStep;
      assert.equal(persisted.signed, serializedTransaction);
      const hash = keccak256(serializedTransaction);
      if (!accepted.has(hash)) { accepted.add(hash); credited += 300_000_000_000_000n; }
      throw new Error('Controlled lost RPC response after acceptance');
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!connected) throw new Error('Controlled unavailable receipt');
      return { transactionHash: hash, status: 'success' };
    },
  };
  try {
    await assert.rejects(executeFundingStep(step, sign, () => writeFile(file, JSON.stringify(step), { mode: 0o600 }), client), /unavailable receipt/);
    const recovered = JSON.parse(await readFile(file, 'utf8')) as SignedFundingStep;
    connected = true;
    await executeFundingStep(recovered, sign, () => writeFile(file, JSON.stringify(recovered), { mode: 0o600 }), client);
    assert.equal(credited, 300_000_000_000_000n);
    assert.equal(nonce, 1);
    assert.equal(accepted.size, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed funding checkpoint prevents broadcast even when the same in-memory step is retried', async () => {
  const step: SignedFundingStep = {};
  let sends = 0;
  const client = {
    getTransactionReceipt: async () => { throw missing(); },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => { sends++; return keccak256(serializedTransaction); },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: 'success', transactionHash: hash }),
  };
  const persist = async () => { throw new Error('Disk unavailable'); };
  await assert.rejects(executeFundingStep(step, () => signedFunding(0), persist, client), /Disk unavailable/);
  await assert.rejects(executeFundingStep(step, () => signedFunding(1), persist, client), /Disk unavailable/);
  assert.equal(sends, 0);
});

test('an uncertain funding receipt cannot claim success or cause an unobserved transfer retry', async () => {
  let sends = 0;
  const client = {
    getTransactionReceipt: async () => { throw new Error('RPC transport unavailable'); },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => { sends++; return keccak256(serializedTransaction); },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: 'success', transactionHash: hash }),
  };
  await assert.rejects(executeFundingStep({}, () => signedFunding(0), async () => {}, client), /RPC transport unavailable/);
  assert.equal(sends, 0);
});

test('immutable manifest publication leaves a complete first deployment untouched by competing publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manifest-publication-'));
  const file = join(directory, 'manifest.json');
  const first = { version: 1, chainId: 46630, assets: { homes: { unit: recipient } } };
  try {
    await publishInvestmentManifest(file, first);
    await assert.rejects(publishInvestmentManifest(file, { ...first, assets: {} }), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), first);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
