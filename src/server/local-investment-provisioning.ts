import { randomUUID } from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { keccak256, type Hex } from 'viem';

export type SignedFundingStep = { signed?: Hex; hash?: Hex };
type FundingReceipt = { status: string; transactionHash: Hex };
type FundingRpc = {
  getTransactionReceipt(input: { hash: Hex }): Promise<FundingReceipt>;
  sendRawTransaction(input: { serializedTransaction: Hex }): Promise<Hex>;
  waitForTransactionReceipt(input: { hash: Hex; confirmations: number }): Promise<FundingReceipt>;
};

/** One operator-funded step, including recovery after a lost send response or process restart. */
export async function executeFundingStep(step: SignedFundingStep, sign: () => Promise<Hex>, persist: () => Promise<void>, client: FundingRpc): Promise<Hex> {
  if (!step.signed) {
    if (step.hash) throw new Error('Funding journal has a hash without recoverable signed bytes.');
    step.signed = await sign();
    step.hash = keccak256(step.signed);
  }
  const hash = keccak256(step.signed);
  if (step.hash !== hash) throw new Error('Funding journal transaction hash does not match its signed bytes.');
  // Also persist on retry: a caller must not accidentally reuse an in-memory entry after a failed write.
  await persist();
  let observed: FundingReceipt | null = null;
  try { observed = await client.getTransactionReceipt({ hash }); }
  catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error; }
  if (!observed) {
    try { await client.sendRawTransaction({ serializedTransaction: step.signed }); }
    catch { /* Ambiguous send: only the persisted hash may establish success. */ }
  }
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 3 });
  if (receipt.transactionHash !== hash || receipt.status !== 'success') throw new Error(`Funding step has no successful receipt for its persisted transaction: ${hash}`);
  return hash;
}

/** Publish complete immutable bytes atomically, without ever replacing an existing deployment. */
export async function publishInvestmentManifest(filename: string, value: unknown): Promise<void> {
  await mkdir(dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o644);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporary);
    throw error;
  }
  await file.close();
  try { await link(temporary, filename); }
  finally { await unlink(temporary); }
}
