'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Home as HomeIcon, Loader2, Plus } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import { AssetsOverview } from './assets';
import { AREAS, type Area } from './areas';
import { CityCard } from './city';
import { IdentityStrip } from './identity';
import { IdeasArea, PlannedHere } from './ideas';
import { MeArea } from './me';
import { AccountSetup, RoleIntro, RolePicker, useChosenRole, type ChosenRole } from './onboarding';
import { parseAmount } from '@/domain/assets';
import type { JourneyStage, TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import type { PortfolioView } from '@/server/portfolio';
import { Badge, money } from './workspace-panels';

const STAGES: { id: JourneyStage; label: string }[] = [
  { id: 'agreement', label: 'Agreement' },
  { id: 'space', label: 'Deposit space' },
  { id: 'deposit', label: 'Deposit' },
  { id: 'living', label: 'Living here' },
  { id: 'move-out', label: 'Move-out' },
  { id: 'paid', label: 'Paid out' },
];
const BUTTON_LABEL: Record<string, string> = {
  invite_arbitrator: 'Invite arbitrator',
  accept_agreement: 'Accept',
  create_space: 'Create deposit space',
  secure_deposit: 'Approve deposit',
  settle: 'Settle',
  finish_setup: 'Open account check',
};
const ROLE_LABEL: Record<ChosenRole, string> = { tenant: 'TENANT', landlord: 'LANDLORD', arbitrator: 'ARBITRATOR' };
const AUTO: Record<string, true> = { confirming: true, paying_out: true, wait: true };
type Unavailable = { agreementId: string; property: string; unavailable: string };
/** Typed view of our own same-origin API responses. */
type Helper = (body: Record<string, unknown>) => Promise<void>;
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const b64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toB64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

/** Authenticated same-origin JSON requests with the current Privy token. */
function useAuthorizedRequest(): Request {
  const wallet = useRentalWallet();
  return useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
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
}

export function MyHome({ area, go, openConnections, openDemo }: { area: Area; go: (area: Area) => void; openConnections: () => void; openDemo: () => void }) {
  const wallet = useRentalWallet();
  const [role, choose] = useChosenRole();
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const request = useAuthorizedRequest();
  const markReady = useCallback(() => setReadyFor(wallet.subject), [wallet.subject]);
  if (!role) return <RolePicker onPick={choose} onDemo={openDemo} />;
  if (!wallet.authenticated || readyFor !== wallet.subject)
    return <AccountSetup key={wallet.subject ?? 'signed-out'} role={role} authorized={request} onChangeRole={() => choose(null)} onReady={markReady} />;
  return <SignedInHome key={wallet.subject} area={area} go={go} role={role} onChangeRole={() => choose(null)} openConnections={openConnections} />;
}

function SignedInHome({ area, go, role, onChangeRole, openConnections }: { area: Area; go: (area: Area) => void; role: ChosenRole; onChangeRole: () => void; openConnections: () => void }) {
  const wallet = useRentalWallet();
  const [tenancies, setTenancies] = useState<(TenancyJourney | Unavailable)[] | null>(null);
  const [listings, setListings] = useState<PublicListing[]>([]);
  const [error, setError] = useState('');
  const [helpers, setHelpers] = useState(false);
  const [helperBusy, setHelperBusy] = useState(false);
  const [helperLog, setHelperLog] = useState('');
  const [usdc, setUsdc] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/test-helpers').then((r) => r.json()).then((d) => setHelpers(Boolean(d.enabled))).catch(() => {});
  }, []);
  const request = useAuthorizedRequest();
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
    // Confirmations refresh quickly; plain waiting (the other person's turn) refreshes gently.
    const fast = tenancies?.some((t) => 'next' in t && (t.next.kind === 'confirming' || t.next.kind === 'paying_out'));
    const timer = setInterval(() => load().catch(() => {}), fast ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [waiting, load, tenancies]);

  const helper: Helper | null = helpers
    ? async (body) => {
        setHelperBusy(true);
        setHelperLog('The test person is doing their step… (up to a minute on devnet)');
        try {
          const result = await request<{ done?: string[] }>('/api/test-helpers', body);
          setHelperLog(result.done?.length ? result.done.join(' · ') : 'Done.');
          await load();
        } catch (e) {
          setHelperLog(e instanceof Error ? e.message : 'The helper failed.');
        } finally {
          setHelperBusy(false);
        }
      }
    : null;
  const invitation = typeof window !== 'undefined' ? new URLSearchParams(window.location.hash.slice(1)).get('invitation') : null;
  const ready = (tenancies ?? []).filter((t): t is TenancyJourney => !('unavailable' in t));
  const heading: Record<Area, string> = {
    overview: 'Your overview',
    me: 'Me',
    home: role === 'landlord' ? 'Your homes' : role === 'arbitrator' ? 'Your cases' : 'Your home',
    money: 'Money',
    places: 'Places',
    ideas: 'Ideas',
  };
  const meta = AREAS.find((a) => a.id === area)!;
  return (
    <div className="home">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{ROLE_LABEL[role]} · TEST NETWORKS</span>
          <h1>{heading[area]}</h1>
          <p>{meta.question}</p>
        </div>
      </div>
      {error && <p className="note" role="alert">{error}</p>}
      {helpers && helperLog && (area === 'home' || area === 'overview') && (
        <p className="test-helper-note">
          {helperBusy && <Loader2 className="spin" size={14} />} {helperLog}
        </p>
      )}

      {area === 'overview' && (
        <div className="overview-grid">
          <NextStepSummary tenancies={tenancies} role={role} go={go} />
          <IdentityStrip request={request} compact onOpen={() => go('me')} />
          {role !== 'arbitrator' && tenancies !== null && <AssetsOverview request={request} tenancies={ready} testHelpers={helpers} show="summary" go={go} />}
          <CityCard request={request} compact onOpen={() => go('places')} />
        </div>
      )}

      {area === 'me' && (
        <>
          <MeArea request={request} role={ROLE_LABEL[role].toLowerCase()} tenancies={ready} onChangeRole={onChangeRole} go={go} openConnections={openConnections} />
          <PlannedHere area="me" go={go} />
        </>
      )}

      {area === 'home' && (
        <>
          <RoleIntro role={role} solanaAddress={wallet.wallets.find((w) => w.chainType === 'solana')?.address ?? null} testUsdcAtomic={usdc} />
          {invitation && <JoinInvitation request={request} encoded={invitation} onDone={load} />}
          {tenancies === null ? (
            <section className="card"><Loader2 className="spin" size={18} /> Loading…</section>
          ) : (
            tenancies.map((t) =>
              'unavailable' in t ? (
                <section className="card" key={t.agreementId}><h2>{t.property}</h2><p className="note">{t.unavailable}</p></section>
              ) : (
                <TenancyCard key={t.agreementId} journey={t} request={request} reload={load} openConnections={openConnections} helper={helper} helperBusy={helperBusy} />
              ),
            )
          )}
          {role !== 'arbitrator' && <Homes role={role} listings={listings} request={request} reload={load} helper={helper} helperBusy={helperBusy} />}
          {role !== 'arbitrator' && tenancies !== null && <AssetsOverview request={request} tenancies={ready} testHelpers={helpers} show="home" go={go} />}
          <PlannedHere area="home" go={go} />
        </>
      )}

      {area === 'money' && (
        <>
          {tenancies !== null && <AssetsOverview request={request} tenancies={ready} testHelpers={helpers} show="money" go={go} />}
          <Portfolio request={request} onBalance={setUsdc} />
          <PlannedHere area="money" go={go} />
        </>
      )}

      {area === 'places' && (
        <>
          <CityCard request={request} />
          <PlannedHere area="places" go={go} />
        </>
      )}

      {area === 'ideas' && <IdeasArea />}
    </div>
  );
}

