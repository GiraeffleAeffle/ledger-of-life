'use client';
import { useEffect, useState } from 'react';
import { useRentalWallet } from '@/wallets';
import { depositShares, depositUsd } from './share-deposit';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type ListingQuote = {
  deployment: 'deployed' | 'not_deployed'; requiredShares: string | null; walletShares: string | null;
  walletAddress: string | null;
  quote: { priceUsd6: string; sourceTime: number; copiedAt: number | null; fresh: boolean } | null;
};
export function ShareDepositApplication({ listingId, request }: { listingId: string; request: Request }) {
  const wallet = useRentalWallet();
  const [view, setView] = useState<ListingQuote | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void request<ListingQuote>(`/api/share-deposit?listingId=${encodeURIComponent(listingId)}`)
      .then(result => { if (active) { setView(result); setError(''); } })
      .catch(() => { if (active) { setView(null); setError('TSLA quote and verified wallet holdings unavailable.'); } });
    return () => { active = false; };
  }, [request, listingId]);
  const hasWallet = wallet.wallets.some(item => item.chainType === 'ethereum' && item.connected && item.address.toLowerCase() === view?.walletAddress?.toLowerCase());
  return <div className="small-copy">
    <p>Apply with your verified EVM wallet. The server verifies that wallet before recording your application.</p>
    {error && <p role="alert">{error}</p>}
    <p>You need {view?.requiredShares ? depositShares(view.requiredShares) : 'a fresh quote to calculate the required'} test TSLA at 150 %; you hold {view?.walletShares === null || !view ? 'an unavailable amount' : depositShares(view.walletShares)}.</p>
    {view?.quote?.fresh && <p>Price {depositUsd(view.quote.priceUsd6)} USD per TSLA · source {new Date(view.quote.sourceTime * 1000).toLocaleString()} · copied {view.quote.copiedAt ? new Date(view.quote.copiedAt * 1000).toLocaleString() : 'unavailable'}.</p>}
    <p><a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Get official test TSLA from Robinhood&apos;s faucet</a> (5 per claim; no value). Applying does not fund the deposit.</p>
    {view?.deployment === 'not_deployed' && <p>Share deposit not deployed yet.</p>}
    {!hasWallet && <p>A connected, verified EVM wallet is required. Complete your wallet setup in Me.</p>}
    <button className="button primary" disabled={view?.deployment !== 'deployed' || !hasWallet || !view.quote?.fresh || view.requiredShares === null || view.walletShares === null}>Send application</button>
  </div>;
}
