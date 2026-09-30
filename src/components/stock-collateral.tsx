'use client';
import { useState } from 'react';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const illustrative = (value: number) => `${dollars.format(value)} illustrative test value`;

/** Illustration of the contract's example ratios, not a pledge or price quote. */
export function StockCollateral({ initialDeposit = 1200 }: { initialDeposit?: number }) {
  const [deposit, setDeposit] = useState(String(initialDeposit));
  const [drop, setDrop] = useState('20');
  const [claim, setClaim] = useState('200');
  const security = Math.max(0, Number(deposit) || 0);
  const decline = Math.min(80, Math.max(0, Number(drop) || 0));
  const approvedClaim = Math.min(security, Math.max(0, Number(claim) || 0));
  const pledgedValue = security * 1.5;
  const currentValue = pledgedValue * (1 - decline / 100);
  const maintenance = security * 1.25;
  const buffer = currentValue - security;
  const saleValue = Math.min(currentValue, approvedClaim / 0.98);
  return (
    <details className="stock-collateral">
      <summary>Calculator: how much would a share-backed deposit pledge? · illustration</summary>
      <div className="prototype-content">
        <p className="small-copy">This calculator is an illustration, not a quote or transaction. Shared Robinhood testnet loans and direct lending use wallet signatures; share-backed rental deposits are not offered in the app. These do not replace the cash deposit of a Solana tenancy in Home.</p>
        <div className="collateral-inputs">
          <label>Illustrative test deposit to secure ($)<input type="number" min="1" max="100000" step="1" value={deposit} onChange={(event) => setDeposit(event.target.value)} /></label>
          <label>Example stock price drop (%)<input type="number" min="0" max="80" step="1" value={drop} onChange={(event) => setDrop(event.target.value)} /></label>
          <label>Illustrative approved test claim ($)<input type="number" min="0" max={security} step="1" value={claim} onChange={(event) => setClaim(event.target.value)} /></label>
        </div>
        <dl className="journey-facts">
          <div><dt>Shares pledged at 150%</dt><dd>{illustrative(pledgedValue)}</dd></div>
          <div><dt>After {decline}% price drop</dt><dd>{illustrative(currentValue)}</dd></div>
          <div><dt>Buffer above deposit</dt><dd>{illustrative(buffer)}</dd></div>
        </dl>
        <p>{currentValue < maintenance ? `Below the example 125% maintenance level (${illustrative(maintenance)}): the tenant gets a top-up grace period; after it, a contract-controlled protective sale can secure the test deposit as cash.` : `Above the example 125% maintenance level (${illustrative(maintenance)}); no shortfall flag at this simulated test price.`}</p>
        <p>At an approved claim of {illustrative(approvedClaim)}, the separate test contract sells only enough pledged shares to pay the claim. This is not a way to sell wallet holdings. With illustrative 2% slippage, about {illustrative(saleValue)} in shares could be sold; if proceeds fall short, it sells more (up to the shares held). The rest returns to the tenant in kind{saleValue < approvedClaim ? '; if collateral is exhausted, the landlord bears the remaining shortfall' : ''}.</p>
        <p className="small-copy">Ratios, oracle protection, grace period and sale slippage are contract parameters. This calculator is not a quote, investment advice or an offer; German rental law requires agreement on alternative security.</p>
      </div>
    </details>
  );
}
