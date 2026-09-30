'use client';
import { useState } from 'react';
import { useRentalWallet } from '@/wallets';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Prepared = { walletId: string; description: string; expiresAt: string; transaction: { chainId: 46630; to: string; data: string; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } };
type MintResult = { hash: string; status: 'pending' } | { hash: string; status: 'confirmed'; testUsdAtomic: string };
export function TestDollars({ request, ethBalance, refresh }: { request: Request; ethBalance?: string; refresh: () => Promise<void> }) {
  const wallet = useRentalWallet();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
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
        : `Test dollars received. Balance: ${(Number(result.testUsdAtomic) / 1e6).toLocaleString()} tUSDG (no value).`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Test dollars were not confirmed. Please check your balance.'); }
    finally { window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } })); setPending(false); }
  }
  return <div>
    <p>Robinhood testnet · 1,000 tUSDG per request · no value. You sign with your own wallet. Wait one minute between requests; sign within two minutes.</p>
    {ethBalance !== undefined && Number(ethBalance) === 0 && <p role="status">No test ETH for network fees. Use the faucet first.</p>}
    <p>The <a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Robinhood faucet</a> gives test ETH for fees and official test TSLA (no value).</p>
    <button type="button" className="button primary" disabled={pending || !hasWallet} onClick={() => { void mint(); }}>{pending ? 'Getting test dollars…' : 'Get test dollars (tUSDG, no value)'}</button>
    {!hasWallet && <p>Connect your Robinhood Chain wallet in Me.</p>}
    {error && <p role="alert" className="note">{error}</p>}
    {success && <><p role="status" className="note">{success}</p><button type="button" className="text-button" disabled={pending} onClick={() => { void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Balance unavailable. Try refreshing again later.')); }}>Refresh balance</button></>}
  </div>;
}
