'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ExternalLink, Library, Loader2, RefreshCw, Send, Wallet } from 'lucide-react';
import { readLocalAiResponse } from './local-ai-response';
import { useRentalWallet } from '@/wallets';
import type { LocalAiApproval, LocalAiMode, LocalAiRequest, LocalAiServiceStatus, LocalAiUsageSummary } from '@/server/local-ai-types';
import { LOCAL_AI_NAVIGATION_INTENT } from './areas';
import { localAiPaymentHeaders } from './local-ai-payment';
import { LocalAiHost } from './local-ai-host';
import { HostKindBadge } from './home-node-host-badge';
import { inferenceApprovalForReview, inferenceNextAction, LOCAL_AI_RECEIPT_KEY } from './local-ai-review';
import { cityQuestionStart, deskAvailability, lastAnswerText } from './local-ai-availability';
import { coveredNames } from './city-coverage';
import { useSectionTabActive } from './section-tabs';
import './local-ai.css';
import { LocalAiProgress } from './local-ai-progress';
import { aiApprovalPollId, aiRequestPollId, aiSelectedHostStatus, aiTerminalError, isAiRequestTerminal } from './local-ai-progress-state';
import { MoreList, MoreRow, ScreenNote } from './blocks';
import { prepareSolanaInferenceApproval } from '../wallets/solana-inference-signing';

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
type Draft = { id: string; mode: LocalAiMode; prompt: string; maxOutputTokens: number; context: 'general'; hostScope: 'own' | 'city'; publicQuestion: boolean };

export function LocalAiWorkspace({ initialMode = 'paid', publicAccess = false, cityId = null }: { initialMode?: LocalAiMode; publicAccess?: boolean; cityId?: string | null }) {
  const wallet = useRentalWallet();
  return <LocalAiPanel key={publicAccess ? 'public-library' : wallet.subject ?? 'anonymous'} initialMode={initialMode} publicAccess={publicAccess} cityId={cityId} />;
}

