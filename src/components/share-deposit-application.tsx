'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRentalWallet } from '@/wallets';
import { depositShares, depositUsd } from './share-deposit';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type ListingQuote = {
  deployment: 'deployed' | 'not_deployed'; requiredShares: string | null; walletShares: string | null;
  walletAddress: string | null; network?: 'solana-devnet'; decimals?: 6 | 18;
  quote: { priceUsd6: string; sourceTime: number; copiedAt: number | null; fresh: boolean } | null;
};
export function ShareDepositApplication({ listingId, request, network }: { listingId: string; request: Request; network?: 'solana-devnet' }) {
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
  const solana = network === 'solana-devnet';
  const decimals = solana ? 6 : 18;
  const hasWallet = view !== null && view.network === network && wallet.wallets.some(item => item.chainType === (solana ? 'solana' : 'ethereum') && item.connected && (solana ? item.address === view.walletAddress : item.address.toLowerCase() === view.walletAddress?.toLowerCase()));
  return <div className="small-copy">
    <p>Apply with your verified {solana ? 'Solana wallet on devnet' : 'EVM wallet on Robinhood Chain testnet'}. The server verifies that wallet before recording your application.</p>
    {error && <p role="alert">{error}</p>}
    <p>You need {view?.requiredShares ? depositShares(view.requiredShares, decimals) : 'a fresh quote to calculate the required'} test TSLA at 150 %; you hold {view?.walletShares === null || !view ? 'an unavailable amount' : depositShares(view.walletShares, decimals)}.</p>
    {view?.quote?.fresh && <p>Price {depositUsd(view.quote.priceUsd6)} USD per TSLA · source {new Date(view.quote.sourceTime * 1000).toLocaleString()} · copied {view.quote.copiedAt ? new Date(view.quote.copiedAt * 1000).toLocaleString() : 'unavailable'}.</p>}
    {solana ? <p>Fictional test shares on Solana devnet have 6 decimals, no value and no rights. Go to <Link href="/?area=money">Money</Link> → Get test money → Test TSLA on Solana (5 per verified account per 24 hours; shared daily limit). Applying does not fund the deposit; the site sponsors fees when you fund it.</p> : <p><a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Get official test TSLA from Robinhood&apos;s faucet</a> (5 per claim; no value). Applying does not fund the deposit.</p>}
    {view?.deployment === 'not_deployed' && <p>Share deposit not deployed yet.</p>}
    {!hasWallet && <p>A connected, verified {solana ? 'Solana' : 'EVM'} wallet is required. Complete your wallet setup in Me.</p>}
    <button className="button primary" disabled={view?.deployment !== 'deployed' || !hasWallet || !view.quote?.fresh || view.requiredShares === null || view.walletShares === null}>Send application</button>
  </div>;
}
