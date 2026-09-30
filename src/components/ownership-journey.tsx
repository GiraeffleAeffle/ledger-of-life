'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Loader2 } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import { openLocalAi, openLocalInvestment, openShareWorkflow, type Area } from './areas';
import type { LocalInvestmentView } from '@/server/local-investments';
import { ownershipFacts, type OwnershipFacts, type SharePosition } from './ownership-facts';
import type { OwnershipPreparationStatus } from '@/server/ownership-demo';
import type { LocalAiRequest } from '@/server/local-ai-types';
import { LOCAL_AI_RECEIPT_KEY } from './local-ai-review';
import { useSectionTabActive } from './section-tabs';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const dollars = (atomic: bigint) => `$${(Number(atomic) / 1e6).toFixed(2)}`;

export function OwnershipJourney({ request, go }: { request: Request; go: (area: Area) => void }) {
  const wallet = useRentalWallet();
  const accountKey = `${wallet.subject}:${wallet.wallets.find((item) => item.chainType === 'ethereum')?.id ?? ''}`;
  return <AccountOwnershipJourney key={accountKey} subject={wallet.subject} request={request} go={go} />;
}

type NextAction = { kind: 'prepare' | 'deposit' | 'borrow' | 'housing' | 'company' | 'ai-paid' | 'ai-library'; label: string };
function AccountOwnershipJourney({ request, go, subject }: { request: Request; go: (area: Area) => void; subject: string | null }) {
  const activeTab = useSectionTabActive();
  const [facts, setFacts] = useState<OwnershipFacts | null>(null);
  const [debtAtomic, setDebtAtomic] = useState(0n);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preparation, setPreparation] = useState<OwnershipPreparationStatus['state']>('none');
  const [statusChecked, setStatusChecked] = useState(false);
  const [serviceReceipt, setServiceReceipt] = useState<'complete' | 'none' | 'unknown'>('unknown');
  const mounted = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(() => {
    const read = ++revision.current;
    return Promise.allSettled([
      Promise.resolve().then(() => request<{ preparation: OwnershipPreparationStatus }>('/api/ownership-demo')),
      Promise.resolve().then(() => request<{ workflow: SharePosition }>('/api/share-workflows')),
      Promise.resolve().then(() => request<{ market: LocalInvestmentView }>('/api/local-investments')),
      Promise.resolve().then(() => {
        const id = subject ? sessionStorage.getItem(`${LOCAL_AI_RECEIPT_KEY}:${subject}`) : null;
        if (!id) return null;
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('The saved service receipt link is invalid.');
        return request<{ request: LocalAiRequest }>(`/api/local-ai/requests/${id}`);
      }),
    ]).then(([prepared, shares, investments, service]) => {
      if (!mounted.current || read !== revision.current) return;
      const errors: string[] = [];
      const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Positions could not be checked.';
      const receipt = service.status === 'fulfilled' ? service.value?.request : null;
      setServiceReceipt(service.status === 'rejected' ? 'unknown' : receipt?.mode === 'paid' && receipt.state === 'completed' &&
        receipt.payment.state === 'settled' && receipt.payment.receipt?.success ? 'complete' : 'none');
      if (prepared.status === 'fulfilled') {
        setPreparation(prepared.value.preparation.state); setStatusChecked(true);
      } else { setStatusChecked(false); errors.push(message(prepared.reason)); }
      if (shares.status === 'fulfilled' && investments.status === 'fulfilled') {
        const { workflow } = shares.value; const { market } = investments.value;
        if (market.state !== 'ready' || market.cashAtomic === null || market.assets.some((asset) => asset.holdingRaw === null)) {
          setFacts(null); errors.push('The investment positions could not be verified yet.');
        } else {
          setFacts(ownershipFacts(workflow, market));
          setDebtAtomic(BigInt(workflow.loan?.debtAtomic ?? '0'));
        }
      } else {
        setFacts(null);
        if (shares.status === 'rejected') errors.push(message(shares.reason));
        if (investments.status === 'rejected') errors.push(message(investments.reason));
      }
      setError(errors.join(' '));
    });
  }, [request, subject]);
  useEffect(() => {
    mounted.current = true;
    const active = mounted; const reads = revision;
    return () => { active.current = false; ++reads.current; };
  }, []);
  useEffect(() => {
    if (activeTab && document.visibilityState === 'visible') void refresh();
    const timer = window.setInterval(() => { if (activeTab && document.visibilityState === 'visible') void refresh(); }, 60_000);
    const changed = (event: Event) => { if (activeTab && document.visibilityState === 'visible' && (event as CustomEvent<{ chain?: string }>).detail?.chain === 'evm') void refresh(); };
    const onVisible = () => { if (activeTab && document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('ledger-balances-changed', changed);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); window.removeEventListener('ledger-balances-changed', changed); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, activeTab]);
  async function prepare() {
    if (busy) return;
    setBusy(true); setActionError('');
    try {
      await request('/api/ownership-demo', { action: 'prepare_example_shares' });
      window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } }));
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Share preparation could not be confirmed. Retry to reconcile the same reserved preparation.');
    } finally { setBusy(false); }
  }
  const steps = facts ? [
    { label: 'Shares available', complete: facts.walletShares || facts.lockedShares, detail: facts.walletShares ? 'Unpledged wallet shares are available.' : facts.lockedShares ? 'Your shares are now locked as loan collateral.' : facts.depositLocked ? 'Your shares are locked for the rental deposit, not available for a loan.' : 'No available shares.' },
    { label: 'Locked loan collateral', complete: facts.lockedShares, detail: facts.lockedShares ? 'Shares are locked in the loan pool, not available for another pledge.' : 'Only wallet-available shares can be pledged.' },
    { label: 'Borrowed test USD (tUSDG)', complete: facts.borrowed, detail: facts.borrowed ? `${dollars(debtAtomic)} test USD (tUSDG) remains owed. ${dollars(facts.cashAtomic)} test USD (tUSDG) remains in your Robinhood Chain wallet.` : 'Wallet cash or an existing fictional stake alone does not show that a loan occurred.' },
    { label: 'Housing stake', complete: facts.housing, detail: facts.housing ? 'tHOME units held in your wallet.' : 'Choose Neighbourhood Homes.' },
    { label: 'Company stake', complete: facts.company, detail: facts.company ? 'tWORK units held in your wallet.' : 'Choose Neighbourhood Works.' },
    { label: 'Local AI & GPU hosting', complete: serviceReceipt === 'complete', detail: serviceReceipt === 'complete' ? 'Your completed local AI answer has a settled test-payment receipt.' : serviceReceipt === 'unknown' ? 'Your saved service receipt could not be checked yet.' : facts.housing && facts.company ? 'Ask the local AI about the fictional projects; the free library is also available.' : 'Your fictional stakes can lead to questions for local AI.' },
  ] : [];
  let next: NextAction | null = null;
  if (facts && statusChecked) {
    if (preparation === 'reserved') next = { kind: 'prepare', label: busy ? 'Reconciling example shares…' : 'Resume example-share preparation' };
    else if (!facts.walletShares && !facts.lockedShares && !facts.borrowed) {
      next = facts.depositLocked ? { kind: 'deposit', label: 'Review locked rental deposit' }
        : facts.legacy ? { kind: 'borrow', label: 'Review existing share market' }
          : facts.enabled ? { kind: 'prepare', label: busy ? 'Preparing example shares…' : 'Prepare example shares' }
            : { kind: 'borrow', label: 'Review shares' };
    } else if (!facts.lockedShares || !facts.borrowed) {
      next = { kind: 'borrow', label: facts.lockedShares ? 'Review borrowing test USD (tUSDG)' : 'Review share collateral' };
    } else if (!facts.housing || !facts.company) {
      if (facts.cashAtomic < 5_000_000n) next = { kind: 'borrow', label: facts.availableAtomic > 0n ? 'Review additional borrowing' : 'Review loan and cash' };
      else next = facts.housing ? { kind: 'company', label: 'Choose a company stake' } : { kind: 'housing', label: 'Choose a housing stake' };
    } else next = serviceReceipt === 'complete' ? { kind: 'ai-library', label: 'Try the free library desk' }
      : facts.cashAtomic > 0n ? { kind: 'ai-paid', label: 'Try local AI with test cash' } : { kind: 'ai-library', label: 'Explore the free AI library' };
  }
  function openNext() {
    if (!next || busy) return;
    switch (next.kind) {
      case 'prepare': void prepare(); break;
      case 'deposit': openShareWorkflow(go, 'deposit'); break;
      case 'borrow': openShareWorkflow(go, 'borrow'); break;
      case 'housing': openLocalInvestment(go, 'demo-neighbourhood-homes'); break;
      case 'company': openLocalInvestment(go, 'demo-retrofit-workshop'); break;
      case 'ai-paid': openLocalAi(go, 'paid'); break;
      case 'ai-library': openLocalAi(go, 'library'); break;
    }
  }
  return <section className="card ownership-journey" aria-label="Test shares to fictional local stakes">
    <span className="eyebrow">SHARES TO FICTIONAL STAKES</span>
    <h2>Test shares, test loan, fictional local stakes</h2>
    <p>Make a test plan from available shares: lock them as loan collateral, borrow a reviewed amount of test USD (tUSDG), then buy fictional housing or workshop units. They grant no ownership rights. Your Solana rental tenancy stays separate in Home.</p>
    {error && <p role="status">Position check unavailable: {error} <button type="button" className="text-button" onClick={() => void refresh()}>Check again</button> {preparation === 'reserved' && <button type="button" className="text-button" disabled={busy} onClick={() => void prepare()}>Resume reserved share preparation</button>}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {preparation === 'paused' && <p role="status">Example-share preparation paused because your share position changed. Existing shares and stakes remain yours.</p>}
    {preparation === 'reserved' && <p role="status">An example-share transaction remains reserved. Reconcile it before pledging or starting another operator action.</p>}
    {!facts && !error && <p role="status">Checking your shares, loan and stakes…</p>}
    {facts && <><ol className="ownership-steps">{steps.map((step, index) => <li key={step.label} className={step.complete ? 'complete' : ''}>
      <span aria-hidden="true">{step.complete ? <Check size={16} /> : `${index + 1}`}</span><div><strong>{step.label}</strong><p>{step.detail}</p></div>
    </li>)}</ol>
    {facts.borrowed && <p className="ownership-debt" role="status">Loan debt remains {dollars(debtAtomic)} test USD (tUSDG) even after either stake purchase. Collateral stays locked until repayment.</p>}
    {facts.legacy && <p role="status">This older share market is preserved; example-share preparation cannot upgrade or reset it.</p>}
    {next && <button className="button primary" type="button" disabled={busy} onClick={openNext}>{busy ? <Loader2 size={16} className="spin" /> : null}{next.label} <ArrowRight size={16} /></button>}
    </>}
  </section>;
}
