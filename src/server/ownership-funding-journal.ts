import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SignedFundingStep } from './local-investment-provisioning.ts';

export type ProvisionerFundingJournal = { recipient: string; operator: string; amountWei: string; step: SignedFundingStep };

export async function readProvisionerJournal(filename: string): Promise<ProvisionerFundingJournal | null> {
  try { return JSON.parse(await readFile(filename, 'utf8')) as ProvisionerFundingJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** fsync the immutable bytes before linking them to the final name, never replacing a winner. */
export async function publishProvisionerJournal(filename: string, value: ProvisionerFundingJournal): Promise<ProvisionerFundingJournal> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const dir = await open(dirname(filename), 'r');
    try { await dir.sync(); }
    finally { await dir.close(); }
  } finally { await unlink(temporary); }
  return (await readProvisionerJournal(filename))!;
}
