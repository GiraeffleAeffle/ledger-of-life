'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { parseAmount } from '@/domain/assets';
import { useRentalWallet } from '@/wallets';
import { defaultBuyAmount, usd } from './money-valuation';
import { TEST_EXIT_NOTICE } from './money-guidance';
import './robinhood-buy.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type BuyStep = { description: string; transaction: { chainId: 46630; to: string; data: string; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } };
type Prepared = { walletId: string; quote: { spendAtomic: string; tslaRaw: string }; steps: BuyStep[] };

export function RobinhoodBuy({ request, testUsdAtomic, pausedReason, debtUsd, blocksExampleShares, onPrepareExamples }: {
  request: Request; testUsdAtomic: string; pausedReason: string; debtUsd: number;
  blocksExampleShares: boolean; onPrepareExamples: () => void;
}) {
  const wallet = useRentalWallet();
  const balance = BigInt(testUsdAtomic);
  const [amount, setAmount] = useState(() => defaultBuyAmount(balance));
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const reviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (prepared) reviewRef.current?.focus(); }, [prepared]);
  let amountError = '';
  try {
    const parsed = BigInt(parseAmount(amount, 6));
    if (parsed <= 0n) amountError = 'Enter an amount above zero.';
    else if (parsed > balance) amountError = 'That is more than the test USD in your wallet.';
  } catch (cause) { amountError = cause instanceof Error ? cause.message : 'Enter an amount in test USD.'; }
  const tsla = prepared ? (Number(BigInt(prepared.quote.tslaRaw)) / 1e18).toFixed(5) : '';
  const spend = prepared ? BigInt(prepared.quote.spendAtomic) : 0n;

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working || pausedReason || amountError) return;
    setWorking(true);
    setError('');
    setSuccess('');
    try { setPrepared(await request<Prepared>('/api/assets', { action: 'robinhood_prepare_buy', amount })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Please try again.'); }
    finally { setWorking(false); }
  }

  async function buy() {
    if (!prepared || working || pausedReason) return;
    setWorking(true);
    setError('');
    try {
      for (const step of prepared.steps) {
        const signed = await wallet.signEvmTransaction({
          operationId: `rh-${step.transaction.nonce}`, walletId: prepared.walletId,
          description: step.description, expiresAt: new Date(Date.now() + 120_000).toISOString(),
          transaction: step.transaction,
        });
        await request('/api/assets', { action: 'robinhood_submit', signed });
      }
      setSuccess(`Bought about ${tsla} test TSLA for ${usd(Number(spend) / 1e6)} test USD (tUSDG).`);
      setPrepared(null);
    } catch (cause) {
      setError(`A test purchase step was not confirmed. Earlier signed steps may have changed your balances; check the refreshed holding before signing again. ${cause instanceof Error ? cause.message : 'Please try again.'}`);
      setPrepared(null);
    } finally {
      window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } }));
      setWorking(false);
    }
  }

  return <div className="robinhood-buy">
    {!prepared && <form className="inline-form" onSubmit={(event) => { void review(event); }}>
      <label>Test USD (tUSDG) to spend<input type="number" inputMode="decimal" min="0" step="0.000001" value={amount} disabled={working} onChange={(event) => setAmount(event.target.value)} /></label>
      <p className="small-copy">You have {usd(Number(balance) / 1e6)} test USD (tUSDG).</p>
      {(pausedReason || amountError) && <p className="note" role="status">{pausedReason || amountError}</p>}
      <button className="button primary" type="submit" disabled={working || Boolean(pausedReason || amountError)}>Review buy of test TSLA</button>
    </form>}
    {prepared && <div ref={reviewRef} role="group" aria-label="REVIEW YOUR PURCHASE" tabIndex={-1} className="robinhood-buy-review">
      <span className="small-copy">REVIEW YOUR PURCHASE</span>
      <strong>{usd(Number(spend) / 1e6)} test USD (tUSDG) → about {tsla} test TSLA</strong>
      <p>You keep {usd(Number(balance - spend) / 1e6)} test USD (tUSDG). Priced by the test desk from a reference quote.</p>
      <ul>
        {blocksExampleShares && <li>Buying official test TSLA first means this wallet can no longer prepare example shares, so you could not pledge or borrow with it. Prepare example shares first if you want that.</li>}
        {debtUsd > 0 && <li>You owe {usd(debtUsd)} on a loan. Spending this cash leaves less to repay it.</li>}
        <li>{TEST_EXIT_NOTICE}</li>
      </ul>
      {pausedReason && <p className="note" role="status">{pausedReason}</p>}
      <div className="button-row">
        <button className="button primary" type="button" disabled={working || Boolean(pausedReason)} onClick={() => { void buy(); }}>{blocksExampleShares ? 'Buy anyway' : 'Sign and buy'}</button>
        <button className="text-button" type="button" disabled={working} onClick={() => { setPrepared(null); setError(''); }}>Change amount</button>
        {blocksExampleShares && <button className="button secondary" type="button" disabled={working} onClick={onPrepareExamples}>Prepare example shares first</button>}
      </div>
    </div>}
    <p className="small-copy">{TEST_EXIT_NOTICE}</p>
    {error && <p className="note" role="alert">{error}</p>}
    {success && <p className="note" role="status">{success}</p>}
  </div>;
}
