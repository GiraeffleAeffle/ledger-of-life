'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import { openLocalAi, openLocalInvestment, openShareWorkflow, type Area } from './areas';
import type { LocalInvestmentView } from '@/server/local-investments';
import { ownershipFacts, type OwnershipFacts, type SharePosition } from './ownership-facts';
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

type NextAction = { kind: 'faucet' | 'borrow' | 'housing' | 'company' | 'ai-paid' | 'ai-library'; label: string };
function AccountOwnershipJourney({ request, go, subject }: { request: Request; go: (area: Area) => void; subject: string | null }) {
  const activeTab = useSectionTabActive();
  const [facts, setFacts] = useState<OwnershipFacts | null>(null);
  const [debtAtomic, setDebtAtomic] = useState(0n);
  const [error, setError] = useState('');
  const [serviceReceipt, setServiceReceipt] = useState<'complete' | 'none' | 'unknown'>('unknown');
  const mounted = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(() => {
    const read = ++revision.current;
    return Promise.allSettled([
      Promise.resolve().then(() => request<{ workflow: SharePosition }>('/api/share-workflows')),
      Promise.resolve().then(() => request<{ market: LocalInvestmentView }>('/api/local-investments')),
      Promise.resolve().then(() => {
        const id = subject ? sessionStorage.getItem(`${LOCAL_AI_RECEIPT_KEY}:${subject}`) : null;
        if (!id) return null;
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('The saved service receipt link is invalid.');
        return request<{ request: LocalAiRequest }>(`/api/local-ai/requests/${id}`);
      }),
    ]).then(([shares, investments, service]) => {
      if (!mounted.current || read !== revision.current) return;
      const errors: string[] = [];
      const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Positions could not be checked.';
      const receipt = service.status === 'fulfilled' ? service.value?.request : null;
      setServiceReceipt(service.status === 'rejected' ? 'unknown' : receipt?.mode === 'paid' && receipt.state === 'completed' &&
        receipt.payment.state === 'settled' && receipt.payment.receipt?.success ? 'complete' : 'none');
      if (shares.status === 'fulfilled' && investments.status === 'fulfilled') {
        const { workflow } = shares.value; const { market } = investments.value;
        if (market.state !== 'ready' || market.cashAtomic === null || workflow.sharesRaw === null || workflow.testUsdAtomic === null || market.assets.some((asset) => asset.holdingRaw === null)) {
          setFacts(null); errors.push('Wallet and investment positions could not be verified yet.');
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
  const steps = facts ? [
    { label: 'Get 5 test TSLA from Robinhood’s faucet', complete: facts.walletShares || facts.lockedShares, detail: facts.walletShares ? 'Official test TSLA is available in your wallet.' : facts.lockedShares ? 'Your official test TSLA is locked as loan collateral.' : 'Visit the official faucet yourself; no app operator creates stock.' },
    { label: 'Locked loan collateral', complete: facts.lockedShares, detail: facts.lockedShares ? 'Shares are locked in the loan pool, not available for another pledge.' : 'Only wallet-available shares can be pledged.' },
    { label: 'Borrowed test USD (tUSDG)', complete: facts.borrowed, detail: facts.borrowed ? `${dollars(debtAtomic)} test USD (tUSDG) remains owed. ${facts.cashAtomic === null ? 'Wallet test dollars are unavailable.' : `${dollars(facts.cashAtomic)} test USD (tUSDG) remains in your Robinhood Chain wallet.`}` : 'Wallet cash or an existing fictional stake alone does not show that a loan occurred.' },
    { label: 'Housing stake', complete: facts.housing, detail: facts.housing ? 'tHOME units held in your wallet.' : 'Choose Neighbourhood Homes.' },
    { label: 'Company stake', complete: facts.company, detail: facts.company ? 'tWORK units held in your wallet.' : 'Choose Neighbourhood Works.' },
    { label: 'Local AI & GPU hosting', complete: serviceReceipt === 'complete', detail: serviceReceipt === 'complete' ? 'Your completed local AI answer has a settled test-payment receipt.' : serviceReceipt === 'unknown' ? 'Your saved service receipt could not be checked yet.' : facts.housing && facts.company ? 'Ask the local AI about the fictional projects; the free library is also available.' : 'Your fictional stakes can lead to questions for local AI.' },
  ] : [];
  let next: NextAction | null = null;
  if (facts) {
    if (!facts.walletShares && !facts.lockedShares && !facts.borrowed) next = { kind: 'faucet', label: 'Get 5 test TSLA from Robinhood’s faucet' };
    else if (!facts.lockedShares || !facts.borrowed) {
      next = { kind: 'borrow', label: facts.lockedShares ? 'Review borrowing test USD (tUSDG)' : 'Review share collateral' };
    } else if (!facts.housing || !facts.company) {
      if (facts.cashAtomic === null || facts.cashAtomic < 5_000_000n) next = { kind: 'borrow', label: facts.availableAtomic > 0n ? 'Review additional borrowing' : 'Review loan and cash' };
      else next = facts.housing ? { kind: 'company', label: 'Choose a company stake' } : { kind: 'housing', label: 'Choose a housing stake' };
    } else next = serviceReceipt === 'complete' ? { kind: 'ai-library', label: 'Try the free library desk' }
      : facts.cashAtomic !== null && facts.cashAtomic > 0n ? { kind: 'ai-paid', label: 'Try local AI with test cash' } : { kind: 'ai-library', label: 'Explore the free AI library' };
  }
  function openNext() {
    if (!next) return;
    switch (next.kind) {
      case 'faucet': window.open('https://faucet.testnet.chain.robinhood.com/', '_blank', 'noopener,noreferrer'); break;
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
    <p><a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">Get 5 test TSLA from Robinhood’s faucet</a> and test ETH for fees. Test dollars anyone can mint have no monetary value.</p>
    {error && <p role="status">Position check unavailable: {error} <button type="button" className="text-button" onClick={() => void refresh()}>Check again</button></p>}
    {!facts && !error && <p role="status">Checking your shares, loan and stakes…</p>}
    {facts && <><ol className="ownership-steps">{steps.map((step, index) => <li key={step.label} className={step.complete ? 'complete' : ''}>
      <span aria-hidden="true">{step.complete ? <Check size={16} /> : `${index + 1}`}</span><div><strong>{step.label}</strong><p>{step.detail}</p></div>
    </li>)}</ol>
    {facts.borrowed && <p className="ownership-debt" role="status">Loan debt remains {dollars(debtAtomic)} test USD (tUSDG) even after either stake purchase. Collateral stays locked until repayment.</p>}
    {next && <button className="button primary" type="button" onClick={openNext}>{next.label} <ArrowRight size={16} /></button>}
    </>}
  </section>;
}