/** The single most useful thing to do now, across all tenancies. */
function NextStepSummary({ tenancies, role, go }: { tenancies: (TenancyJourney | Unavailable)[] | null; role: ChosenRole; go: (area: Area) => void }) {
  const ready = (tenancies ?? []).filter((t): t is TenancyJourney => !('unavailable' in t));
  const actionable = ready.find((t) => !AUTO[t.next.kind] && t.next.kind !== 'done');
  const waiting = ready.find((t) => AUTO[t.next.kind]);
  const pick = actionable ?? waiting;
  return (
    <section className="card overview-tile next clickable" onClick={() => go('home')}>
      <span className="eyebrow">YOUR NEXT STEP</span>
      {tenancies === null ? <Loader2 className="spin" size={18} /> : pick ? (
        <>
          <strong className="overview-figure small">{pick.next.label}</strong>
          <span className="small-copy">{pick.property}{actionable ? '' : ' · nothing for you to do right now'}</span>
        </>
      ) : (
        <>
          <strong className="overview-figure small">{role === 'landlord' ? 'List a home' : role === 'arbitrator' ? 'No open cases' : 'Find a home'}</strong>
          <span className="small-copy">{role === 'tenant' ? 'Apply for a listed home; the deposit then earns for you.' : ''}</span>
        </>
      )}
      <span className="text-button">Open Home →</span>
    </section>
  );
}

