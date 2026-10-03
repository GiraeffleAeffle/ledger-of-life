'use client';
import { useEffect, useState } from 'react';
import { belowGasDripThreshold } from '@/domain/gas-threshold';
import { useRentalWallet } from '@/wallets';
import { useSectionTabActive } from './section-tabs';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Prepared = { walletId: string; description: string; expiresAt: string; transaction: { chainId: 46630; to: string; data: string; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } };
type MintResult = { hash: string; status: 'pending' } | { hash: string; status: 'confirmed'; testUsdAtomic: string };
export function TestDollars({ request, ethBalance, refresh, needDollars = true }: { request: Request; ethBalance?: string; refresh: () => Promise<void>; needDollars?: boolean }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [dripConfigured, setDripConfigured] = useState(false);
  const [gettingGas, setGettingGas] = useState(false);
  // The server drips below 0.00001 ETH, so the button appears for the same balances (not only at exactly zero).
  const noGas = ethBalance === undefined || belowGasDripThreshold(ethBalance);
  useEffect(() => {
    if (!activeTab) return;
    let active = true;
    void request<{ configured: boolean }>('/api/assets', { action: 'gas_drip_status' })
      .then((result) => { if (active) setDripConfigured(result.configured); })
      .catch(() => { if (active) setDripConfigured(false); });
    return () => { active = false; };
  }, [request, activeTab]);
  async function getGas() {
    if (pending) return;
    setPending(true); setGettingGas(true); setError(''); setSuccess('');
    try {
      const result = await request<{ status: 'confirmed' | 'pending' | 'unconfigured' | 'sufficient_balance'; hash?: string }>('/api/assets', { action: 'gas_drip' });
      if (result.status === 'unconfigured') {
        setDripConfigured(false);
        setError('Site test ETH is not configured. Use the Robinhood faucet.');
      } else {
        setSuccess(result.status === 'pending'
          ? `Test ETH transfer pending (${result.hash}). Refresh your balance after confirmation.`
          : 'Your wallet has test ETH for fees. Continue your selected Robinhood task.');
        await refresh();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Test ETH was not confirmed. Use the faucet or try again.'); }
    finally { window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } })); setPending(false); setGettingGas(false); }
  }
  const hasWallet = wallet.wallets.some((item) => item.chainType === 'ethereum');
  async function mint() {
    if (pending) return;
    setPending(true); setError(''); setSuccess('');
    try {
      const prepared = await request<Prepared>('/api/assets', { action: 'test_dollars_prepare' });
      const signed = await wallet.signEvmTransaction({ operationId: `test-dollars-${prepared.transaction.nonce}`, walletId: prepared.walletId, description: prepared.description, expiresAt: prepared.expiresAt, transaction: prepared.transaction });
      const result = await request<MintResult>('/api/assets', { action: 'test_dollars_submit', signed });
      setSuccess(result.status === 'pending'
        ? `Test dollar mint submitted and still pending (${result.hash}). Refresh your balance later; do not submit another mint yet.`
        : `Test dollars received. Balance: ${(Number(result.testUsdAtomic) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} tUSDG.`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Test dollars were not confirmed. Please check your balance.'); }
    finally { window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } })); setPending(false); }
  }
  return <div>
    {noGas && dripConfigured && <button type="button" className="button primary" disabled={pending || !hasWallet} onClick={() => { void getGas(); }}>{gettingGas ? 'Getting test ETH…' : 'Get test ETH for fees from this site'}</button>}
    {noGas && <p role="status">First get a little test ETH for fees: <a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Robinhood faucet ↗</a>.</p>}
    {noGas && dripConfigured && <small>Site fee allowance: 0.00005 test ETH per account and wallet every 24 hours; 200 transfers per UTC day.</small>}
    {needDollars && <button type="button" className="button primary" disabled={pending || !hasWallet || noGas} onClick={() => { void mint(); }}>{pending && !gettingGas ? 'Getting test dollars…' : 'Get test dollars'}</button>}
    {needDollars && <small>1,000 tUSDG per request · wait one minute between requests · sign within two minutes.</small>}
    {!hasWallet && <p>Connect your Shares wallet in Me.</p>}
    {error && <p role="alert" className="note">{error}</p>}
    {success && <><p role="status" className="note">{success}</p><button type="button" className="text-button" disabled={pending} onClick={() => { void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Balance unavailable. Try refreshing again later.')); }}>Refresh balance</button></>}
  </div>;
}
