'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Cpu, ExternalLink, Library, Loader2, RefreshCw, Send, Wallet } from 'lucide-react';
import { readLocalAiResponse } from './local-ai-response';
import { useRentalWallet } from '@/wallets';
import type { LocalAiApproval, LocalAiMode, LocalAiRequest, LocalAiServiceStatus, LocalAiUsageSummary } from '@/server/local-ai-types';
import { LOCAL_AI_NAVIGATION_INTENT } from './areas';
import { localAiPaymentHeaders } from './local-ai-payment';
import { LocalAiHost } from './local-ai-host';
import { inferenceApprovalForReview, inferenceNextAction, LOCAL_AI_RECEIPT_KEY } from './local-ai-review';
import { useSectionTabActive } from './section-tabs';
import './local-ai.css';

const amount = (atomic: string) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 }).format(Number(BigInt(atomic)) / 1e6);
const LIBRARY_REQUEST_KEY = 'ledger-of-life:local-ai:library';
const LIBRARY_CHANNEL = 'ledger-of-life:library-session';
const short = (address: string) => `${address.slice(0, 7)}…${address.slice(-5)}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The node could not be reached.';
const samples = [
  { label: 'Better homes', text: 'In three short sentences, explain how rooftop solar and a heat pump could work together in a shared housing project. Mention one cost that must be checked.' },
  { label: 'Local businesses', text: 'Suggest three concise ways residents could support local repair and energy-installation businesses. Do not invent company names or existing partnerships.' },
  { label: 'A useful library', text: 'Suggest three concise, practical uses for a free local AI service in a public library. Mention how a visitor can check an answer.' },
];
type Draft = { id: string; mode: LocalAiMode; prompt: string; maxOutputTokens: number; context: 'general' };
const finished = (request: LocalAiRequest) => ['completed', 'failed', 'expired', 'interrupted'].includes(request.state);

export function LocalAiWorkspace({ initialMode = 'paid', publicAccess = false }: { initialMode?: LocalAiMode; publicAccess?: boolean }) {
  const wallet = useRentalWallet();
  return <LocalAiPanel key={publicAccess ? 'public-library' : wallet.subject ?? 'anonymous'} initialMode={initialMode} publicAccess={publicAccess} />;
}

function LocalAiPanel({ initialMode, publicAccess }: { initialMode: LocalAiMode; publicAccess: boolean }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const { authenticated, getAccessToken, subject } = wallet;
  const [mode, setMode] = useState<LocalAiMode>(publicAccess ? 'library' : initialMode);
  const [view, setView] = useState<'ask' | 'host'>('ask');
  const [service, setService] = useState<LocalAiServiceStatus | null>(null);
  const [usage, setUsage] = useState<LocalAiUsageSummary | null>(null);
  const [prompt, setPrompt] = useState(samples[0].text);
  const [outputLimit, setOutputLimit] = useState(128);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [current, setCurrent] = useState<LocalAiRequest | null>(null);
  const [approval, setApproval] = useState<LocalAiApproval | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [usageError, setUsageError] = useState('');
  const [paymentSubmitted, setPaymentSubmitted] = useState(false);
  const mounted = useRef(false);
  const action = useRef(false);
  const readRevision = useRef(0);
  const requestRevision = useRef(0);
  const paymentHeaders = useRef<Record<string, string> | null>(null);
  const storageKey = `ledger-of-life:local-ai:${mode === 'library' ? 'library' : wallet.subject ?? 'anonymous'}`;

  const libraryChannel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(LIBRARY_CHANNEL);
    const channelRef = libraryChannel;
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent) => {
      if (event.data !== 'cleared') return;
      try { sessionStorage.removeItem(LIBRARY_REQUEST_KEY); } catch { /* No saved link exists in this browser. */ }
      if (mode === 'library') window.location.reload();
    };
    return () => { channelRef.current = null; channel.close(); };
  }, [mode]);

  const api = useCallback(async <T,>(path: string, body?: object, headers?: Record<string, string>, paid = false): Promise<T> => {
    const token = !publicAccess && authenticated && (paid || path.endsWith('/status')) ? await getAccessToken() : null;
    if (!mounted.current) throw new Error('This workspace is no longer active.');
    if (paid && (!authenticated || !token)) throw new Error('Sign in with your passkey to use paid access.');
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const requestId = /^\/api\/local-ai\/requests\/([^/]+)$/.exec(path)?.[1];
    return readLocalAiResponse<T>(response, requestId);
  }, [publicAccess, authenticated, getAccessToken]);

  const refresh = useCallback(async () => {
    const revision = ++readRevision.current;
    await Promise.all([
      api<{ service: LocalAiServiceStatus }>('/api/local-ai/status').then((result) => {
        if (mounted.current && revision === readRevision.current) { setService(result.service); setStatusError(''); }
      }, (cause: unknown) => { if (mounted.current && revision === readRevision.current) setStatusError(errorMessage(cause)); }),
      ...(publicAccess ? [] : [api<{ usage: LocalAiUsageSummary }>('/api/local-ai/usage').then((result) => {
        if (mounted.current && revision === readRevision.current) { setUsage(result.usage); setUsageError(''); }
      }, (cause: unknown) => { if (mounted.current && revision === readRevision.current) setUsageError(errorMessage(cause)); })]),
    ]);
  }, [api, publicAccess]);

  const accept = useCallback((next: LocalAiRequest) => {
    setCurrent(next); setApproval(next.approval); setPrompt(next.purgedAt ? '' : next.prompt); if (next.purgedAt) setDraft(null); setOutputLimit(next.maxOutputTokens);
    if (finished(next)) {
      setPaymentSubmitted(false); paymentHeaders.current = null;
      if (next.mode === 'paid' && next.state === 'completed' && next.payment.state === 'settled' && next.payment.receipt?.success) {
        try { if (subject) sessionStorage.setItem(`${LOCAL_AI_RECEIPT_KEY}:${subject}`, next.id); } catch { /* The saved server receipt remains available in this view. */ }
        window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: 'evm' } }));
      }
    }
  }, [subject]);
  const readSaved = useCallback(async (id: string) => {
    const revision = requestRevision.current;
    const result = await api<{ request: LocalAiRequest }>(`/api/local-ai/requests/${id}`, undefined, undefined, mode === 'paid');
    if (mounted.current && revision === requestRevision.current) accept(result.request);
  }, [api, mode, accept]);

  useEffect(() => {
    mounted.current = true;
    const active = mounted; const reads = readRevision; const requests = requestRevision;
    return () => { active.current = false; ++reads.current; ++requests.current; };
  }, []);
  useEffect(() => {
    if (activeTab && document.visibilityState === 'visible') void refresh();
    const balancesChanged = (event: Event) => {
      if (activeTab && document.visibilityState === 'visible' && (event as CustomEvent<{ chain?: string }>).detail?.chain === 'evm' && !action.current) void refresh();
    };
    const onVisible = () => { if (activeTab && document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('ledger-balances-changed', balancesChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener('ledger-balances-changed', balancesChanged); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, activeTab]);
  useEffect(() => {
    let active = true;
    const requests = requestRevision;
    try {
      const id = sessionStorage.getItem(storageKey);
      if (id && /^[0-9a-f-]{36}$/i.test(id)) void readSaved(id).catch((cause: unknown) => {
        if (active && mounted.current) setError(`Saved request unavailable: ${errorMessage(cause)}`);
      });
    } catch { /* Session storage is optional; requests themselves are persisted on the server. */ }
    return () => { active = false; ++requests.current; };
  }, [storageKey, readSaved]);
  useEffect(() => {
    if (publicAccess) return;
    const consume = () => {
      const selected = sessionStorage.getItem(LOCAL_AI_NAVIGATION_INTENT);
      if ((selected !== 'paid' && selected !== 'library') || action.current) return;
      sessionStorage.removeItem(LOCAL_AI_NAVIGATION_INTENT);
      queueMicrotask(() => { ++requestRevision.current; setMode(selected); setView('ask'); setCurrent(null); setDraft(null); setApproval(null); setError(''); setPaymentSubmitted(false); paymentHeaders.current = null; });
    };
    consume(); window.addEventListener(LOCAL_AI_NAVIGATION_INTENT, consume);
    return () => window.removeEventListener(LOCAL_AI_NAVIGATION_INTENT, consume);
  }, [publicAccess]);

  const unresolvedId = current && (current.state === 'running' || current.state === 'settling') ? current.id : null;
  useEffect(() => {
    if (!unresolvedId) return;
    let checking = false; let active = true;
    const check = () => {
      if (checking || action.current || !activeTab || document.visibilityState === 'hidden') return;
      checking = true;
      void readSaved(unresolvedId).then(() => { if (active) void refresh(); }, (cause: unknown) => {
        if (active) setError(`Still waiting for the saved result: ${errorMessage(cause)}`);
      }).finally(() => { checking = false; });
    };
    const timer = window.setInterval(check, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [unresolvedId, readSaved, refresh, activeTab]);

  const approvalPending = approval?.state === 'pending' ? current?.id : null;
  useEffect(() => {
    if (!approvalPending) return;
    let checking = false; let active = true;
    const check = () => {
      if (checking || action.current || !activeTab || document.visibilityState === 'hidden') return;
      checking = true;
      void api<{ approval: LocalAiApproval }>(`/api/local-ai/requests/${approvalPending}/approval`, { action: 'reconcile' }, undefined, true).then(({ approval: next }) => {
        if (!active) return;
        setApproval(next);
        if (next.state === 'completed') void refresh();
      }, (cause: unknown) => { if (active) setError(`Access approval remains unresolved: ${errorMessage(cause)}`); }).finally(() => { checking = false; });
    };
    const timer = window.setInterval(check, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [approvalPending, api, refresh, activeTab]);

  async function run(label: string, operation: () => Promise<void>) {
    if (action.current) return;
    action.current = true; setBusy(label); setError(''); ++requestRevision.current;
    try { await operation(); }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { action.current = false; if (mounted.current) { setBusy(''); void refresh(); } }
  }
  function saveId(id: string) {
    try { sessionStorage.setItem(storageKey, id); }
    catch { setError('This browser cannot save the request link. Keep this page open until the result arrives.'); }
  }
  function resetQuestion(nextMode = mode) {
    ++requestRevision.current; setMode(nextMode); setCurrent(null); setDraft(null); setApproval(null); setError(''); setPaymentSubmitted(false); paymentHeaders.current = null;
    if (nextMode === mode) try { sessionStorage.removeItem(storageKey); } catch { /* No persistent request link was available. */ }
  }
  function submitQuestion() {
    void run(mode === 'paid' ? 'Preparing your payment review' : 'Asking the local model', async () => {
      if (mode === 'library') {
        const session = await api<{ sessionReady: boolean }>('/api/local-ai/library-session');
        if (!session.sessionReady) throw new Error('A private visitor session could not be established.');
        if (!mounted.current) return;
      }
      const nextDraft: Draft = draft ?? { id: crypto.randomUUID(), mode, prompt: prompt.trim(), maxOutputTokens: Math.min(outputLimit, maximumOutput), context: 'general' };
      setDraft(nextDraft); saveId(nextDraft.id);
      try {
        const { mode: accessMode, prompt: question, maxOutputTokens, context } = nextDraft;
        const result = await api<{ request: LocalAiRequest }>(`/api/local-ai/requests/${nextDraft.id}`, {
          mode: accessMode, prompt: question, maxOutputTokens, context,
        }, undefined, mode === 'paid');
        if (!mounted.current) return;
        accept(result.request);
        if (mode === 'paid' && ['payment_required', 'approval_required'].includes(result.request.state)) {
          const prepared = await api<{ approval: LocalAiApproval }>(`/api/local-ai/requests/${nextDraft.id}/approval`, { action: 'prepare' }, undefined, true);
          if (mounted.current) setApproval(prepared.approval);
        }
      } catch (cause) {
        try { await readSaved(nextDraft.id); } catch { /* Preserve the same request ID for an explicit retry. */ }
        throw cause;
      }
    });
  }
  function prepareApproval() {
    if (!current) return;
    void run('Preparing a finite access budget', async () => {
      const result = await api<{ approval: LocalAiApproval }>(`/api/local-ai/requests/${current.id}/approval`, { action: 'prepare' }, undefined, true);
      if (mounted.current) setApproval(result.approval);
    });
  }
  function signApproval() {
    if (!current || !approval?.request) return;
    void run('Waiting for your access-budget signature', async () => {
      const signing = inferenceApprovalForReview(current, approval);
      const signedTransaction = await wallet.signEvmTransaction(signing);
      if (!mounted.current) return;
      setBusy('Confirming the access budget');
      try {
        const result = await api<{ approval: LocalAiApproval }>(`/api/local-ai/requests/${current.id}/approval`, { action: 'submit', signedTransaction }, undefined, true);
        if (mounted.current) setApproval(result.approval);
      } catch (cause) {
        try { await readSaved(current.id); } catch { /* The durable approval remains the authority after a lost response. */ }
        throw cause;
      }
    });
  }
  function payAndAsk() {
    if (!current || current.purgedAt) return;
    void run(paymentHeaders.current ? 'Resuming the same authorized request' : 'Waiting for your one-answer authorization', async () => {
      if (!paymentHeaders.current) paymentHeaders.current = await localAiPaymentHeaders(wallet, current);
      if (!mounted.current) return;
      setBusy('Running the model, then settling payment'); setPaymentSubmitted(true);
      try {
        const result = await api<{ request: LocalAiRequest }>(`/api/local-ai/requests/${current.id}`, {
          mode: current.mode, prompt: current.prompt, maxOutputTokens: current.maxOutputTokens, context: 'general',
        }, paymentHeaders.current, true);
        if (mounted.current) accept(result.request);
      } catch (cause) {
        try { await readSaved(current.id); } catch { /* No replacement authorization or inference is started. */ }
        throw cause;
      }
    });
  }
  function resumeSaved() {
    if (!current || current.purgedAt) return;
    void run('Recovering the saved request', async () => {
      const result = await api<{ request: LocalAiRequest }>(`/api/local-ai/requests/${current.id}`, {
        mode: current.mode, prompt: current.prompt, maxOutputTokens: current.maxOutputTokens, context: 'general',
      }, paymentHeaders.current ?? undefined, current.mode === 'paid');
      if (mounted.current) accept(result.request);
    });
  }

  const price = service?.price;
  const maximumOutput = mode === 'library' ? service?.library.maxOutputTokens ?? 128 : service?.maxOutputTokens ?? 256;
  const needsApproval = Boolean(current && price && approval?.state !== 'completed');
  const paidFundingReason = mode !== 'paid' || !service || !wallet.authenticated ? '' : !price
    ? 'The test USD (tUSDG) price is unavailable.'
    : service.wallet?.cashAtomic == null ? 'Robinhood Chain wallet cash could not be checked.'
      : BigInt(service.wallet.cashAtomic) < BigInt(price.amountAtomic) ? `A paid answer costs ${amount(price.amountAtomic)} test USD (tUSDG); this wallet needs more test cash.`
        : approval?.state !== 'completed' && service.wallet?.nativeAtomic === '0' ? 'Network-fee test ETH is needed for the payment-budget approval.'
          : '';
  const canStart = Boolean(service?.reachable && !statusError && (mode === 'library' ? service.library.enabled : service.paidEnabled && wallet.authenticated && !paidFundingReason));
  const receiptHash = current?.payment.receipt?.transaction;
  const reviewing = current && !current.purgedAt && inferenceNextAction(current) === 'payment-review';
  const readyToResume = current && !current.purgedAt && inferenceNextAction(current) === 'resume';
  const locked = Boolean(busy || draft || current);
  function clearLibraryDesk() {
    void run('Ending this visitor session', async () => {
      const response = await fetch('/api/local-ai/library-session', { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok || !(await response.json()).cleared) throw new Error('The visitor session could not be cleared. Please try again.');
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = libraryChannel.current ?? new BroadcastChannel(LIBRARY_CHANNEL);
        channel.postMessage('cleared');
        if (!libraryChannel.current) channel.close();
      }
      if (mounted.current) { resetQuestion(); setPrompt(''); }
    });
  }
  const nodeLabel = statusError ? 'Status unavailable' : service?.reachable
    ? service.modelResident ? service.vramBytes && service.vramBytes > 0 ? 'GPU model resident' : 'Model resident · CPU' : 'Node ready · model on demand'
    : service ? 'Node unavailable' : 'Checking the node';

  return <section className="local-ai" id="local-ai" tabIndex={-1} aria-label="Local AI service">
    <header className="local-ai-heading"><div><span className="eyebrow">{publicAccess ? 'LOCAL INTELLIGENCE' : 'LOCAL AI & GPU HOSTING'}</span><h2>{publicAccess ? 'A useful tool. Open to everyone.' : 'Put local compute to work.'}</h2><p>{publicAccess ? 'Ask a question on the connected local model. No account, wallet or payment needed.' : 'Ask the local model, pay for a completed answer, or explore free public access.'}</p></div><span className={`local-ai-node-state ${service?.reachable && !statusError ? 'online' : ''}`}><span />{nodeLabel}</span></header>
    <div className="local-ai-node"><span className="local-ai-node-icon"><Cpu size={24} /></span><div><strong>{service?.model || 'Local Qwen node'}</strong><span>{service?.hardwareLabel || 'Configured local hardware'}{service?.vramBytes != null && service.vramBytes > 0 ? ` · ${(service.vramBytes / 2 ** 30).toFixed(1)} GiB model in VRAM` : ''}</span></div><button type="button" className="text-button" aria-label="Refresh node status" onClick={() => void refresh()}><RefreshCw size={16} /></button></div>
    {(statusError || service?.error) && <p className="local-ai-alert" role="alert">{statusError || service?.error}</p>}
    {!publicAccess && <div className="local-ai-tabs" role="group" aria-label="Local AI views"><button type="button" aria-pressed={view === 'ask'} onClick={() => setView('ask')}>Ask the node</button><button type="button" aria-pressed={view === 'host'} onClick={() => setView('host')}>Host income &amp; costs</button></div>}
    {view === 'host' && !publicAccess ? <LocalAiHost usage={usage} error={usageError} /> : <div className="local-ai-ask">
      {/* Default grace is 10 minutes; deployments may configure LOCAL_AI_TEXT_GRACE_SECONDS. */}
      <p className="local-ai-meta">The host keeps your question and the answer for about 10 minutes so an interrupted request can finish, then removes them. Usage counts and payment receipts stay. Do not enter private information on a shared desk.</p>
      {!publicAccess && <div className="local-ai-access" role="group" aria-label="Choose AI access"><button type="button" disabled={Boolean(busy || unresolvedId || paymentSubmitted)} aria-pressed={mode === 'paid'} onClick={() => resetQuestion('paid')}><Wallet size={18} /><span><strong>Personal access</strong><small>{price ? `${amount(price.amountAtomic)} ${price.symbol} / answer · x402` : 'Pay per completed answer'}</small></span></button><button type="button" disabled={Boolean(busy || unresolvedId || paymentSubmitted)} aria-pressed={mode === 'library'} onClick={() => resetQuestion('library')}><Library size={18} /><span><strong>Public library access</strong><small>Free at the point of use</small></span></button></div>}
      {mode === 'library' && <div className="local-ai-library-note"><Library size={18} /><p>The host covers the compute. {service?.library.remainingRequests != null ? `${service.library.remainingRequests} requests remaining within the shared service limits.` : 'A bounded visitor allowance keeps the shared node available.'}{!publicAccess && <> <a href="/library" target="_blank" rel="noopener noreferrer">Open the public desk <ArrowUpRight size={13} /></a></>}</p></div>}
      <div className="local-ai-question"><label htmlFor={publicAccess ? 'library-question' : 'local-ai-question'}>What would you like to explore?</label><div className="local-ai-samples">{samples.map((sample) => <button type="button" key={sample.label} disabled={locked} onClick={() => setPrompt(sample.text)}>{sample.label}</button>)}</div><textarea id={publicAccess ? 'library-question' : 'local-ai-question'} value={prompt} minLength={3} maxLength={2000} rows={4} disabled={locked} onChange={(event) => setPrompt(event.target.value)} /><div className="local-ai-question-footer"><label>Answer limit<select value={Math.min(outputLimit, maximumOutput)} disabled={locked} onChange={(event) => setOutputLimit(Number(event.target.value))}>{[64, 128, 256, 512].filter((value) => value <= maximumOutput).map((value) => <option value={value} key={value}>{value} output tokens</option>)}</select></label>{!current && <button type="button" className="primary-btn" disabled={Boolean(busy || !canStart || prompt.trim().length < 3)} onClick={submitQuestion}>{busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}{draft ? 'Retry the same question' : mode === 'paid' ? 'Review paid question' : 'Ask for free'}</button>}{current && finished(current) && <button type="button" className="primary-btn" disabled={Boolean(busy)} onClick={() => resetQuestion()}>Ask another question</button>}</div></div>
      {mode === 'library' && service && !service.library.enabled && <p role="status">The free desk is switched off on this server. Ask for free is unavailable here.</p>}
      {mode === 'paid' && service && <p role="status">A paid answer costs {price ? `${amount(price.amountAtomic)} test USD (tUSDG)` : 'an unavailable test price'}. {paidFundingReason || (needsApproval ? 'Approving the payment budget also needs network-fee test ETH.' : '')}</p>}
      {mode === 'library' && <><button type="button" className="text-button" disabled={Boolean(busy || unresolvedId)} onClick={clearLibraryDesk}>Finish &amp; clear this desk</button><p className="local-ai-meta">This removes your saved questions and answers from the server now, except requests still running or awaiting payment.</p></>}
      {readyToResume && <div className="local-ai-payment-review"><h3>This question is saved and ready.</h3><p>The shared node was busy. Continue the same request{current?.mode === 'paid' ? ' with its existing payment authorization—no new signature' : ' for free'}.</p><button type="button" className="primary-btn" disabled={Boolean(busy)} onClick={resumeSaved}>Run this saved question</button></div>}
      {!current && draft && mode === 'paid' && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => resetQuestion()}>Change the unsubmitted question</button>}
      {mode === 'paid' && !wallet.authenticated && <p className="local-ai-meta">Sign in from Me for personal access, or choose the free public desk.</p>}
      {reviewing && price && <div className="local-ai-payment-review"><span className="eyebrow">REVIEW THIS ANSWER</span><h3>{amount(current.payment.amountAtomic)} {price.symbol} · one completed answer</h3><p>Your question is fixed for this authorization. The node runs the model before it settles payment.</p><dl><div><dt>Network</dt><dd>Robinhood testnet · x402 v2</dd></div><div><dt>Recipient</dt><dd><code title={price.payTo}>{short(price.payTo)}</code></dd></div><div><dt>Wallet cash</dt><dd>{service?.wallet?.cashAtomic != null ? `${amount(service.wallet.cashAtomic)} ${price.symbol}` : 'Unavailable'}</dd></div></dl>
        {needsApproval ? <><p>Approve a finite {amount(price.approvalBudgetAtomic)} {price.symbol} Permit2 budget, enough for ten answers at this price. Each answer still needs a separate authorization; the budget approval is not a service payment.</p>{approval?.state === 'review' && approval.request ? <><details><summary>Access-budget transaction details</summary><p>Token <code>{price.asset}</code></p><p>Allowance spender <code>{price.permit2}</code></p><p>{approval.request.description}. The wallet also pays the approval transaction&apos;s network fee.</p></details><button type="button" className="primary-btn" disabled={Boolean(busy)} onClick={signApproval}>Sign access budget</button></> : approval?.state === 'pending' ? <p className="local-ai-progress"><Loader2 size={16} className="spin" />Confirming the signed access budget. No new transaction is being created.</p> : <button type="button" className="primary-btn" disabled={Boolean(busy || !canStart)} onClick={prepareApproval}>Review access budget</button>}</> : <button type="button" className="primary-btn" disabled={Boolean(busy || !canStart)} onClick={payAndAsk}>{paymentSubmitted ? 'Retry the same authorization' : `Authorize ${amount(current.payment.amountAtomic)} ${price.symbol} and ask`}</button>}
        {approval?.error && <p className="local-ai-alert" role="alert">{approval.error}</p>}{!paymentSubmitted && approval?.state !== 'pending' && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => resetQuestion()}>Change question</button>}
      </div>}
      {busy && <p className="local-ai-progress" role="status"><Loader2 size={16} className="spin" />{busy}</p>}
      {unresolvedId && !busy && <div className="local-ai-progress" role="status"><Loader2 size={16} className="spin" /><span>{current?.state === 'settling' ? 'The answer is saved. Its payment is being confirmed.' : 'The local model is working on this saved request.'}</span><button type="button" className="text-button" onClick={resumeSaved}>Recover saved request</button></div>}
      {error && <p className="local-ai-alert" role="alert">{error}</p>}
      {current?.error && <p className="local-ai-alert" role="alert">{current.error}{current.payment.state === 'none' || current.payment.state === 'failed' || current.payment.state === 'quoted' ? ' No service payment was settled.' : ''}</p>}
      {current?.state === 'completed' && current.answer && <article className="local-ai-answer"><header><span><Check size={17} />Answer from the local model</span><small>AI-generated · check important facts</small></header><div className="local-ai-answer-text">{current.answer}</div><footer><span>{current.usage?.inputTokens ?? 'Unknown'} input · {current.usage?.outputTokens ?? 'unknown'} output tokens</span><span>{current.usage ? `${(current.usage.wallMs / 1000).toFixed(2)} s inference` : 'Timing unavailable'}</span><span>{current.usage?.tokensPerSecond != null ? `${current.usage.tokensPerSecond.toFixed(1)} output tok/s` : 'Decode rate unavailable'}</span><span>{current.mode === 'library' ? 'Free answer · no payment' : `${amount(current.payment.amountAtomic)} ${price?.symbol ?? 'tUSDG'} settled`}</span>{receiptHash && <a href={`https://explorer.testnet.chain.robinhood.com/tx/${receiptHash}`} target="_blank" rel="noopener noreferrer">Payment receipt <ExternalLink size={13} /></a>}</footer></article>}
      {current?.purgedAt && <p className="local-ai-meta" role="status">The question and answer were removed from the server after the retention period.</p>}
      {current && !current.purgedAt && <div className="local-ai-request-id"><span>Request <code>{current.id}</code></span><button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void run('Reading the saved request', () => readSaved(current.id))}>Refresh saved result</button></div>}
      <p className="local-ai-meta">The configured model runs on the connected host. If it is unavailable, this service does not substitute a cloud model or a prepared answer.</p>
    </div>}
  </section>;
}
