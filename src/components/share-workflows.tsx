'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import './share-workflows.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Step = { description: string; transaction: { chainId: 46630; to: string; data: string; value: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } };
type Position = { sharesRaw: string; debtAtomic: string; valueAtomic: string; ltvBps: number; healthBps: number; availableAtomic: string };
type View = {
  enabled: boolean; disclaimer: string; sharesRaw: string; testUsdAtomic: string; priceAtomic: string; walletValueAtomic: string;
  suggestedPledgeRaw: string; suggestedDepositAtomic: string;
  deployment: null | { oracle: string; desk: string; pool: string; escrow?: string };
  deposit: null | { state: number; sharesRaw: string; cashAtomic: string; valueAtomic: string; depositAtomic: string; bufferAtomic: string; deadline: number; claimAtomic: string };
  loan: Position | null;
};
const usd = (atomic: string) => `$${(Number(atomic) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const shares = (raw: string) => (Number(raw) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 });

export function ShareWorkflows({ request }: { request: Request }) {
  const wallet = useRentalWallet();
  const [view, setView] = useState<View | null>(null);
  const [choice, setChoice] = useState<'deposit' | 'borrow'>('deposit');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [earnResult, setEarnResult] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(async () => {
    const response = await request<{ workflow: View }>('/api/share-workflows');
    setView(response.workflow);
  }, [request]);
  useEffect(() => {
    let current = true;
    request<{ workflow: View }>('/api/share-workflows')
      .then(({ workflow }) => { if (current) setView(workflow); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : 'Test market unavailable.'); });
    return () => { current = false; };
  }, [request]);
  useEffect(() => {
    if (!view?.deposit?.deadline) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view?.deposit?.deadline]);

  async function execute(label: string, work: () => Promise<string>) {
    setBusy(label);
    setMessage(''); setError('');
    try {
      setMessage(await work());
      await refresh();
      window.dispatchEvent(new Event('ledger-share-workflows-changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Test transaction failed.');
    } finally {
      setBusy('');
    }
  }
  async function sign(operation: string, quantity?: string) {
    const { walletId, steps } = await request<{ walletId: string; steps: Step[] }>('/api/share-workflows', { action: 'prepare', operation, quantity });
    let lastHash = '';
    for (const step of steps) {
      const signed = await wallet.signEvmTransaction({
        operationId: `shares-${step.transaction.nonce}`, walletId, description: step.description,
        expiresAt: new Date(Date.now() + 120_000).toISOString(), transaction: step.transaction,
      });
      const result = await request<{ hash: string }>('/api/share-workflows', { action: 'submit', signed });
      lastHash = result.hash;
    }
    return operation === 'withdraw_collateral' ? `Loan repaid; remaining test shares returned to your wallet · ${lastHash}` : lastHash;
  }
  async function control(operation: string) {
    const result = await request<{ hash?: string; deployment?: { pool: string } }>('/api/share-workflows', { action: operation === 'start' ? 'start' : 'control', operation });
    return result.hash ?? result.deployment?.pool ?? '';
  }
  function button(label: string, work: () => Promise<string>, primary = false, disabled = false) {
    return <button type="button" className={`button ${primary ? 'primary' : 'secondary'}`} disabled={Boolean(busy) || disabled} onClick={() => void execute(label, work)}>
      {busy === label && <Loader2 size={15} className="spin" />} {label}
    </button>;
  }

  const d = view?.deposit;
  const loan = view?.loan;
  const walletShares = BigInt(view?.sharesRaw ?? '0');
  const testUsd = BigInt(view?.testUsdAtomic ?? '0');
  const available = BigInt(loan?.availableAtomic ?? '0');
  const activeLoan = BigInt(loan?.debtAtomic ?? '0');
  const secured = d?.state === 1;
  const shortfall = Boolean(d?.deadline);
  const wait = Math.max(0, (d?.deadline ?? 0) - Math.floor((tick || Date.now()) / 1000));
  const pledgeSize = BigInt(view?.suggestedPledgeRaw ?? '0');
  const heldInPool = BigInt(loan?.sharesRaw ?? '0');
  const remainingPledge = walletShares / 3n;
  const start = !view?.deployment;

  return <section className="card share-flow" aria-label="What your shares can do">
    <header className="share-flow-head">
      <div><span className="eyebrow">ROBINHOOD CHAIN · TEST MARKET</span><h2>What your shares can do</h2></div>
      <span className="share-flow-tag">No real value</span>
    </header>
    <p className="small-copy">Simulated deposit yield and prices. Official test TSLA, test USD, and real testnet transactions signed by your own wallet.</p>
    {error && <p className="note" role="alert">{error}</p>}
    {message && <p className="note" role="status">Testnet result: {message}</p>}
    {!view ? <p className="small-copy"><Loader2 className="spin" size={15} /> Loading test shares…</p> : <>
      <div className="share-flow-overview">
        <strong>Your wallet: {shares(view.sharesRaw)} test TSLA ≈ {usd(view.walletValueAtomic)}</strong>
        <span>At simulated test price {usd(view.priceAtomic)} per share · {usd(view.testUsdAtomic)} test USD in wallet</span>
      </div>
      {view.enabled && <ol className="share-flow-steps">
        <li>
          <strong>Let a test deposit earn</strong>
          <p>The test tenant, landlord and vault are played by operator test keys. Simulated earnings are released to your wallet; this is not a claim you signed for that test tenancy.</p>
          {button('Generate test earnings', async () => {
            const { result } = await request<{ result: { releasedAtomic: string } }>('/api/assets', { action: 'robinhood_earn' });
            setEarnResult(usd(result.releasedAtomic));
            return `${usd(result.releasedAtomic)} simulated earnings reached your wallet`;
          }, false, Boolean(earnResult || walletShares || testUsd))}
          {earnResult && <span className="small-copy">{earnResult} test earnings released</span>}
        </li>
        <li>
          <strong>Buy test shares with your wallet</strong>
          <p>Use the single “Invest in TSLA” action in your Robinhood holding above. It asks you to sign test USD approval and a test-desk buy. Return here after it confirms.</p>
          {button('Refresh shares', async () => { await refresh(); return 'Wallet shares refreshed'; })}
        </li>
      </ol>}
      <div className="share-flow-choices" role="group" aria-label="Choose a share workflow">
        <button type="button" className={choice === 'deposit' ? 'selected' : ''} aria-pressed={choice === 'deposit'} onClick={() => setChoice('deposit')}><strong>Secure your next deposit with shares</strong><span>Keep shares pledged for a new test tenancy.</span></button>
        <button type="button" className={choice === 'borrow' ? 'selected' : ''} aria-pressed={choice === 'borrow'} onClick={() => setChoice('borrow')}><strong>Borrow against your shares</strong><span>Get test USD, then repay to get your shares back.</span></button>
      </div>
      {!view.enabled ? <p className="small-copy">Test market controls are not enabled on this server.</p> : <>
        {start && <div className="share-flow-action"><p>Set up a separate test oracle, stock-sale desk and lending pool for your wallet. Their test price changes affect only this test market.</p>{button('Open your test market', () => control('start'), true, !walletShares)}</div>}
        {choice === 'deposit' && <div className="share-flow-detail">
          <h3>A · Shares as your next deposit</h3>
          {!d && <p>Test landlord accepts a new deposit of ≈ {usd(view.suggestedDepositAtomic)} in exchange for pledging half your available test TSLA ({shares(view.suggestedPledgeRaw)} shares), initially worth 150% of the deposit. This is separate from the earnings tenancy.</p>}
          {view.deployment && !view.deployment.escrow && button('Test landlord accepts new tenancy', () => control('landlord_accepts'), true, pledgeSize === 0n)}
          {view.deployment?.escrow && !d && <p>New test tenancy accepted. Reading its on-chain position…</p>}
          {d && <dl className="share-flow-facts">
            <div><dt>Shares pledged</dt><dd>{shares(d.sharesRaw)} test TSLA</dd></div>
            <div><dt>Security at test price</dt><dd>{d.state === 0 || d.state === 5 ? '—' : `${usd(d.valueAtomic)} / ${usd(d.depositAtomic)} deposit`}</dd></div>
            <div><dt>Buffer above 125% maintenance</dt><dd>{d.state === 0 || d.state === 5 ? '—' : usd(d.bufferAtomic)}</dd></div>
            <div><dt>Test tenancy</dt><dd>{['Ready to pledge', 'Secured', 'Claim proposed', 'Claim contested', 'Claim approved', 'Closed'][d.state] ?? 'Unknown'}</dd></div>
          </dl>}
          {d?.state === 0 && button('Sign pledge of test shares', () => sign('pledge', view.suggestedPledgeRaw), true, pledgeSize > walletShares || pledgeSize === 0n)}
          {secured && <>
            <p className="small-copy">If the test price falls, a shortfall can be flagged below 125%; top up before the grace period ends, or a protective sale converts only enough shares to secure the deposit in test USD.</p>
            <div className="share-flow-actions">
              {button('Set test price −30%', () => control('price_down_30'))}
              {button('Restore test price', () => control('price_reset'))}
              {!shortfall && BigInt(d.bufferAtomic) < 0n && button('Request top-up', () => control('flag_shortfall'))}
              {shortfall && remainingPledge > 0n && button('Sign share top-up', () => sign('top_up', remainingPledge.toString()), true)}
              {shortfall && button(wait ? `Protective sale in ${wait}s` : 'Protect deposit with partial sale', () => control('protect_deposit'), false, wait > 0)}
              {button('Test landlord proposes move-out claim', () => control('move_out_claim'))}
            </div>
          </>}
          {d?.state === 2 && <div className="share-flow-action"><p>Test landlord proposes a {usd(d.claimAtomic)} claim. Your wallet decides whether to accept it.</p>{button('Sign claim acceptance', () => sign('accept_claim'), true)}</div>}
          {d?.state === 4 && button('Pay claim and return remaining shares', () => control('settle'), true)}
          {d?.state === 5 && <p className="share-flow-result">Move-out settled. The approved test claim was paid in test USD; unsold test TSLA returned to your wallet. Refresh to see your returned shares.</p>}
        </div>}
        {choice === 'borrow' && <div className="share-flow-detail">
          <h3>B · Borrow test USD against shares</h3>
          <p>Operator-funded test lending pool: 50% maximum LTV, 80% liquidation threshold, 5% annual simple interest accrued by elapsed seconds. At an unhealthy LTV, a liquidator can repay debt for shares.</p>
          {loan && <dl className="share-flow-facts">
            <div><dt>Shares in pool</dt><dd>{shares(loan.sharesRaw)} test TSLA ≈ {usd(loan.valueAtomic)}</dd></div>
            <div><dt>Test USD owed, including interest</dt><dd>{usd(loan.debtAtomic)}</dd></div>
            <div><dt>Loan-to-value</dt><dd>{loan.ltvBps / 100}% · {loan.ltvBps >= 8_000 ? 'Liquidatable' : 'Below 80% threshold'}</dd></div>
            <div><dt>Health / room to 80%</dt><dd>{loan.healthBps ? `${(loan.healthBps / 10_000).toFixed(2)}×` : '—'} · {usd((BigInt(loan.valueAtomic) * 80n / 100n - activeLoan).toString())}</dd></div>
          </dl>}
          {view.deployment && walletShares > 0n && button('Sign test share collateral', () => sign('deposit_collateral', walletShares.toString()), true)}
          {heldInPool > 0n && activeLoan === 0n && available > 0n && button(`Borrow ${usd((available * 4n / 5n).toString())} test USD`, () => sign('borrow', (available * 4n / 5n).toString()), true)}
          {activeLoan > 0n && <div className="share-flow-actions">
            {button('Set test price −30%', () => control('price_down_30'))}
            {button('Set test price −60%', () => control('price_down_60'))}
            {button('Set test price −70%', () => control('price_down_70'))}
            {button('Restore test price', () => control('price_reset'))}
            {walletShares > 0n && button('Add your remaining shares', () => sign('deposit_collateral', walletShares.toString()))}
            {testUsd < activeLoan + 1_000n && button('Test USD repayment faucet', () => control('faucet'))}
            {button(`Repay up to ${usd(activeLoan.toString())}`, () => sign('repay', (activeLoan + 1_000n).toString()), true, testUsd < activeLoan + 1_000n)}
            {loan!.ltvBps >= 8_000 && button('Test liquidator repays part of unhealthy loan', () => control('liquidate_loan'))}
          </div>}
          {heldInPool > 0n && activeLoan === 0n && button('Return your remaining test shares', () => sign('withdraw_collateral', loan!.sharesRaw), true)}
          {view.deployment && heldInPool === 0n && activeLoan === 0n && walletShares === 0n && <p className="share-flow-result">Your test shares have left the pool; check the deposit position above for any other pledged shares.</p>}
        </div>}
      </>}
      <p className="small-copy">Both routes are independent choices for the same shares. Shares in a deposit or loan are locked until their respective settlement or repayment; this demo never bridges Solana tSPYx.</p>
    </>}
  </section>;
}
