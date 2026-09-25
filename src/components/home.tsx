'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Home as HomeIcon, Loader2, Plus } from 'lucide-react';
import { WalletAccessPanel, useRentalWallet } from '@/wallets';
import { parseAmount } from '@/domain/assets';
import type { JourneyStage, TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import { Badge, money } from './workspace-panels';

const STAGES: { id: JourneyStage; label: string }[] = [
  { id: 'agreement', label: 'Agreement' },
  { id: 'space', label: 'Deposit space' },
  { id: 'deposit', label: 'Deposit' },
  { id: 'living', label: 'Living here' },
  { id: 'move-out', label: 'Move-out' },
  { id: 'paid', label: 'Paid out' },
];
const AUTO: Record<string, true> = { confirming: true, paying_out: true, wait: true };
type Unavailable = { agreementId: string; property: string; unavailable: string };
/** Typed view of our own same-origin API responses. */
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const b64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toB64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

export function MyHome({ openConnections }: { openConnections: () => void }) {
  const wallet = useRentalWallet();
  if (!wallet.authenticated)
    return (
      <section className="card home-intro">
        <span className="eyebrow">YOUR REAL TENANCY</span>
        <h1>Sign in with a passkey</h1>
        <p className="section-copy">
          Landlords post a home, tenants apply, and the deposit is secured and returned on the Solana test network.
          Everything uses test USDC; nothing here is real money.
        </p>
        <WalletAccessPanel />
      </section>
    );
  return <SignedInHome key={wallet.subject} openConnections={openConnections} />;
}

function SignedInHome({ openConnections }: { openConnections: () => void }) {
  const wallet = useRentalWallet();
  const [tenancies, setTenancies] = useState<(TenancyJourney | Unavailable)[] | null>(null);
  const [listings, setListings] = useState<PublicListing[]>([]);
  const [error, setError] = useState('');
  const request = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const token = await wallet.getAccessToken();
    if (!token) throw new Error('Sign in again to continue.');
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Please try again.'), { code: data.code });
    // Same-origin API: the route defines this shape.
    const typed: T = data;
    return typed;
  }, [wallet]) as Request;
  const fetchAll = useCallback(
    () =>
      Promise.all([
        request<{ tenancies: (TenancyJourney | Unavailable)[] }>('/api/journey'),
        request<{ listings: PublicListing[] }>('/api/listings'),
      ]),
    [request],
  );
  const load = useCallback(async () => {
    const [journey, homes] = await fetchAll();
    setTenancies(journey.tenancies);
    setListings(homes.listings);
  }, [fetchAll]);
  useEffect(() => {
    let active = true;
    fetchAll()
      .then(([journey, homes]) => {
        if (!active) return;
        setTenancies(journey.tenancies);
        setListings(homes.listings);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [fetchAll]);
  // Keep waiting states fresh without any "check result" button.
  const waiting = tenancies?.some((t) => 'unavailable' in t || AUTO[t.next.kind]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [waiting, load]);

  const invitation = typeof window !== 'undefined' ? new URLSearchParams(window.location.hash.slice(1)).get('invitation') : null;
  return (
    <div className="home">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR REAL TENANCY · SOLANA TEST NETWORK</span>
          <h1>Your home</h1>
          <p>One next step at a time. Test USDC only.</p>
        </div>
      </div>
      {error && <p className="note" role="alert">{error}</p>}
      {invitation && <JoinInvitation request={request} encoded={invitation} onDone={load} />}
      {tenancies === null ? (
        <section className="card"><Loader2 className="spin" size={18} /> Loading…</section>
      ) : (
        tenancies.map((t) =>
          'unavailable' in t ? (
            <section className="card" key={t.agreementId}><h2>{t.property}</h2><p className="note">{t.unavailable}</p></section>
          ) : (
            <TenancyCard key={t.agreementId} journey={t} request={request} reload={load} openConnections={openConnections} />
          ),
        )
      )}
      <Homes listings={listings} request={request} reload={load} />
    </div>
  );
}

function Progress({ stage }: { stage: JourneyStage }) {
  const current = STAGES.findIndex((s) => s.id === stage);
  return (
    <ol className="journey-progress" aria-label="Tenancy progress">
      {STAGES.map((s, index) => (
        <li key={s.id} className={index < current ? 'done' : index === current ? 'current' : ''} aria-current={index === current ? 'step' : undefined}>
          <span className="journey-dot">{index < current ? <Check size={12} /> : index + 1}</span>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function TenancyCard({ journey, request, reload, openConnections }: {
  journey: TenancyJourney; request: Request; reload: () => Promise<void>; openConnections: () => void;
}) {
  const wallet = useRentalWallet();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [amount, setAmount] = useState('0');
  const [reason, setReason] = useState('');
  const [link, setLink] = useState('');
  const advancing = useRef(false);
  const { next, chain, agreementId } = journey;
  const q = `?agreement=${encodeURIComponent(agreementId)}`;

  // Payouts need no wallet: the sponsor runs them as soon as the settlement is final.
  useEffect(() => {
    if (next.kind !== 'paying_out' || advancing.current) return;
    advancing.current = true;
    request('/api/journey', { action: 'advance', agreementId }).catch(() => {}).finally(() => { advancing.current = false; });
  }, [next.kind, agreementId, request]);
  // Confirmations are checked automatically.
  useEffect(() => {
    if (next.kind !== 'confirming') return;
    const path = next.operationId ? `/api/finance/solana/operations/${next.operationId}/reconcile${q}` : `/api/finance/solana/initialize${q}`;
    const body = next.operationId ? {} : { action: 'reconcile' };
    const timer = setInterval(() => request(path, body).then(reload).catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [next, q, request, reload]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
      await reload();
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined;
      setMessage(code === 'operation_expired' ? 'That took a little too long. Press the button again.' : e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  async function sign(input: { id: string; walletId: string; expiresAt: string; transactionBase64: string; feePayer: string; walletChain: string | null }, description: string) {
    if (input.walletChain !== 'solana:devnet') throw new Error('Browser approval is available on the devnet deployment only.');
    return toB64(await wallet.signSolanaTransaction({
      operationId: input.id, walletId: input.walletId, chain: 'solana:devnet', feePayer: input.feePayer,
      expiresAt: input.expiresAt, transaction: b64(input.transactionBase64), description,
    }));
  }
  async function operation(action: Record<string, unknown>, description: string, evidence?: string) {
    if (!chain) throw new Error('The tenancy is not readable yet.');
    const { operation: op } = await request<{ operation: { id: string; walletId: string; expiresAt: string; transactionBase64: string } }>(
      `/api/finance/solana/operations${q}`, { requestId: crypto.randomUUID(), action });
    if (evidence)
      await request(`/api/agreements/${agreementId}`, { action: 'record', name: description, body: `${evidence}\n\nPrepared operation ${op.id}. Only a finalized result changes the tenancy.` });
    const signed = await sign({ ...op, feePayer: chain.feePayer, walletChain: chain.walletChain }, description);
    await request(`/api/finance/solana/operations/${op.id}/authorize${q}`, { signedTxBase64: signed });
  }
  async function primary() {
    switch (next.kind) {
      case 'invite_arbitrator': {
        const { invitation } = await request<{ invitation: unknown }>(`/api/agreements/${agreementId}`, { action: 'invite', role: 'arbitrator' });
        setLink(`${window.location.origin}/#invitation=${encodeURIComponent(JSON.stringify(invitation))}`);
        return;
      }
      case 'accept_agreement':
        await request(`/api/agreements/${agreementId}`, { action: 'accept', digest: next.digest });
        return;
      case 'create_space': {
        const { initialization: init } = await request<{
          initialization: { state: string; walletId: string; expiresAt: string; transactionBase64: string; feePayer: string; walletChain: string | null };
        }>(`/api/finance/solana/initialize${q}`, { action: 'prepare' });
        if (init.state !== 'prepared') return;
        const signed = await sign({ ...init, id: `setup-${agreementId}` }, 'Create the deposit space');
        await request(`/api/finance/solana/initialize${q}`, { action: 'sign', signedTxBase64: signed });
        return;
      }
      case 'secure_deposit':
        return operation({ kind: 'fund_and_supply' }, 'Secure the deposit and start lending');
      case 'settle':
        return operation({ kind: 'redeem_and_settle' }, 'Complete the settlement');
      case 'finish_setup':
        openConnections();
        return;
    }
  }
  const needsReason = (value: string) => {
    if (reason.trim().length < 12) throw new Error('Add a short reason (at least 12 characters).');
    return value;
  };
  const oneButton = ['invite_arbitrator', 'accept_agreement', 'create_space', 'secure_deposit', 'settle', 'finish_setup'].includes(next.kind);
  return (
    <section className="card tenancy-card">
      <div className="section-heading">
        <h2><HomeIcon size={18} /> {journey.property}</h2>
        <Badge tone="neutral">You are the {journey.role}</Badge>
      </div>
      <Progress stage={journey.stage} />
      <div className={`next-step-card ${AUTO[next.kind] || next.kind === 'done' ? 'passive' : ''}`}>
        <span className="eyebrow">{next.kind === 'wait' ? 'NOTHING TO DO RIGHT NOW' : next.kind === 'done' ? 'FINISHED' : 'YOUR NEXT STEP'}</span>
        <h3>{AUTO[next.kind] && next.kind !== 'wait' && <Loader2 className="spin" size={18} />} {next.label}</h3>
        <p>{next.detail}</p>
        {oneButton && (
          <button className="button primary large" disabled={busy} onClick={() => run(primary)}>
            {busy ? <Loader2 className="spin" size={18} /> : null}
            {next.kind === 'accept_agreement' ? 'Accept' : next.kind === 'finish_setup' ? 'Open account check' : next.label}
            <ArrowRight size={17} />
          </button>
        )}
        {next.kind === 'propose_claim' && (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(() => operation({ kind: 'propose_claim', amountAtomic: parseAmount(amount) }, 'Move-out deduction', needsReason(reason))); }}>
            <label>Deduction in USDC<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. No damage, flat handed over clean" /></label>
            <button className="button primary large" disabled={busy}>Send to tenant <ArrowRight size={17} /></button>
          </form>
        )}
        {next.kind === 'respond_claim' && (
          <div className="inline-form">
            <button className="button primary large" disabled={busy} onClick={() => run(() => operation({ kind: 'accept_and_settle' }, 'Agree and settle the deposit'))}>
              Agree and get my deposit back <ArrowRight size={17} />
            </button>
            <details>
              <summary>I disagree</summary>
              <label>Why?<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              <button className="button secondary" disabled={busy} onClick={() => run(() => operation({ kind: 'respond_to_claim', accept: false }, 'Dispute the deduction', needsReason(reason)))}>
                Send to arbitrator
              </button>
            </details>
          </div>
        )}
        {next.kind === 'decide_claim' && (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(() => operation({ kind: 'resolve_and_settle', amountAtomic: parseAmount(amount) }, 'Arbitration decision', needsReason(reason))); }}>
            <label>Landlord receives (max {money(next.claimAtomic)})<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <button className="button primary large" disabled={busy}>Decide and settle <ArrowRight size={17} /></button>
          </form>
        )}
        {link && (
          <div className="invite-link">
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="button secondary" onClick={() => navigator.clipboard.writeText(link)}><Copy size={15} /> Copy</button>
            <p className="small-copy">Send this private link to the arbitrator. It works once, for 24 hours.</p>
          </div>
        )}
        {message && <p className="note" role="status">{message}</p>}
      </div>
      {chain && (
        <dl className="journey-facts">
          <div><dt>Required deposit</dt><dd>{money(journey.requiredSecurity)}</dd></div>
          {chain.phase === 'closed' ? (
            <>
              <div><dt>Tenant received</dt><dd>{money(chain.tenantPaidAtomic)}</dd></div>
              <div><dt>Landlord received</dt><dd>{money(chain.landlordPaidAtomic)}</dd></div>
            </>
          ) : (
            <>
              <div><dt>In lending</dt><dd>{money(chain.lendingValueAtomic)}</dd></div>
              <div><dt>Deduction proposed</dt><dd>{money(chain.claimAtomic)}</dd></div>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

function JoinInvitation({ request, encoded, onDone }: { request: Request; encoded: string; onDone: () => Promise<void> }) {
  const [message, setMessage] = useState('');
  async function join() {
    try {
      const value = JSON.parse(encoded);
      await request(`/api/agreements/${encodeURIComponent(value.id)}`, { action: 'join', role: value.role, token: value.token });
      history.replaceState(null, '', window.location.pathname + window.location.search);
      await onDone();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The invitation could not be used.');
    }
  }
  return (
    <section className="card next-step-card">
      <span className="eyebrow">INVITATION</span>
      <h3>You were invited as a neutral arbitrator</h3>
      <p>You only act if tenant and landlord disagree at move-out.</p>
      <button className="button primary large" onClick={join}>Join this tenancy <ArrowRight size={17} /></button>
      {message && <p className="note">{message}</p>}
    </section>
  );
}

function Homes({ listings, request, reload }: { listings: PublicListing[]; request: Request; reload: () => Promise<void> }) {
  const [posting, setPosting] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', rent: '900', deposit: '10', releaseAllowed: true });
  const [applyTo, setApplyTo] = useState<string | null>(null);
  const [application, setApplication] = useState({ name: '', message: '' });
  const [message, setMessage] = useState('');
  async function act(work: () => Promise<unknown>) {
    setMessage('');
    try {
      await work();
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Please try again.');
    }
  }
  const mine = listings.filter((l) => l.relation === 'landlord');
  const others = listings.filter((l) => l.relation !== 'landlord');
  return (
    <section className="card homes">
      <div className="section-heading">
        <h2>Homes</h2>
        <button className="button secondary" onClick={() => setPosting(!posting)}><Plus size={15} /> Post a home</button>
      </div>
      {message && <p className="note" role="alert">{message}</p>}
      {posting && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act(async () => {
          await request('/api/listings', { title: form.title, description: form.description, rentMonthly: parseAmount(form.rent), requiredSecurity: parseAmount(form.deposit), releaseAllowed: form.releaseAllowed });
          setPosting(false);
        }); }}>
          <label>Address or title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label>Monthly rent (USDC)<input inputMode="decimal" value={form.rent} onChange={(e) => setForm({ ...form, rent: e.target.value })} /></label>
          <label>Deposit (test USDC)<input inputMode="decimal" value={form.deposit} onChange={(e) => setForm({ ...form, deposit: e.target.value })} /></label>
          <label className="policy-check"><input type="checkbox" checked={form.releaseAllowed} onChange={(e) => setForm({ ...form, releaseAllowed: e.target.checked })} /> Earnings above the deposit belong to the tenant</label>
          <button className="button primary">Publish</button>
        </form>
      )}
      {mine.map((l) => (
        <article className="listing" key={l.id}>
          <header><strong>{l.title}</strong><Badge tone={l.status === 'open' ? 'green' : 'neutral'}>{l.status === 'open' ? `${l.applicants} applicant(s)` : 'Tenant chosen'}</Badge></header>
          <p className="small-copy">{money(l.rentMonthly)} / month · {money(l.requiredSecurity)} deposit</p>
          {l.status === 'open' && l.applications?.map((a) => (
            <div className="applicant" key={a.id}>
              <div><strong>{a.name}</strong><p>{a.message}</p></div>
              <button className="button primary" onClick={() => act(() => request(`/api/listings/${l.id}`, { action: 'choose', applicationId: a.id }))}>Choose</button>
            </div>
          ))}
        </article>
      ))}
      {others.length === 0 && mine.length === 0 && <p className="small-copy">No homes are listed yet.</p>}
      {others.map((l) => (
        <article className="listing" key={l.id}>
          <header><strong>{l.title}</strong>
            <Badge tone={l.relation === 'chosen' ? 'green' : 'neutral'}>
              {l.relation === 'chosen' ? 'You got it' : l.relation === 'applicant' ? (l.status === 'let' ? 'Not chosen' : 'Applied') : 'Available'}
            </Badge>
          </header>
          <p className="small-copy">{money(l.rentMonthly)} / month · {money(l.requiredSecurity)} deposit{l.releaseAllowed ? ' · deposit earnings are yours' : ''}</p>
          {l.description && <p>{l.description}</p>}
          {l.relation === null && (applyTo === l.id ? (
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act(async () => {
              await request(`/api/listings/${l.id}`, { action: 'apply', ...application });
              setApplyTo(null);
            }); }}>
              <label>Your name<input required value={application.name} onChange={(e) => setApplication({ ...application, name: e.target.value })} /></label>
              <label>About you<input required value={application.message} onChange={(e) => setApplication({ ...application, message: e.target.value })} /></label>
              <button className="button primary">Send application</button>
            </form>
          ) : (
            <button className="button primary" onClick={() => setApplyTo(l.id)}>Apply</button>
          ))}
        </article>
      ))}
    </section>
  );
}