function LocalAiPanel({ initialMode, publicAccess, cityId }: { initialMode: LocalAiMode; publicAccess: boolean; cityId: string | null }) {
  const wallet = useRentalWallet();
  const activeTab = useSectionTabActive();
  const { authenticated, getAccessToken, subject } = wallet;
  const [mode, setMode] = useState<LocalAiMode>(publicAccess ? 'library' : initialMode);
  const [service, setService] = useState<LocalAiServiceStatus | null>(null);
  const [usage, setUsage] = useState<LocalAiUsageSummary | null>(null);
  const [prompt, setPrompt] = useState(cityId ? `${cityQuestionStart(cityId)}What should a newcomer check about housing and city plans there? Answer in three short sentences.` : samples[0].text);
  const [outputLimit, setOutputLimit] = useState(128);
  const [hostScope, setHostScope] = useState<'own' | 'city'>(publicAccess || initialMode === 'library' ? 'city' : 'own');
  const [publicQuestion, setPublicQuestion] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [current, setCurrent] = useState<LocalAiRequest | null>(null);
  const [savedRequestId, setSavedRequestId] = useState<string | null>(null);
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
    const token = authenticated && (paid || path.endsWith('/status') && mode === 'paid') ? await getAccessToken() : null;
    if (!mounted.current) throw new Error('This workspace is no longer active.');
    if (paid && (!authenticated || !token)) throw new Error('Sign in with your passkey to use paid access.');
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const requestId = /^\/api\/local-ai\/requests\/([^/]+)$/.exec(path)?.[1];
    return readLocalAiResponse<T>(response, requestId, body ? 'POST' : 'GET');
  }, [mode, authenticated, getAccessToken]);

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
    setSavedRequestId(null); setError(''); setCurrent(next); setApproval(next.approval); setPrompt(next.purgedAt ? '' : next.prompt); if (next.purgedAt) setDraft(null); setOutputLimit(next.maxOutputTokens);
    setHostScope(next.hostScope ?? 'own'); setPublicQuestion(next.publicQuestion ?? false);
    if (isAiRequestTerminal(next)) {
      setPaymentSubmitted(false); paymentHeaders.current = null;
      if (next.mode === 'paid' && next.state === 'completed' && next.payment.state === 'settled' && next.payment.receipt?.success) {
        try { if (subject) sessionStorage.setItem(`${LOCAL_AI_RECEIPT_KEY}:${subject}`, next.id); } catch { /* The saved server receipt remains available in this view. */ }
        window.dispatchEvent(new CustomEvent('ledger-balances-changed', { detail: { chain: next.solanaReview ? 'solana' : 'evm' } }));
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
      if (activeTab && document.visibilityState === 'visible' && ['evm', 'solana'].includes((event as CustomEvent<{ chain?: string }>).detail?.chain ?? '') && !action.current) void refresh();
    };
    const onVisible = () => { if (activeTab && document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('ledger-balances-changed', balancesChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener('ledger-balances-changed', balancesChanged); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, activeTab]);
  useEffect(() => {
    let active = true;
    const requests = requestRevision;
    queueMicrotask(() => {
      if (!active || !mounted.current) return;
      let id: string | null = null;
      try {
        const stored = sessionStorage.getItem(storageKey);
        if (stored && /^[0-9a-f-]{36}$/i.test(stored)) id = stored;
      } catch { /* Session storage is optional; requests themselves are persisted on the server. */ }
      setSavedRequestId(id);
      if (id) void readSaved(id).catch((cause: unknown) => {
        if (active && mounted.current) setError(`Saved request unavailable: ${errorMessage(cause)}`);
      });
    });
    return () => { active = false; ++requests.current; };
  }, [storageKey, readSaved]);
  useEffect(() => {
    if (publicAccess) return;
    const consume = () => {
      const selected = sessionStorage.getItem(LOCAL_AI_NAVIGATION_INTENT);
      if ((selected !== 'paid' && selected !== 'library') || action.current || savedRequestId || current?.state === 'running' || current?.state === 'settling') return;
      sessionStorage.removeItem(LOCAL_AI_NAVIGATION_INTENT);
      queueMicrotask(() => { ++requestRevision.current; setMode(selected); setCurrent(null); setSavedRequestId(null); setDraft(null); setApproval(null); setError(''); setHostScope(selected === 'library' ? 'city' : 'own'); setPublicQuestion(false); setPaymentSubmitted(false); paymentHeaders.current = null; });
    };
    consume(); window.addEventListener(LOCAL_AI_NAVIGATION_INTENT, consume);
    return () => window.removeEventListener(LOCAL_AI_NAVIGATION_INTENT, consume);
  }, [publicAccess, current, savedRequestId]);

  const unresolvedId = aiRequestPollId(current);
  const hasUnresolvedRequest = current?.state === 'running' || current?.state === 'settling';
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

  const approvalPending = aiApprovalPollId(current, approval);
  useEffect(() => {
    if (!approvalPending) return;
    let checking = false; let active = true;
    const check = () => {
      if (checking || action.current || !activeTab || document.visibilityState === 'hidden') return;
      checking = true;
      void api<{ approval: LocalAiApproval }>(`/api/local-ai/requests/${approvalPending}/approval`, { action: 'reconcile' }, undefined, true).then(({ approval: next }) => {
        if (!active) return;
        setApproval(next);
        if (next.state === 'completed') { void refresh(); void readSaved(approvalPending); }
      }, (cause: unknown) => { if (active) setError(`Access approval remains unresolved: ${errorMessage(cause)}`); }).finally(() => { checking = false; });
    };
    const timer = window.setInterval(check, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [approvalPending, api, refresh, activeTab, readSaved]);

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
    ++requestRevision.current; setMode(nextMode); setCurrent(null); setSavedRequestId(null); setDraft(null); setApproval(null); setError(''); setPaymentSubmitted(false); paymentHeaders.current = null;
    setHostScope(nextMode === 'library' ? 'city' : 'own'); setPublicQuestion(false);
    if (nextMode === mode) try { sessionStorage.removeItem(storageKey); } catch { /* No persistent request link was available. */ }
  }
  function submitQuestion() {
    if (savedRequestId || current) return;
    if (service?.mode !== 'direct' && hostScope === 'city' && !publicQuestion) { setError('Confirm that your question is public before using a city host.'); return; }
    void run(mode === 'paid' && !ownComputeAvailable ? 'Preparing your payment review' : 'Asking the local model', async () => {
      if (mode === 'library') {
        const session = await api<{ sessionReady: boolean }>('/api/local-ai/library-session');
        if (!session.sessionReady) throw new Error('A private visitor session could not be established.');
        if (!mounted.current) return;
      }
      const nextDraft: Draft = draft ?? { id: crypto.randomUUID(), mode, prompt: prompt.trim(), maxOutputTokens: Math.min(outputLimit, maximumOutput), context: 'general', hostScope, publicQuestion };
      setDraft(nextDraft); saveId(nextDraft.id);
      try {
        const { mode: accessMode, prompt: question, maxOutputTokens, context, hostScope: scope, publicQuestion: consent } = nextDraft;
        const result = await api<{ request: LocalAiRequest }>(`/api/local-ai/requests/${nextDraft.id}`, {
          mode: accessMode, prompt: question, maxOutputTokens, context, hostScope: scope, publicQuestion: consent,
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
    if (!current || current.recovery || inferenceNextAction(current) !== 'payment-review') return;
    void run('Preparing a finite access budget', async () => {
      const result = await api<{ approval: LocalAiApproval }>(`/api/local-ai/requests/${current.id}/approval`, { action: 'prepare' }, undefined, true);
      if (mounted.current) setApproval(result.approval);
    });
  }
  function signApproval() {
    if (!current || current.recovery || inferenceNextAction(current) !== 'payment-review' || (!approval?.request && !approval?.solanaRequest)) return;
    void run('Waiting for your one-answer allowance signature', async () => {
      let signedTransaction: string;
      if (current.solanaReview) {
        const signing = await prepareSolanaInferenceApproval(current, approval, wallet.wallets.find(selected => selected.id === current.solanaReview!.walletId));
        const bytes = await wallet.signSolanaTransaction(signing);
        signedTransaction = btoa(String.fromCharCode(...bytes));
      } else {
        const signing = inferenceApprovalForReview(current, approval);
        signedTransaction = await wallet.signEvmTransaction(signing);
      }
      if (!mounted.current) return;
      setBusy('Confirming the access budget');
      try {
        const result = await api<{ approval: LocalAiApproval }>(`/api/local-ai/requests/${current.id}/approval`, { action: 'submit', signedTransaction }, undefined, true);
        if (mounted.current) {
          setApproval(result.approval);
          if (current.solanaReview && result.approval.state === 'completed') await readSaved(current.id);
        }
      } catch (cause) {
        try { await readSaved(current.id); } catch { /* The durable approval remains the authority after a lost response. */ }
        throw cause;
      }
    });
  }
  function payAndAsk() {
    if (!current || current.purgedAt || inferenceNextAction(current) !== 'payment-review') return;
    void run(paymentHeaders.current ? 'Resuming the same authorized request' : 'Waiting for your one-answer authorization', async () => {
      if (!current.solanaReview && !paymentHeaders.current) paymentHeaders.current = await localAiPaymentHeaders(wallet, current);
      if (!mounted.current) return;
      setBusy('Submitting the saved payment authorisation · waiting for server evidence'); setPaymentSubmitted(true);
      try {
        const result = await api<{ request: LocalAiRequest }>(`/api/local-ai/requests/${current.id}`, {
          mode: current.mode, prompt: current.prompt, maxOutputTokens: current.maxOutputTokens, context: 'general', hostScope: current.hostScope ?? 'own', publicQuestion: current.publicQuestion ?? false,
        }, paymentHeaders.current ?? undefined, true);
        if (mounted.current) accept(result.request);
      } catch (cause) {
        try { await readSaved(current.id); } catch { /* No replacement authorization or inference is started. */ }
        throw cause;
      }
    });
  }
  function resumeSaved() {
    if (!current || current.purgedAt || inferenceNextAction(current) !== 'resume') return;
    void run('Recovering the saved request', async () => {
      const result = await api<{ request: LocalAiRequest }>(`/api/local-ai/requests/${current.id}`, {
        mode: current.mode, prompt: current.prompt, maxOutputTokens: current.maxOutputTokens, context: 'general', hostScope: current.hostScope ?? 'own', publicQuestion: current.publicQuestion ?? false,
      }, paymentHeaders.current ?? undefined, current.mode === 'paid');
      if (mounted.current) accept(result.request);
    });
  }

  const price = current?.review ? { ...service?.price, network: 'eip155:46630' as const, asset: current.review.asset,
    payTo: current.review.payTo, symbol: 'tUSDG', amountAtomic: '100', decimals: 6 as const, permit2: service?.price?.network === 'eip155:46630' ? service.price.permit2 : '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    proxy: '', approvalBudgetAtomic: '100000' } : service?.price;
  const solanaPayment = !!current?.solanaReview || (!current?.review && price?.network === 'solana-devnet');
  const cashSymbol = solanaPayment ? 'tUSDC' : 'tUSDG';
  const maximumOutput = mode === 'library' ? service?.library.maxOutputTokens ?? 128 : service?.maxOutputTokens ?? 256;
  const maximumPaymentAtomic = (BigInt(current?.maxOutputTokens ?? Math.min(outputLimit, maximumOutput)) * 100n).toString();
  const connectorHosts = service?.hosts?.filter((host) => host.state === 'active') ?? [];
  const connectorMode = service?.mode !== 'direct';
  const ownComputeAvailable = connectorMode && Boolean(service?.ownHostAvailable);
  const ownCompute = current ? Boolean(current.host?.own && current.payment.state === 'none') : ownComputeAvailable;
  const needsApproval = Boolean(current && !ownCompute && price && approval?.state !== 'completed');
  const paidFundingReason = mode !== 'paid' || ownCompute || !service || !wallet.authenticated ? '' : !price
    ? 'The test-cash price is unavailable.'
    : current?.review && service.price?.network === 'solana-devnet' ? ''
      : service.wallet?.cashAtomic == null ? `${solanaPayment ? 'Solana devnet' : 'Robinhood Chain'} wallet cash could not be checked.`
        : BigInt(service.wallet.cashAtomic) < BigInt(maximumPaymentAtomic) ? `This answer authorizes at most ${amount(maximumPaymentAtomic)} ${cashSymbol}; this wallet needs more test cash.`
          : !solanaPayment && approval?.state !== 'completed' && service.wallet?.nativeAtomic === '0' ? 'Network-fee test ETH is needed for the payment-budget approval.'
          : '';
  // "Only my own hosts" without one would only earn a refusal from the server; say what to do instead.
  const scopeReason = connectorMode && mode === 'paid' && wallet.authenticated && hostScope === 'own' && !ownComputeAvailable
    ? 'No GPU host of yours is online or able to wake. To ask a city host, choose “Allow city hosts” and confirm that your question is public.' : '';
  const deskState = deskAvailability(service, mode, hostScope);
  const canStart = Boolean((service?.reachable || ownComputeAvailable) && !statusError && !scopeReason && deskState.canAsk && (!connectorMode || hostScope === 'own' || publicQuestion) && (mode === 'library' ? service?.library.enabled && (service.library.remainingRequests ?? 0) > 0 : wallet.authenticated && (ownComputeAvailable || (service?.paidEnabled && !paidFundingReason))));
  const receiptHash = current?.payment.state === 'settled' && current.payment.receipt?.success && !ownCompute ? current.payment.receipt.transaction : null;
  const reviewing = current && !ownCompute && !current.purgedAt && inferenceNextAction(current) === 'payment-review';
  const readyToResume = current && !current.purgedAt && inferenceNextAction(current) === 'resume';
  const terminalError = current ? aiTerminalError(current) : null;
  const selectedHostStatus = current ? aiSelectedHostStatus(current, service?.hosts, Boolean(statusError)) : null;
  const locked = Boolean(busy || draft || current || savedRequestId);
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
  const availability = statusError ? 'offline' : service?.availability ?? (service?.reachable ? 'online' : 'offline');
  const nodeLabel = statusError ? 'Status unavailable' : availability === 'asleep' ? 'AI service asleep · wake not confirmed' : service?.reachable
    ? service.modelResident ? service.vramBytes && service.vramBytes > 0 ? 'GPU model resident' : 'Model resident · CPU' : 'Node ready · model on demand'
    : service ? 'Node unavailable' : 'Checking the node';

  return <section className="local-ai" id="local-ai" tabIndex={-1} aria-label="Local AI service">
    <header className="local-ai-heading"><h2>Ask the city AI</h2><span className={`local-ai-node-state ${availability}`}><span />{nodeLabel}</span><button type="button" className="text-button" aria-label="Refresh node status" onClick={() => void refresh()}><RefreshCw size={16} /></button></header>
    {(statusError || service?.error) && <p className="local-ai-alert" role="alert">{statusError || service?.error}</p>}
    <div className="local-ai-ask">
      {/* Default grace is 10 minutes; deployments may configure LOCAL_AI_TEXT_GRACE_SECONDS. */}
      <p className="local-ai-host-warning">The host reads your question; don&apos;t send private information.</p>
      <div className="local-ai-access" role="group" aria-label="Choose AI access"><button type="button" disabled={Boolean(busy || hasUnresolvedRequest || paymentSubmitted || savedRequestId)} aria-pressed={mode === 'paid'} onClick={() => resetQuestion('paid')}><Wallet size={18} /><span><strong>Paid</strong><small>{ownComputeAvailable ? 'Your host · no charge' : 'Review before paying'}</small></span></button><button type="button" disabled={Boolean(busy || hasUnresolvedRequest || paymentSubmitted || savedRequestId)} aria-pressed={mode === 'library'} onClick={() => resetQuestion('library')}><Library size={18} /><span><strong>Free</strong><small>Shared allowance</small></span></button></div>
      {mode === 'library' && <div className="local-ai-library-note"><Library size={18} /><p>The host covers the compute. {service?.library.remainingRequests != null ? `${service.library.remainingRequests} requests remaining within the shared service limits.` : 'A bounded visitor allowance keeps the shared node available.'}{!publicAccess && <> <a href="/library" target="_blank" rel="noopener noreferrer">Open the public desk <ArrowUpRight size={13} /></a></>}</p></div>}
      <div className="local-ai-question"><label htmlFor={publicAccess ? 'library-question' : 'local-ai-question'}>What would you like to explore?</label><div className="local-ai-samples">{samples.map((sample) => <button type="button" key={sample.label} disabled={locked} onClick={() => setPrompt(sample.text)}>{sample.label}</button>)}</div><textarea id={publicAccess ? 'library-question' : 'local-ai-question'} value={prompt} minLength={3} maxLength={2000} rows={3} disabled={locked} onChange={(event) => setPrompt(event.target.value)} />
        {connectorMode && hostScope === 'city' && !current && <label className="local-ai-consent"><input type="checkbox" checked={publicQuestion} disabled={locked} onChange={(event) => setPublicQuestion(event.target.checked)} /><span>My question is public and contains no private information. I consent to a city host reading it.</span></label>}
        <div className="local-ai-question-footer">{!current && !savedRequestId && <button type="button" className="primary-btn" disabled={Boolean(busy || !canStart || prompt.trim().length < 3)} title={!canStart ? deskState.reason || undefined : undefined} onClick={submitQuestion}>{busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}{draft ? 'Retry the same question' : mode === 'paid' ? ownComputeAvailable ? 'Ask on my host · no charge' : 'Review paid question' : 'Ask for free'}</button>}{current && isAiRequestTerminal(current) && <button type="button" className="primary-btn" disabled={Boolean(busy)} onClick={() => resetQuestion()}>Ask another question</button>}</div></div>
      {scopeReason && !current && <div className="local-ai-scope-action"><p className="local-ai-meta" role="status">{scopeReason}</p><button type="button" className="text-button" disabled={locked} onClick={() => { setHostScope('city'); setPublicQuestion(false); }}>Ask a city host instead</button></div>}
      {!current && !statusError && deskState.reason && <p className="local-ai-alert" role="status" data-testid="desk-unavailable">{deskState.reason}</p>}
      {!current && !statusError && deskState.notice && <p className="local-ai-meta" role="status" data-testid="desk-asleep">{deskState.notice}</p>}
      {mode === 'paid' && service && !(current && isAiRequestTerminal(current)) && <p role="status">{ownCompute ? 'Own compute · no charge. Your account gives you access; no payment authorization or receipt is needed.' : <>Pay per token: 0.0001 {cashSymbol} per generated token, at most {amount(maximumPaymentAtomic)} {cashSymbol} for this answer. {paidFundingReason || (needsApproval ? solanaPayment ? 'The site sponsor pays network fees.' : 'Approving the payment budget also needs network-fee test ETH.' : '')}</>}</p>}
      {cityId && <p className="local-ai-meta" data-testid="desk-city">Suggestions for {coveredNames[cityId]}. Edit or replace the question freely.</p>}
      {mode === 'library' && service && service.library.remainingRequests === 0 && <p role="status">The free allowance is exhausted. It resets at midnight UTC; paid answers remain a separate option.</p>}
      {mode === 'library' && service && !service.library.enabled && deskState.canAsk && <p role="status">The free public desk is switched off on this site. You can choose paid access instead.</p>}
      {mode === 'library' && <><button type="button" className="text-button" disabled={Boolean(busy)} onClick={clearLibraryDesk}>Finish &amp; clear this desk</button><p className="local-ai-meta">This cancels server jobs and purges your question and answer text from the server now. A host that already received your question cannot be made to forget it or delete its own copy.</p></>}
      {readyToResume && <div className="local-ai-payment-review"><h3>This question is saved and ready.</h3><p>The shared node was busy. Continue the same request{ownCompute ? ' on your own compute, with no charge or signature' : current?.mode === 'paid' ? ' with its existing payment authorization—no new signature' : ' for free'}.</p><button type="button" className="primary-btn" disabled={Boolean(busy)} onClick={resumeSaved}>Run this saved question</button></div>}
      {!current && draft && mode === 'paid' && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => resetQuestion()}>Change the unsubmitted question</button>}
      {mode === 'paid' && !wallet.authenticated && <p className="local-ai-meta">Sign in from Me for personal access, or choose the free public desk.</p>}
      {reviewing && <p className="local-ai-meta">You pay the host-reported generated token count, capped by the answer limit and the UTF-8 bytes of answer plus reasoning text received. This is at most the amount shown below, not a fixed charge.</p>}
      {reviewing && current.solanaReview && <div className="local-ai-payment-review"><span className="eyebrow">REVIEW THIS ANSWER</span><h3>At most {amount(current.solanaReview.amountAtomic)} tUSDC · 0.0001 tUSDC per generated token</h3><p>Solana devnet · test tokens only, no value. Your question and payout are fixed. Sign one sponsored SPL approval before the model runs.</p><dl><div><dt>Recipient</dt><dd><code>{current.solanaReview.payTo}</code> · {current.solanaReview.route === 'house' ? 'Neighbourhood Homes rewards, source AI' : 'Host owner verified Solana wallet'}</dd></div><div><dt>Delegate and fee payer</dt><dd><code>{current.solanaReview.delegate}</code></dd></div><div><dt>Token account</dt><dd><code>{current.solanaReview.source}</code></dd></div></dl><p>The site sponsor charges the host-reported generated token count capped by the answer limit and UTF-8 bytes of answer plus reasoning text received, never more than {amount(current.solanaReview.amountAtomic)} tUSDC. An unused allowance of at most this answer&apos;s maximum remains until your next approval replaces it.</p>{current.solanaReview.route === 'house' && <p>Rewards are streamed to stakers over 7 days. Fictional units carry no rights; deposit earnings belong to the tenant.</p>}{current.host && <p>Only <strong>{current.host.name}</strong> receives this fixed question. Its payout cannot change after this review.</p>}{approval?.state === 'review' && approval.solanaRequest ? <button type="button" className="primary-btn" disabled={Boolean(busy)} onClick={signApproval}>Approve at most {amount(current.solanaReview.amountAtomic)} tUSDC</button> : approval?.state === 'pending' ? <p>Confirming the same sponsored approval. No second signature is requested.</p> : approval?.state === 'completed' ? <button type="button" className="primary-btn" disabled={Boolean(busy)} onClick={resumeSaved}>Ask with the saved approval</button> : <button type="button" className="primary-btn" disabled={Boolean(busy)} onClick={prepareApproval}>Prepare sponsored approval</button>}{approval?.error && <p role="alert">{approval.error}</p>}{approval?.state !== 'pending' && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => resetQuestion()}>Change question</button>}</div>}
      {reviewing && !current.solanaReview && price && <div className="local-ai-payment-review"><span className="eyebrow">REVIEW THIS ANSWER</span><h3>Pay per token: 0.0001 tUSDG per generated token, at most {amount(current.review?.amountAtomic ?? maximumPaymentAtomic)} tUSDG for this answer</h3><p>Your question is fixed for this authorization. The node runs the model before it settles payment.</p><dl><div><dt>Network</dt><dd>Robinhood testnet · x402 v2</dd></div><div><dt>Recipient</dt><dd><code title={current.review?.payTo ?? price.payTo}>{short(current.review?.payTo ?? price.payTo)}</code></dd></div><div><dt>Wallet cash</dt><dd>{service?.wallet?.cashAtomic != null && service.price?.network === 'eip155:46630' ? `${amount(service.wallet.cashAtomic)} ${price.symbol}` : 'Unavailable'}</dd></div></dl>
        {current.host && <p>Payment review for <strong>{current.host.name}</strong> <HostKindBadge kind={current.host.kind} />. The server-recorded host class cannot be changed by the host&apos;s chosen name.</p>}
        {needsApproval ? <><p>Approve a finite {amount(price.approvalBudgetAtomic)} {price.symbol} Permit2 budget. Each answer still needs a separate authorization; the budget approval is not a service payment.</p>{approval?.state === 'review' && approval.request ? <><div aria-label="Access-budget transaction details"><p>Token <code>{price.asset}</code></p><p>Allowance spender <code>{price.permit2}</code></p><p>{approval.request.description}. The wallet also pays the approval transaction&apos;s network fee.</p></div><button type="button" className="primary-btn" disabled={Boolean(busy)} onClick={signApproval}>Sign access budget</button></> : approval?.state === 'pending' ? <p className="local-ai-progress"><Loader2 size={16} className="spin" />Confirming the signed access budget. No new transaction is being created.</p> : <button type="button" className="primary-btn" disabled={Boolean(busy || !canStart)} onClick={prepareApproval}>Review access budget</button>}</> : <button type="button" className="primary-btn" disabled={Boolean(busy || !canStart)} onClick={payAndAsk}>{paymentSubmitted ? 'Retry the same authorization' : `Authorize at most ${amount(current.review?.amountAtomic ?? maximumPaymentAtomic)} ${price.symbol} and ask`}</button>}
        {current.host && <p>You authorize this answer on <strong>{current.host.name}</strong> <HostKindBadge kind={current.host.kind} /> only. It receives your question; its saved payout recipient is shown above.</p>}
        {approval?.error && <p className="local-ai-alert" role="alert">{approval.error}</p>}{!paymentSubmitted && approval?.state !== 'pending' && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => resetQuestion()}>Change question</button>}
      </div>}
      {busy && !unresolvedId && <p className="local-ai-progress" role="status">{busy}</p>}
      {current && <LocalAiProgress request={current} />}
      {error && <p className="local-ai-alert" role="alert">{error}</p>}
      {savedRequestId && <div className="local-ai-payment-review"><p role="status">The saved request&apos;s outcome is not known until it can be read. An authorization is not proof of payment or an answer. Do not sign or submit another payment while recovering it.</p><button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void run('Reading the saved request', () => readSaved(savedRequestId))}>Read saved request again</button></div>}
      {(terminalError || current?.error) && <p className="local-ai-alert" role="alert">{terminalError || current?.error}</p>}
      {current?.recovery && !isAiRequestTerminal(current) && <div className="local-ai-payment-review"><p role="status">Automatic recovery checks are paused. {current.recovery.retryable ? 'Check this same saved request when you are ready; do not sign another approval or submit another payment.' : 'The saved request needs service recovery before it can continue. Do not sign another approval or submit another payment.'}</p>{current.recovery.retryable && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void run('Checking saved recovery', () => readSaved(current.id))}>Check saved recovery</button>}</div>}
      {selectedHostStatus && <p className="local-ai-meta" role="status">{selectedHostStatus}</p>}
      {current?.state === 'completed' && current.answer && (ownCompute || current.mode === 'library' || receiptHash) && <article className="local-ai-answer"><header><span><Check size={17} />Answer from the local model</span><small>AI-generated · check important facts</small></header><div className="local-ai-answer-text">{current.answer}</div><footer><span>{current.usage?.inputTokens ?? 'Unknown'} input · {current.usage?.outputTokens ?? 'unknown'} output tokens</span><span>{current.usage ? `${(current.usage.wallMs / 1000).toFixed(2)} s inference` : 'Timing unavailable'}</span><span>{current.usage?.tokensPerSecond != null ? `${current.usage.tokensPerSecond.toFixed(1)} output tok/s` : 'Decode rate unavailable'}</span><span>{ownCompute ? 'Own compute · no charge' : current.mode === 'library' ? 'Free answer · no payment' : receiptHash ? `${current.usage?.outputTokens ?? 'Unknown'} tokens · ${amount(current.payment.amountAtomic)} ${cashSymbol} settled` : 'Payment not settled'}</span>{receiptHash && <a href={current.solanaReview ? `https://explorer.solana.com/tx/${receiptHash}?cluster=devnet` : `https://explorer.testnet.chain.robinhood.com/tx/${receiptHash}`} target="_blank" rel="noopener noreferrer">Payment receipt {current.host && <HostKindBadge kind={current.host.kind} />} <ExternalLink size={13} /></a>}</footer></article>}
      {current?.purgedAt && <p className="local-ai-meta" role="status">The question and answer were removed from the server after the retention period.</p>}
      <MoreList>
      <MoreRow title="Options" meta={!current && scopeReason ? 'Needs you' : `${hostScope === 'own' ? 'Your hosts only' : 'City hosts'} · up to ${Math.min(outputLimit, maximumOutput)} answer tokens`}>
      {connectorMode && <fieldset className="local-ai-host-scope" disabled={locked}><legend>Where may your question run?</legend><label>Host access<select value={hostScope} onChange={(event) => { setHostScope(event.target.value as 'own' | 'city'); setPublicQuestion(false); }}>{mode === 'paid' && <option value="own">Only my own hosts</option>}<option value="city">Allow city hosts · public questions only</option></select></label><p className="local-ai-meta">{mode === 'library' ? 'Free questions use only hosts whose owners opted into the public allowance. No payment or payout.' : 'Own hosts are preferred.'} City access may send your question to another operator&apos;s device; it never substitutes a cloud model.</p></fieldset>}
      <label className="local-ai-answer-limit">Answer limit<select value={Math.min(outputLimit, maximumOutput)} disabled={locked} onChange={(event) => setOutputLimit(Number(event.target.value))}>{[64, 128, 256, 512].filter((value) => value <= maximumOutput).map((value) => <option value={value} key={value}>{value} output tokens</option>)}</select></label>
      </MoreRow>
      <MoreRow title="Host details" meta={current?.host?.name ?? `${connectorHosts.length} available hosts`}>
      <p>{service?.model || 'Local model'} · {service?.hardwareLabel || 'Configured local hardware'}{service?.vramBytes != null && service.vramBytes > 0 ? ` · ${(service.vramBytes / 2 ** 30).toFixed(1)} GiB model in VRAM` : ''}</p>
      {service && <p className="local-ai-meta">{lastAnswerText(service.lastSuccessAt)}</p>}
      {connectorMode && <div className="local-ai-host-directory" aria-label="Connector host availability">{connectorHosts.length ? <ul>{connectorHosts.map((host) => <li key={host.id}><div><strong>{host.name}</strong><HostKindBadge kind={host.kind} /><small>{host.own ? 'Your host' : 'City host'} · {host.models.join(', ') || 'No models reported'} · {host.freePublicAnswers ? 'Free public answers enabled' : 'No free public answers'}</small></div>{connectorHosts.some((other) => other.availability !== host.availability || other.canWake !== host.canWake) && <span className={`local-ai-node-state ${host.availability}`}><span />{host.availability}{host.availability === 'asleep' && host.canWake ? ' · wakes on request' : ''}</span>}</li>)}</ul> : <p className="local-ai-meta">No paired connector hosts are available. Connect a device in Devices &amp; income, or ask the desk operator to connect a host.</p>}</div>}
      {connectorMode && current?.host && <div className="local-ai-selected-host" role="status"><strong>Selected host: {current.host.name}</strong><HostKindBadge kind={current.host.kind} /><span>{current.host.own ? 'Your host · own compute · no charge' : current.mode === 'library' ? 'City host · free public answer · no payout' : 'City host'} · <code>{current.host.id}</code></span>{current.host.payoutWallet && <span>Payout wallet: <code>{current.host.payoutWallet}</code></span>}<p>Host reads your question. This saved request stays assigned to this host.</p></div>}
      </MoreRow>
      <MoreRow title="Service details" meta="Saved request and routing">
      {current && <div className="local-ai-request-id"><span>Request <code>{current.id}</code></span><button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void run('Reading the saved request', () => readSaved(current.id))}>Refresh saved result</button></div>}
      {current?.recovery && <p className="local-ai-meta" role="status">Saved recovery stage: <code>{current.recovery.stage}</code> · code: <code>{current.recovery.code}</code>. {current.recovery.retryable ? 'The same saved request can be checked again.' : 'No automatic retry is offered.'}</p>}
      <p className="local-ai-meta">Only the selected host runs this request. If it is unavailable, this service does not substitute a cloud model or a prepared answer.</p>
      <p className="local-ai-meta">Question and answer text is removed here after about 10 minutes, but the host may retain a copy.</p>
      </MoreRow>
      {!publicAccess && connectorMode && <LocalAiHost usage={usage} error={usageError} service={service} />}
      </MoreList>
    </div>
    {publicAccess && <ScreenNote>AI answers can be wrong. Paid answers use test money with no value.</ScreenNote>}
  </section>;
}