function Progress({ stage, finished }: { stage: JourneyStage; finished: boolean }) {
  const current = STAGES.findIndex((s) => s.id === stage) + (finished ? 1 : 0);
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

function TenancyCard({ journey, request, reload, openConnections, helper, helperBusy }: {
  journey: TenancyJourney; request: Request; reload: () => Promise<void>; openConnections: () => void;
  helper: Helper | null; helperBusy: boolean;
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
  /** A signed step is valid for about a minute on Solana; if it lapses, prepare a fresh one once. */
  async function operation(action: Record<string, unknown>, description: string, evidence?: string) {
    try {
      await attempt(action, description, evidence);
    } catch (e) {
      if (!(e && typeof e === 'object' && 'code' in e && e.code === 'operation_expired')) throw e;
      setMessage('That approval expired on the network. Please approve once more.');
      await attempt(action, description);
    }
  }
  async function attempt(action: Record<string, unknown>, description: string, evidence?: string) {
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
        // The sponsor first creates both parties' own payout accounts (no approval needed).
        await request('/api/journey', { action: 'advance', agreementId });
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
      <Progress stage={journey.stage} finished={next.kind === 'done'} />
      <div className={`next-step-card ${AUTO[next.kind] || next.kind === 'done' ? 'passive' : ''}`}>
        <span className="eyebrow">{next.kind === 'wait' ? 'NOTHING TO DO RIGHT NOW' : next.kind === 'done' ? 'FINISHED' : 'YOUR NEXT STEP'}</span>
        <h3>{AUTO[next.kind] && next.kind !== 'wait' && <Loader2 className="spin" size={18} />} {next.label}</h3>
        <p>{next.detail}</p>
        {oneButton && (
          <button className="button primary large" disabled={busy} onClick={() => run(primary)}>
            {busy ? <Loader2 className="spin" size={18} /> : null}
            {BUTTON_LABEL[next.kind] ?? next.label}
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
        {helper && next.kind === 'invite_arbitrator' && (
          <button className="button test-helper" disabled={helperBusy} onClick={() => helper({ action: 'act', agreementId })}>
            Use the test arbitrator instead
          </button>
        )}
        {helper && next.kind === 'wait' && (
          <button className="button test-helper" disabled={helperBusy} onClick={() => helper({ action: 'act', agreementId })}>
            Let the test party do their step
          </button>
        )}
      </div>
      {chain && chain.phase === 'active' && journey.role === 'tenant' && (
        <div className="earnings-panel">
          <div>
            <span className="eyebrow">YOUR DEPOSIT EARNINGS</span>
            <strong>{money(chain.claimableAtomic)} ready to claim</strong>
            <span className="small-copy">Already claimed: {money(chain.releasedAtomic)}. The deposit itself stays locked; only what it earns is yours now. On devnet, earnings are simulated interest in test tokens.</span>
          </div>
          <div className="button-row">
            <button className="button primary" disabled={busy || BigInt(chain.claimableAtomic) === 0n}
              onClick={() => run(() => operation({ kind: 'release_earnings', amountAtomic: chain.claimableAtomic }, 'Claim deposit earnings to your wallet'))}>
              Claim to my wallet <ArrowRight size={16} />
            </button>
            {helper && (
              <button className="button test-helper" disabled={helperBusy} onClick={() => helper({ action: 'interest', agreementId })}>
                Simulate a month of interest
              </button>
            )}
          </div>
        </div>
      )}
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

const PRESETS = [
  'photo-1502672260266-1c1ef2d93688',
  'photo-1522708323590-d24dbb6b0267',
  'photo-1560448204-e02f11c3d0e2',
  'photo-1493809842364-78817add7ffb',
  'photo-1484154218962-a197022b5858',
  'photo-1505691938895-1758d7feb511',
].map((id) => `https://images.unsplash.com/${id}?w=1200&q=70&auto=format&fit=crop`);
const thumb = (url: string) => (url.startsWith('https://') ? url.replace('w=1200', 'w=360') : url);

/** Downscale an uploaded photo in the browser so it stays small enough to store with the listing. */
async function compressPhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.8, 0.65, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= 700_000) return url;
  }
  throw new Error('This photo is too large even after compression.');
}

function ListingCard({ listing, children }: { listing: PublicListing; children?: React.ReactNode }) {
  const d = listing.details;
  const facts = [d.city, d.rooms ? `${d.rooms} room${d.rooms > 1 ? 's' : ''}` : '', d.sizeSqm ? `${d.sizeSqm} m²` : '',
    d.availableFrom ? `from ${new Date(d.availableFrom).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''].filter(Boolean);
  return (
    <article className="listing-card">
      <div className="listing-photo">
        {/* eslint-disable-next-line @next/next/no-img-element -- uploaded photos are data URLs */}
        {d.photos[0] ? <img src={d.photos[0]} alt={listing.title} loading="lazy" /> : <HomeIcon size={42} />}
        {d.photos.length > 1 && <span className="photo-count">+{d.photos.length - 1}</span>}
      </div>
      <div className="listing-body">
        <header><strong>{listing.title}</strong><span className="listing-rent">{money(listing.rentMonthly)}<small>/month</small></span></header>
        {facts.length > 0 && <p className="listing-facts">{facts.join(' · ')}</p>}
        {listing.description && <p className="listing-description">{listing.description}</p>}
        <p className="small-copy">Deposit {money(listing.requiredSecurity)}{listing.releaseAllowed ? ' · deposit earnings go to the tenant' : ''}</p>
        {children}
      </div>
    </article>
  );
}

function Homes({ role, listings, request, reload, helper, helperBusy }: {
  role: ChosenRole; listings: PublicListing[]; request: Request; reload: () => Promise<void>; helper: Helper | null; helperBusy: boolean;
}) {
  const [posting, setPosting] = useState(role === 'landlord' && !listings.some((l) => l.relation === 'landlord'));
  const [form, setForm] = useState({ title: '', city: '', rooms: '2', sizeSqm: '55', availableFrom: '', description: '', rent: '900', deposit: '1', releaseAllowed: true });
  const [photos, setPhotos] = useState<string[]>([PRESETS[0]]);
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
  const togglePhoto = (url: string) =>
    setPhotos((current) => (current.includes(url) ? current.filter((p) => p !== url) : current.length >= 4 ? current : [...current, url]));
  const field = (key: keyof typeof form) => ({ value: String(form[key]), onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value }) });
  const mine = listings.filter((l) => l.relation === 'landlord');
  const others = listings.filter((l) => l.relation !== 'landlord');
  return (
    <section className="card homes">
      <div className="section-heading">
        <h2>{role === 'landlord' ? 'Your listings' : 'Homes you can apply for'}</h2>
        <div className="button-row">
          {helper && role === 'tenant' && <button className="button test-helper" disabled={helperBusy} onClick={() => helper({ action: 'post_home' })}>Add sample homes</button>}
          {role === 'landlord' && <button className="button secondary" onClick={() => setPosting(!posting)}><Plus size={15} /> Post a home</button>}
        </div>
      </div>
      {message && <p className="note" role="alert">{message}</p>}
      {posting && (
        <form className="listing-form" onSubmit={(e) => { e.preventDefault(); void act(async () => {
          await request('/api/listings', {
            title: form.title, city: form.city, rooms: Number(form.rooms), sizeSqm: Number(form.sizeSqm), availableFrom: form.availableFrom,
            description: form.description, photos, rentMonthly: parseAmount(form.rent), requiredSecurity: parseAmount(form.deposit), releaseAllowed: form.releaseAllowed,
          });
          setPosting(false);
        }); }}>
          <label className="wide">Title<input required placeholder="Bright 2-room flat near the park" {...field('title')} /></label>
          <label>City / district<input placeholder="Berlin-Friedrichshain" {...field('city')} /></label>
          <label>Rooms<input type="number" min={1} max={20} {...field('rooms')} /></label>
          <label>Size (m²)<input type="number" min={10} max={1000} {...field('sizeSqm')} /></label>
          <label>Available from<input type="date" {...field('availableFrom')} /></label>
          <label>Monthly rent (USDC)<input inputMode="decimal" {...field('rent')} /></label>
          <label>Deposit (test USDC)<input inputMode="decimal" {...field('deposit')} /></label>
          <label className="wide">Description<textarea rows={3} placeholder="Balcony, fitted kitchen, 5 minutes to the U-Bahn…" {...field('description')} /></label>
          <div className="wide">
            <span className="field-label">Photos (up to 4): pick samples or upload your own</span>
            <div className="photo-picker">
              {[...PRESETS, ...photos.filter((p) => !PRESETS.includes(p))].map((url) => (
                <button type="button" key={url.slice(-40)} className={photos.includes(url) ? 'selected' : ''} onClick={() => togglePhoto(url)}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- uploaded photos are data URLs */}
                  <img src={thumb(url)} alt="" />
                  {photos.includes(url) && <span><Check size={14} /></span>}
                </button>
              ))}
              <label className="photo-upload">
                <Plus size={18} /> Upload
                <input type="file" accept="image/*" hidden onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void compressPhoto(file).then((url) => setPhotos((c) => (c.length >= 4 ? c : [...c, url]))).catch((err) => setMessage(err.message));
                }} />
              </label>
            </div>
          </div>
          <label className="policy-check wide"><input type="checkbox" checked={form.releaseAllowed} onChange={(e) => setForm({ ...form, releaseAllowed: e.target.checked })} /> Earnings on the deposit belong to the tenant</label>
          <button className="button primary large">Publish home</button>
        </form>
      )}
      <div className="listing-grid">
        {mine.map((l) => (
          <ListingCard listing={l} key={l.id}>
            <Badge tone={l.status === 'open' ? 'green' : 'neutral'}>{l.status === 'open' ? `${l.applicants} applicant(s)` : 'Tenant chosen'}</Badge>
            {helper && l.status === 'open' && (
              <button className="button test-helper" disabled={helperBusy} onClick={() => helper({ action: 'apply', listingId: l.id })}>Add a test applicant</button>
            )}
            {l.status === 'open' && l.applications?.map((a) => (
              <div className="applicant" key={a.id}>
                <div><strong>{a.name}</strong><p>{a.message}</p></div>
                <button className="button primary" onClick={() => act(() => request(`/api/listings/${l.id}`, { action: 'choose', applicationId: a.id }))}>Choose</button>
              </div>
            ))}
          </ListingCard>
        ))}
        {role === 'tenant' && others.map((l) => (
          <ListingCard listing={l} key={l.id}>
            {l.relation !== null && (
              <Badge tone={l.relation === 'chosen' ? 'green' : 'neutral'}>
                {l.relation === 'chosen' ? 'You got it, see above' : l.status === 'let' ? 'Not chosen' : 'Applied'}
              </Badge>
            )}
            {helper && l.relation === 'applicant' && l.status === 'open' && (
              <button className="button test-helper" disabled={helperBusy} onClick={() => helper({ action: 'act', listingId: l.id })}>Let the test landlord choose</button>
            )}
            {l.relation === null && (applyTo === l.id ? (
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act(async () => {
                await request(`/api/listings/${l.id}`, { action: 'apply', ...application });
                setApplyTo(null);
              }); }}>
                <label>Your name<input required value={application.name} onChange={(e) => setApplication({ ...application, name: e.target.value })} /></label>
                <label>A few words about you<input required value={application.message} onChange={(e) => setApplication({ ...application, message: e.target.value })} /></label>
                <button className="button primary">Send application</button>
              </form>
            ) : (
              <button className="button primary" onClick={() => setApplyTo(l.id)}>Apply</button>
            ))}
          </ListingCard>
        ))}
      </div>
      {others.length === 0 && mine.length === 0 && !posting && (
        <p className="small-copy">{role === 'landlord' ? 'Post your first home.' : 'No homes are listed yet.'}{helper && role === 'tenant' ? ' For a test run, add sample homes.' : ''}</p>
      )}
    </section>
  );
}

function Portfolio({ request, onBalance }: { request: Request; onBalance: (atomic: string) => void }) {
  const wallet = useRentalWallet();
  const [view, setView] = useState<PortfolioView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [purchase, setPurchase] = useState<'none' | 'pending'>('none');
  const [signedAttempt, setSignedAttempt] = useState<{ id: string; signedTxBase64: string } | null>(null);
  const refresh = useCallback(async () => {
    const { portfolio } = await request<{ portfolio: PortfolioView | { available: false } }>('/api/portfolio');
    setView(portfolio.available ? portfolio : null);
    if (portfolio.available) onBalance(portfolio.testUsdcAtomic);
  }, [request, onBalance]);
  useEffect(() => {
    let active = true;
    request<{ result: { state: string } }>('/api/portfolio', { action: 'purchase_status' })
      .then(({ result }) => { if (active && result.state === 'pending') setPurchase('pending'); })
      .catch(() => {});
    let retry: ReturnType<typeof setTimeout> | undefined;
    request<{ portfolio: PortfolioView | { available: false } }>('/api/portfolio')
      .then(({ portfolio }) => {
        if (!active) return;
        setView(portfolio.available ? portfolio : null);
        if (portfolio.available) onBalance(portfolio.testUsdcAtomic);
      })
      .catch(() => {
        // Busy public RPC: try again shortly instead of hiding the portfolio.
        if (active) retry = setTimeout(() => active && refresh().catch(() => {}), 8000);
      });
    return () => { active = false; clearTimeout(retry); };
  }, [request, onBalance, refresh]);
  useEffect(() => {
    if (purchase !== 'pending') return;
    let active = true;
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      request<{ result: { state: 'none' | 'pending' | 'finalized' | 'failed' } }>('/api/portfolio', { action: 'purchase_status' })
        .then(async ({ result }) => {
          if (!active) return;
          let state = result.state;
          if (state === 'pending') return;
          if (state === 'none' && signedAttempt) {
            try {
              const response = await request<{ result: { state: 'none' | 'pending' | 'finalized' | 'failed' } }>('/api/portfolio', {
                action: 'submit_buy', ...signedAttempt,
              });
              if (!active) return;
              state = response.result.state;
              if (state === 'pending') return;
            } catch (error) {
              if (!active) return;
              if (!(error && typeof error === 'object' && 'code' in error && error.code === 'operation_expired')) return;
              setMessage('The signed test purchase expired without broadcast. You can try again.');
            }
          }
          if (state === 'finalized') {
            setMessage('Bought. Your test holding is updated.');
            void refresh().catch(() => {});
          } else if (state === 'failed') {
            setMessage('The test purchase failed on the network. You can try again.');
          } else if (state === 'none') {
            setMessage('The purchase was not broadcast. You can try again.');
          }
          setSignedAttempt(null);
          setPurchase('none');
        })
        .catch(() => { /* A status timeout is not evidence that the purchase failed. */ })
        .finally(() => { checking = false; });
    }, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [purchase, request, refresh, signedAttempt]);
  if (!view) return null;
  async function invest() {
    if (busy || purchase === 'pending') return;
    setBusy(true);
    setMessage('');
    let submitted = false;
    try {
      const { buy } = await request<{ buy: { id: string; walletId: string; feePayer: string; expiresAt: string; transactionBase64: string } }>(
        '/api/portfolio', { action: 'prepare_buy', usdcInAtomic: '5000000' });
      const signed = await wallet.signSolanaTransaction({
        operationId: buy.id, walletId: buy.walletId, chain: 'solana:devnet', feePayer: buy.feePayer,
        expiresAt: buy.expiresAt, transaction: b64(buy.transactionBase64), description: 'Invest 5 test USDC in tSPYx',
      });
      const attempt = { id: buy.id, signedTxBase64: toB64(signed) };
      setSignedAttempt(attempt);
      submitted = true;
      const { result } = await request<{ result: { state: 'pending' | 'finalized' | 'failed' } }>(
        '/api/portfolio', { action: 'submit_buy', ...attempt });
      if (result.state === 'pending') {
        setPurchase('pending');
        setMessage('Test purchase pending, checking the network.');
      } else {
        setSignedAttempt(null);
        setMessage(result.state === 'finalized' ? 'Bought. Your test holding is updated.' : 'The test purchase failed on the network.');
        await refresh();
      }
    } catch (e) {
      if (submitted && !(e && typeof e === 'object' && 'code' in e && e.code === 'operation_expired')) {
        setPurchase('pending');
        setMessage('Test purchase pending, checking the network. Please do not start another.');
      } else {
        setSignedAttempt(null);
        const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined;
        if (code === 'buy_pending') {
          setPurchase('pending');
          setMessage('Test purchase pending, checking the network.');
        } else {
          setMessage(code === 'operation_expired' ? 'The price quote expired. Please approve again.' : e instanceof Error ? e.message : 'The test purchase failed.');
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card portfolio-card">
      <div className="section-heading">
        <h2>Invest · stocks on Solana</h2>
        <Badge tone="neutral">Devnet test market · no value</Badge>
      </div>
      <dl className="journey-facts">
        <div><dt>tSPYx (S&amp;P 500 copy)</dt><dd>{view.shares.toFixed(6)} shares</dd></div>
        <div><dt>Value at live SPYx price</dt><dd>${view.valueUsd.toFixed(2)}</dd></div>
        <div><dt>Simulated distributions so far</dt><dd>{((view.multiplier - 1) * 100).toFixed(2)} %</dd></div>
        <div><dt>Test USDC available</dt><dd>{money(view.testUsdcAtomic)}</dd></div>
      </dl>
      <p className="small-copy">
        Deposit earnings above the required deposit are yours to invest. Devnet lending pays no interest, so you can
        invest your own test USDC here. Distributions raise your displayed shares, as they do for xStocks.
      </p>
      <button className="button primary" disabled={busy || purchase === 'pending' || BigInt(view.testUsdcAtomic) < 5_000_000n} onClick={invest}>
        {busy ? <Loader2 className="spin" size={16} /> : null} {purchase === 'pending' ? 'Purchase pending, checking' : 'Invest 5 test USDC'} <ArrowRight size={16} />
      </button>
      {message && <p className="note" role="status">{message}</p>}
    </section>
  );
}
