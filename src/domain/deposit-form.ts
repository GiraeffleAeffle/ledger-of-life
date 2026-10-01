import type { Network } from './assets.ts';
import { WorkflowError } from './errors.ts';

export const SHARE_STOCK = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E';
export const SHARE_ORACLE = '0x5196C8713A529bd676B875fB9Cea3F8a47ba48Be';
export const CASH_MINT = 'BCgqGAUvbGobqXrJtEDS437i8r1FffVSGcnwCsHcN2oE';
export type CashDepositForm = { kind: 'cash'; network: Network; mint: string; decimals: number };
export type ShareDepositForm = { kind: 'shares'; chainId: 46630; stock: string; oracle: string; factory: string | null; securityUsd6: string; initialRatioBps: 15000; topUpRatioBps: 12500; responseWindow: number; returnWindow: number; arbitrationWindow: number };
export type DepositForm = CashDepositForm | ShareDepositForm;
export const cashDepositForm = (network: Network = 'solana'): CashDepositForm => ({ kind: 'cash', network, mint: network === 'solana' ? CASH_MINT : '0xA6e10E426A738aEF586dB5191177658D67C78A14', decimals: 6 });
export function shareDepositForm(securityUsd6: string, factory: string | null, input: Record<string, unknown> = {}): ShareDepositForm {
  if (!/^[1-9][0-9]{0,10}$/.test(securityUsd6) || BigInt(securityUsd6) < 1_000_000n || BigInt(securityUsd6) > 10_000_000_000n)
    throw new WorkflowError('The share deposit must be between 1 and 10,000 test USD.');
  if (factory !== null && !/^0x[0-9a-fA-F]{40}$/.test(factory)) throw new WorkflowError('Invalid share-deposit factory.');
  const window = (name: string, fallback: number) => {
    const value = input[name] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 3600 || value > 34_560_000)
      throw new WorkflowError('Deposit windows must be whole seconds between 1 hour and 400 days.');
    return value;
  };
  return { kind: 'shares', chainId: 46630, stock: SHARE_STOCK, oracle: SHARE_ORACLE, factory, securityUsd6, initialRatioBps: 15000, topUpRatioBps: 12500, responseWindow: window('responseWindow', 604800), returnWindow: window('returnWindow', 604800), arbitrationWindow: window('arbitrationWindow', 2592000) };
}

/** Explicit order is part of the v2 acceptance digest, independent of stored JSON key order. */
export function canonicalDeposit(form: DepositForm): DepositForm {
  if (form.kind === 'cash') return { kind: 'cash', network: form.network, mint: form.mint, decimals: form.decimals };
  return { kind: 'shares', chainId: form.chainId, stock: form.stock, oracle: form.oracle, factory: form.factory, securityUsd6: form.securityUsd6, initialRatioBps: form.initialRatioBps, topUpRatioBps: form.topUpRatioBps, responseWindow: form.responseWindow, returnWindow: form.returnWindow, arbitrationWindow: form.arbitrationWindow };
}
