'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Home as HomeIcon, Loader2, Plus } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { RentalWalletAccess } from '@/wallets/types';
import { authorizedRequest } from './authorized-request';
import { AREAS, goToSection, PUBLISH_HOME_NAVIGATION_INTENT, type Area } from './areas';
import { IdeasArea } from './ideas';
import { MeArea } from './me';
import { MoneyArea, TestUsdc } from './money-area';
import { SOLANA_TEST_USDC_MINT } from '@/finance/solana/manifest';
import { accountSetupStep } from './account-setup-state';
import { AccountSetup, SigningIn } from './onboarding';
import { AreaSkeleton } from './area-skeleton';
import { CITY_CHANGED_EVENT } from './use-city-signals';
import { PlacesArea } from './places';
import { ServiceCharges } from './service-charges';
import { DepositIdeas } from './tenancy-walkthrough';
import { parseAmount } from '@/domain/assets';
import type { TenancyJourney } from '@/server/journey';
import type { PublicListing } from '@/server/listings';
import { money } from './workspace-panels';
import './home-journey.css';
import { applicationStatusLabel, claimAmount, confirmationStalled, currentHomeTenancy, HOME_STAGES, homeSituation, homeStage, invitationKey, invitationPayload, invitationStatus, pollingPaused, recoverExpiredRentReview, settlementSplit, tenancyNeedsPerson } from './home-journey-logic';
import { operationLabels } from './deposit-activity';
import { nextStep } from './next-step';
import { NextStepCard } from './next-step-card';
import { DepositYield } from './deposit-yield';
import { FlatMap } from './flat-map';
import { MoveInHandover } from './move-in-handover';
import { moveInAvailable, type HomeLocation } from '@/domain/home-location';
import { ShareDeposit, ShareDepositRules, depositUsd } from './share-deposit';
import { ShareDepositApplication } from './share-deposit-application';
import shareDepositManifest from '../../contracts/evm/deployments/share-deposit-46630.json';
import { maximumDepositSecurity, validateDepositSecurity, type DepositForm } from '@/domain/deposit-form';
import type { EvmSigningRequest } from '@/wallets/types';
import { paidRentMonth, RENT_BUILDING_ID } from '@/domain/rent';
import { ActionBox, Figure, Figures, Hero, MoreList, MoreRow, ScreenNote, StatusLine } from './blocks';
import { ProjectMap } from './project-map';
import { DEFAULT_PROJECT_SYSTEMS } from './project-map-model';
import { TEST_CITY_INVESTMENTS } from '@/data/local-investments';
import type { ReactNode } from 'react';

const BUTTON_LABEL: Record<string, string> = {
  invite_arbitrator: 'Make invitation link',
  accept_agreement: 'Accept these deposit terms',
  create_space: 'Prepare the empty escrow',
  secure_deposit: 'Secure the test-USDC deposit',
  settle: 'Settle',
};
const AUTO: Record<string, true> = { confirming: true, paying_out: true, wait: true };
type Unavailable = { agreementId: string; property: string; unavailable: string };
/** Typed view of our own same-origin API responses. */
type Helper = (body: Record<string, unknown>) => Promise<void>;
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const b64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toB64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

/** Requests follow the linked account, not transient connector readiness. */
function walletRequestIdentity(wallet: RentalWalletAccess): string | null {
  if (!wallet.authenticated || !wallet.subject) return null;
  return JSON.stringify([wallet.subject, wallet.wallets.map(({ chainType, id, address }) =>
    [chainType, id, address]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
}

/** Authenticated same-origin JSON requests bound to the account that started them. */
function useAuthorizedRequest(): Request {
  const wallet = useRentalWallet();
  const identity = walletRequestIdentity(wallet);
  const generation = useRef(0);
  const previousIdentity = useRef(identity);
  const latest = useRef<{ identity: string | null; getAccessToken: typeof wallet.getAccessToken; generation: number } | null>(null);
  useLayoutEffect(() => {
    if (previousIdentity.current !== identity) {
      previousIdentity.current = identity;
      ++generation.current;
    }
    latest.current = { identity, getAccessToken: wallet.getAccessToken, generation: generation.current };
    return () => { latest.current = null; };
  }, [identity, wallet.getAccessToken]);
  return useCallback(<T,>(path: string, body?: unknown): Promise<T> =>
    authorizedRequest<T>(path, body, identity, () => latest.current), [identity]);
}

export function MyHome({ area, go, sessionHint = false }: { area: Area; go: (area: Area) => void; sessionHint?: boolean }) {
  const wallet = useRentalWallet();
  const step = accountSetupStep({
    ready: wallet.ready, authenticated: wallet.authenticated, subject: wallet.subject, passkeyCount: wallet.passkeyCount,
    wallets: wallet.wallets,
  });
  return <div className={area === 'home' ? 'home housing-page' : 'home'}>
    {step === 'loading' ? <>{!wallet.ready && !sessionHint
      ? <div className="area-skeleton" aria-busy="true"><div className="skeleton-block skeleton-card" /><span className="sr-only" role="status">Loading your workspace…</span></div>
      : <AreaSkeleton area={area} />}<SigningIn /></>
      : step !== 'done' ? <AccountSetup key={wallet.subject ?? 'signed-out'} step={step} />
      : <SignedInHome key={walletRequestIdentity(wallet)} area={area} go={go} />}
  </div>;
}

function SignedInHome({ area, go }: { area: Area; go: (area: Area) => void }) {
  const wallet = useRentalWallet();
  const [tenancies, setTenancies] = useState<(TenancyJourney | Unavailable)[] | null>(null);
  const [listings, setListings] = useState<PublicListing[]>([]);
  const [listingsLoaded, setListingsLoaded] = useState(false);
  const [journeyError, setJourneyError] = useState('');
  const [listingsError, setListingsError] = useState('');
  const [failureCount, setFailureCount] = useState(0);
  const paused = pollingPaused(failureCount);
  const error = [journeyError && `Homes: ${journeyError}`, listingsError && `Listings: ${listingsError}`].filter(Boolean).join(' · ');
  const [helpers, setHelpers] = useState<boolean | null>(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const [helperLog, setHelperLog] = useState('');
  const [automationMessages, setAutomationMessages] = useState<Record<string, string>>({});
  const reportAutomation = useCallback((agreementId: string, message: string) => {
    setAutomationMessages(current => current[agreementId] === message ? current : { ...current, [agreementId]: message });
  }, []);
  useEffect(() => {
    if (area !== 'home' || helpers !== null) return;
    const controller = new AbortController();
    fetch('/api/test-helpers', { signal: controller.signal }).then((r) => r.json()).then((d) => setHelpers(Boolean(d.enabled))).catch(() => { if (!controller.signal.aborted) setHelpers(false); });
    return () => controller.abort();
  }, [area, helpers]);
  const request = useAuthorizedRequest();
  const cityInputs = useRef<{ journey?: string; listings?: string }>({});
  useEffect(() => {
    // Only home-selection inputs invalidate city reads, not unchanged polls or balance updates.
    const signatures = {
      journey: tenancies === null ? undefined : JSON.stringify(tenancies
        .filter((item) => 'unavailable' in item || (item.next.kind !== 'done' && item.next.kind !== 'cancelled'))
        .map((item) => 'unavailable' in item ? [item.agreementId, 'unavailable']
          : [item.agreementId, item.role, item.stage, item.property, item.home?.city, item.home?.location?.lat, item.home?.location?.lon])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      listings: !listingsLoaded ? undefined : JSON.stringify(listings
        .filter((item) => item.relation !== null && item.status !== 'closed')
        .map((item) => [item.id, item.relation, item.status, item.agreementId, item.title, item.details.city, item.location?.lat, item.location?.lon])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
    };
    const changed = (['journey', 'listings'] as const).some((source) =>
      cityInputs.current[source] !== undefined && signatures[source] !== undefined && cityInputs.current[source] !== signatures[source]);
    cityInputs.current = signatures;
    if (changed) window.dispatchEvent(new Event(CITY_CHANGED_EVENT));
  }, [tenancies, listings, listingsLoaded]);
  const load = useCallback(async (background = false) => {
    const results = await Promise.all([
      request<{ tenancies: (TenancyJourney | Unavailable)[] }>('/api/journey').then((journey) => {
        setTenancies(journey.tenancies); setJourneyError('');
        return true;
      }, (reason: unknown) => {
        setJourneyError(reason instanceof Error ? reason.message : 'Could not read your homes.'); return false;
      }),
      request<{ listings: PublicListing[] }>('/api/listings').then((homes) => {
        setListings(homes.listings); setListingsLoaded(true); setListingsError('');
        return true;
      }, (reason: unknown) => {
        setListingsError(reason instanceof Error ? reason.message : 'Could not read listings.'); return false;
      }),
    ]);
    if (results.every(Boolean)) setFailureCount(0);
    else if (background) setFailureCount((count) => count + 1);
  }, [request]);
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(first);
  }, [load]);
  const retryHome = useCallback(async () => { setFailureCount(0); await load(); }, [load]);
  const waiting = tenancies?.some((t) => 'unavailable' in t || AUTO[t.next.kind] || t.next.kind === 'invite_arbitrator');
  const pollingListings = listings.some((l) => l.status === 'open' && (l.relation === 'landlord' || l.relation === 'applicant'));
  useEffect(() => {
    if (paused || (!waiting && !pollingListings)) return;
    const fast = tenancies?.some((t) => 'next' in t && (t.next.kind === 'confirming' || t.next.kind === 'paying_out'));
    const timer = setInterval(() => { void load(true); }, fast ? 5000 : waiting ? 15000 : 30000);
    return () => clearInterval(timer);
  }, [waiting, pollingListings, paused, load, tenancies]);

  const helper: Helper | null = helpers
    ? async (body) => {
        setHelperBusy(true);
        setHelperLog('The test person is doing their step… (up to a minute on devnet)');
        try {
          const result = await request<{ done?: string[] }>('/api/test-helpers', body);
          setHelperLog(result.done?.length ? result.done.join(' · ') : 'No test party can act here; your real counterparty may need to do this step.');
          await load();
        } catch (e) {
          setHelperLog(e instanceof Error ? e.message : 'The helper failed.');
        } finally {
          setHelperBusy(false);
        }
      }
    : null;
  const [invitation, setInvitation] = useState<string | null>(() => typeof window !== 'undefined' ? new URLSearchParams(window.location.hash.slice(1)).get('invitation') : null);
  useEffect(() => {
    const update = () => setInvitation(new URLSearchParams(window.location.hash.slice(1)).get('invitation'));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const ready = (tenancies ?? []).filter((t): t is TenancyJourney => !('unavailable' in t));
  const current = currentHomeTenancy(ready);
  const otherTenancies = ready.filter((t) => t !== current && t.next.kind !== 'done' && t.next.kind !== 'cancelled');
  const unavailable = (tenancies ?? []).filter((t): t is Unavailable => 'unavailable' in t);
  const openListingCount = listings.filter(listing => listing.relation === 'landlord' && listing.status === 'open').length;
  const { reviewListings, applicationListings, showBrowser } = homeSituation({
    listings, tenancyIds: (tenancies ?? []).map(t => t.agreementId), hasCurrent: Boolean(current),
    homeKnown: tenancies !== null && !journeyError && unavailable.length === 0,
  });
  const step = nextStep({
    loading: (tenancies === null && !journeyError) || (!listingsLoaded && !listingsError),
    invitation: Boolean(invitation), homeError: error, tenancies: ready, unavailable: unavailable.length, listings,
    unavailableAgreementIds: unavailable.map((item) => item.agreementId),
  });
  const meta = AREAS.find((a) => a.id === area)!;
  const firstReadsPending = (tenancies === null && !journeyError) || (!listingsLoaded && !listingsError);
  const showSkeleton = firstReadsPending && area === 'home';
  return (
    <>
      <div className="page-heading"><h1 tabIndex={-1}>{meta.label}</h1></div>
      {showSkeleton && <AreaSkeleton area={area} bodyOnly />}
      <div className="area-content" hidden={showSkeleton}>
      {step.urgent && area !== 'home' && <NextStepCard step={step} go={go} />}
      {(error || paused) && <p className="note" role="alert">{paused ? 'Updates are paused. Retry. ' : ''}{error} <button className="button secondary" onClick={() => void retryHome()}>Retry</button></p>}

      {area === 'me' && <MeArea request={request} tenancies={ready} listings={listings} go={go}
        homeState={{ homeLoading: tenancies === null && !journeyError, homeError: journeyError || (tenancies?.some((item) => 'unavailable' in item) ? 'Some tenancy readings are unavailable.' : ''), tenancyCount: tenancies?.length ?? 0, listingCount: listings.filter((l) => l.relation === 'landlord' || (l.relation === 'applicant' && l.status === 'open')).length }} />}

      {area === 'home' && (
        <div className="housing-journey">
          {ready.filter(t => t.next.kind !== 'done' && t.next.kind !== 'cancelled').map(t => <TenancyAutomation key={t.agreementId} journey={t} request={request} reload={load} report={reportAutomation} />)}
          {invitation && <JoinInvitation key={invitation} request={request} encoded={invitation} onDone={load} />}
          {(!invitation || current) && <>
            {reviewListings.map(listing => <ApplicantsReview key={listing.id} listing={listing} request={request} reload={load} />)}
            {applicationListings.map(listing => <ApplicationStatus key={listing.id} listing={listing} request={request} reload={load} />)}
            <div id="home-tenancies" tabIndex={-1} className="home-tenancy-anchor" aria-label="Your tenancies">
              {current && <TenancyCard key={current.agreementId} journey={current} request={request} reload={load} accountId={wallet.subject ?? ''} automationMessage={automationMessages[current.agreementId]} />}
            </div>
            {otherTenancies.map((t) => <MoreRow key={t.agreementId} id={`tenancy-${t.agreementId}`} title={t.property} meta={tenancyNeedsPerson(t) ? 'Needs you' : t.next.label} defaultOpen={tenancyNeedsPerson(t)}><TenancyCard journey={t} request={request} reload={load} accountId={wallet.subject ?? ''} anchored={false} automationMessage={automationMessages[t.agreementId]} /></MoreRow>)}
            {unavailable.map((t) => <p className="housing-unavailable" key={t.agreementId} id={`tenancy-${t.agreementId}`} tabIndex={-1}><strong>{t.property}</strong> · {t.unavailable}</p>)}
            {!current && showBrowser && <div id="home-options" tabIndex={-1}><ListingBrowser listings={listings} request={request} reload={load} loaded={listingsLoaded} loadError={listingsError} testTools={helpers === true} /></div>}
            <MoreList>
            {!current && showBrowser && <MoreRow id="deposit-options" title="How the deposit works"><DepositIdeas go={go} /></MoreRow>}
            {(current || !showBrowser) && <><MoreRow id="home-options" title="Browse other homes"><ListingBrowser listings={listings} request={request} reload={load} loaded={listingsLoaded} loadError={listingsError} testTools={helpers === true} /></MoreRow><MoreRow id="deposit-options" title="How the deposit works"><DepositIdeas go={go} /></MoreRow></>}
            <MoreRow id="publish-home" title="Rent out a home" meta={listings.some(l => l.relation === 'landlord') ? `${openListingCount} open listing${openListingCount === 1 ? '' : 's'}` : undefined}><PublishHome listings={listings} request={request} reload={load} go={go} tenancyIds={new Set((tenancies ?? []).map((t) => t.agreementId))} /></MoreRow>
            {ready.some((t) => t.next.kind === 'done' || t.next.kind === 'cancelled') && <MoreRow id="past-tenancies" title="Past homes">
              {ready.filter((t) => t.next.kind === 'done' || t.next.kind === 'cancelled').map((t) => <div key={t.agreementId} id={`tenancy-${t.agreementId}`} tabIndex={-1}>
                <strong>{t.property}</strong><p>{t.next.kind === 'done' ? 'Paid out' : 'Cancelled'} · {t.role}{t.cancelled && <> · by {t.cancelled.by} · {new Date(t.cancelled.at).toLocaleString('en-GB')}</>}</p>
                {t.depositForm?.kind === 'shares' ? <>{t.next.kind === 'done' && <p>Paid out in test TSLA.</p>}{t.shareDeposit?.receipts.filter(receipt => receipt.action === 'payout' && receipt.status === 'confirmed').map(receipt => <p key={receipt.planId}><a href={`https://explorer.testnet.chain.robinhood.com/tx/${receipt.transactionHash}`} target="_blank" rel="noopener noreferrer">Confirmed TSLA payout receipt</a></p>)}{t.shareDeposit?.explorerUrl && <a href={t.shareDeposit.explorerUrl} target="_blank" rel="noopener noreferrer">Read share escrow on explorer</a>}</> : <>
                  {t.next.kind === 'done' && <p>Tenant received {money(t.chain?.tenantPaidAtomic ?? '0')} test USDC · landlord received {money(t.chain?.landlordPaidAtomic ?? '0')} test USDC.</p>}
                  {t.role !== 'arbitrator' && t.chain?.depositMint === SOLANA_TEST_USDC_MINT && t.chain.simulatedYield?.since && <DepositYield view={t.chain.simulatedYield} requiredAtomic={t.requiredSecurity} tenant={t.role === 'tenant'} request={request} agreementId={t.agreementId} reload={load} />}
                  <TenancyDetails journey={t} request={request} />
                </>}
              </div>)}
            </MoreRow>}
            {helpers && helper && <MoreRow title="Local rehearsal tools"><TestTools tenancies={ready} listings={listings} request={request} helper={helper} busy={helperBusy} log={helperLog} /></MoreRow>}
            </MoreList>
          </>}
          <ScreenNote>Test networks only · deposit earnings belong to the tenant · not legal advice.</ScreenNote>
        </div>
      )}

      {area === 'money' && <MoneyArea request={request} tenancies={ready} loaded={tenancies !== null} homeError={journeyError} retryHome={retryHome} go={go} />}

      {area === 'places' && <PlacesArea request={request} accountId={wallet.subject ?? ''} go={go} />}

      {area === 'ideas' && <IdeasArea go={go} showDepositOptions={!invitation || Boolean(current)} />}
      </div>
    </>
  );
}



/** The saved invitation link for one tenancy on this device; missing, malformed or blocked storage means none. */
function readStoredInvite(key: string): { url: string; createdAt: number } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    return saved && typeof saved.url === 'string' && typeof saved.createdAt === 'number' ? saved : null;
  } catch { return null; }
}


/** Exactly one always-mounted owner per active tenancy, independent of lazy details rows. */
function TenancyAutomation({ journey, request, reload, report }: {
  journey: TenancyJourney; request: Request; reload: () => Promise<void>; report: (agreementId: string, message: string) => void;
}) {
  const advancing = useRef(false);
  const { agreementId, next } = journey;
  const shares = journey.depositForm?.kind === 'shares';
  useEffect(() => {
    if (shares || next.kind !== 'paying_out') return;
    let active = true;
    const advance = async () => {
      if (advancing.current || !active) return;
      advancing.current = true;
      try { await request('/api/journey', { action: 'advance', agreementId }); if (active) report(agreementId, ''); await reload(); }
      catch { if (active) report(agreementId, 'Payout attempt failed. Retrying while Home is open.'); }
      finally { advancing.current = false; }
    };
    void advance();
    const timer = setInterval(() => void advance(), 15000);
    return () => { active = false; clearInterval(timer); };
  }, [shares, next.kind, agreementId, request, reload, report]);
  useEffect(() => {
    if (shares || next.kind !== 'confirming') return;
    const q = `?agreement=${encodeURIComponent(agreementId)}`;
    const operationId = next.operationId;
    const reconcile = async () => {
      const path = operationId ? `/api/finance/solana/operations/${operationId}/reconcile${q}` : `/api/finance/solana/initialize${q}`;
      await request(path, operationId ? {} : { action: 'reconcile' });
      await reload();
    };
    const timer = setInterval(() => void reconcile().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [shares, next, agreementId, request, reload]);
  return null;
}

function TenancyCard({ journey, request, reload, accountId, anchored = true, automationMessage }: {
  journey: TenancyJourney; request: Request; reload: () => Promise<void>; accountId: string; anchored?: boolean; automationMessage?: string;
}) {
  const wallet = useRentalWallet();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [amount, setAmount] = useState('0');
  const [reason, setReason] = useState('');
  const [link, setLink] = useState<{ url: string; createdAt: number } | null>(() => readStoredInvite(invitationKey(accountId, journey.agreementId)));
  const [showDispute, setShowDispute] = useState(false);
  const [agreement, setAgreement] = useState<TenancyAgreement | null>(null);
  const [agreementError, setAgreementError] = useState(false);
  const [agreementRetry, setAgreementRetry] = useState(0);
  const [confirmation, setConfirmation] = useState<{ id: string; since: number } | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const intent = useRef<{ key: string; requestId: string } | null>(null);
  const recordedOperations = useRef(new Set<string>());
  const { next, chain, agreementId } = journey;
  const shareForm = journey.depositForm?.kind === 'shares' ? journey.depositForm : null;
  const cashOnly = chain?.depositMint === SOLANA_TEST_USDC_MINT;
  const living = journey.stage === 'living' && (Boolean(shareForm) || chain?.phase === 'active');
  const canProposeMoveOut = living && !shareForm && journey.role === 'landlord';
  const q = `?agreement=${encodeURIComponent(agreementId)}`;
  const linkKey = invitationKey(accountId, agreementId);
  useEffect(() => {
    if (next.kind !== 'invite_arbitrator' || !link) return;
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [next.kind, link]);
  useEffect(() => {
    if (!['respond_claim', 'decide_claim', 'accept_agreement'].includes(next.kind)) return;
    let active = true;
    request<{ agreement: TenancyAgreement }>(`/api/agreements/${encodeURIComponent(agreementId)}`)
      .then(({ agreement }) => { if (active) { setAgreement(agreement); setAgreementError(false); } })
      .catch(() => { if (active) { setAgreement(null); setAgreementError(true); } });
    return () => { active = false; };
  }, [agreementId, next.kind, request, chain?.phase, agreementRetry]);

  const reconcile = useCallback(async () => {
    if (shareForm || next.kind !== 'confirming') return;
    const path = next.operationId ? `/api/finance/solana/operations/${next.operationId}/reconcile${q}` : `/api/finance/solana/initialize${q}`;
    await request(path, next.operationId ? {} : { action: 'reconcile' });
    await reload();
  }, [next, q, request, reload, shareForm]);
  const confirmingId = next.kind === 'confirming' ? next.operationId ?? 'escrow-setup' : null;
  const confirmationSince = confirmation?.id === confirmingId ? confirmation.since : null;
  useEffect(() => {
    if (confirmingId === null) return;
    const started = setTimeout(() => setConfirmation((current) => current?.id === confirmingId ? current : { id: confirmingId, since: Date.now() }), 0);
    const ticker = setInterval(() => setClock(Date.now()), 1000);
    return () => { clearTimeout(started); clearInterval(ticker); };
  }, [confirmingId]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
      await reload();
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined;
      setMessage(code === 'operation_expired' ? 'That took a little too long. Press the button again.' : code === 'wallet_cancelled' || (e instanceof Error && /cancel|reject|notallowed/i.test(e.message)) ? 'Request cancelled. You can try again.' : e instanceof Error ? e.message : 'Please try again.');
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
  /** Keep one request id for an intent across retries; never record an unsigned reason. */
  async function operation(action: Record<string, unknown>, description: string, evidence?: string) {
    const key = JSON.stringify([action, evidence ?? '']);
    if (intent.current?.key !== key) intent.current = { key, requestId: crypto.randomUUID() };
    try {
      await attempt(action, description, intent.current.requestId, evidence);
      intent.current = null;
    } catch (e) {
      if (!(e && typeof e === 'object' && 'code' in e && e.code === 'operation_expired')) throw e;
      setMessage('That approval expired on the network. Please approve once more.');
      intent.current = { key, requestId: crypto.randomUUID() }; // Expired operations cannot be replayed with their old id.
      await attempt(action, description, intent.current.requestId, evidence);
      intent.current = null;
    }
  }
  async function attempt(action: Record<string, unknown>, description: string, requestId: string, evidence?: string) {
    if (!chain) throw new Error('The tenancy is not readable yet.');
    const { operation: op } = await request<{ operation: { id: string; walletId: string; expiresAt: string; transactionBase64: string } }>(
      `/api/finance/solana/operations${q}`, { requestId, action });
    const signed = await sign({ ...op, feePayer: chain.feePayer, walletChain: chain.walletChain }, description);
    await request(`/api/finance/solana/operations/${op.id}/authorize${q}`, { signedTxBase64: signed });
    if (evidence && !recordedOperations.current.has(op.id)) {
      await request(`/api/agreements/${agreementId}`, { action: 'record', operationId: op.id, name: description, body: `${evidence}\n\nSigned operation ${op.id}. Only a finalized result changes the tenancy.` });
      recordedOperations.current.add(op.id);
    }
  }
  async function primary() {
    switch (next.kind) {
      case 'invite_arbitrator': {
        const { invitation } = await request<{ invitation: unknown }>(`/api/agreements/${agreementId}`, { action: 'invite', role: 'arbitrator' });
        const saved = { url: `${window.location.origin}/#invitation=${encodeURIComponent(JSON.stringify(invitation))}`, createdAt: Date.now() };
        setLink(saved);
        try { localStorage.setItem(linkKey, JSON.stringify(saved)); }
        catch { setMessage('This browser could not save the link. Copy it before leaving.'); }
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
        const signed = await sign({ ...init, id: `setup-${agreementId}` }, 'Prepare the empty escrow');
        await request(`/api/finance/solana/initialize${q}`, { action: 'sign', signedTxBase64: signed });
        return;
      }
      case 'secure_deposit':
        return operation({ kind: 'fund_and_supply' }, 'Secure the test-USDC deposit');
      case 'settle':
        return operation({ kind: 'redeem_and_settle' }, 'Complete the settlement');
    }
  }
  const needsReason = (value: string) => {
    if (reason.trim().length < 12) throw new Error('Add a short reason (at least 12 characters).');
    return value;
  };
  const oneButton = ['invite_arbitrator', 'accept_agreement', 'create_space', 'secure_deposit', 'settle'].includes(next.kind);
  const recordBlocker = !agreement
    ? agreementError ? 'Agreement records are unavailable. Retry records before signing.' : 'Loading agreement records before you can sign.'
    : '';
  const reasonBlocker = reason.trim().length < 12 ? 'Add a reason of at least 12 characters.' : '';
  let amountBlocker = '';
  if (canProposeMoveOut || next.kind === 'decide_claim') {
    try { claimAmount(amount, next.kind === 'decide_claim' ? next.claimAtomic : journey.requiredSecurity); }
    catch (error) { amountBlocker = error instanceof Error ? error.message : 'Enter a valid deduction.'; }
  }
  const actionButton = (
    <button className="button primary large" disabled={busy || (next.kind === 'accept_agreement' && !agreement)} onClick={() => run(primary)}>
      {busy ? <Loader2 className="spin" size={18} /> : null}
      {next.kind === 'invite_arbitrator' && link ? 'Make a new link (the old one stops working)' : BUTTON_LABEL[next.kind] ?? next.label}
      <ArrowRight size={17} />
    </button>
  );
  const cancelAction = journey.cancellable && (journey.role === 'landlord' || journey.role === 'tenant') ? <button type="button" className="button secondary" disabled={busy} onClick={() => {
    if (window.confirm('No deposit is locked, so nothing moves. The tenancy and its listing close for all three of you. You can list the home again; a new tenancy uses test USDC (tUSDC).')) {
      void run(async () => { await request(`/api/agreements/${encodeURIComponent(agreementId)}`, { action: 'cancel' }); });
    }
  }}>Cancel this tenancy</button> : null;
  const project = TEST_CITY_INVESTMENTS.find(project => project.id === RENT_BUILDING_ID)!;
  const visual = journey.rentTerms?.buildingId === RENT_BUILDING_ID
    ? <ProjectMap project={project} systems={DEFAULT_PROJECT_SYSTEMS} variant="hero" label={`${journey.role === 'tenant' ? 'Your home' : journey.role === 'landlord' ? 'The flat you let' : 'The flat'} · fictional house`} />
    : journey.home?.location ? <FlatMap location={journey.home.location} variant="hero" /> : undefined;
  return <RentPayments agreementId={agreementId} role={journey.role} request={request} enabled={Boolean(journey.rentTerms && journey.stage !== 'agreement')}>
    {({ rent, action, history, due }) => {
      const paid = rent ? paidRentMonth(rent) : null;
      const nextRentDate = rent ? new Date(`${rent.month}-01T12:00:00`) : null;
      if (paid && nextRentDate) nextRentDate.setMonth(nextRentDate.getMonth() + 1);
      return <div className="tenancy-home" id={anchored ? `tenancy-${agreementId}` : undefined} tabIndex={anchored ? -1 : undefined}><Hero visual={visual} className="tenancy-card"
      title={journey.property} subtitle={`${journey.role === 'tenant' ? 'You rent this home' : journey.role === 'landlord' ? 'You let this home' : 'You are the neutral arbitrator'}${journey.sampleParties ? ' · sample parties' : ''}`}
      status={<StatusLine tone={next.kind === 'confirming' || next.kind === 'paying_out' ? 'waiting' : due || tenancyNeedsPerson(journey) ? 'action' : living ? 'ok' : 'waiting'}>{next.kind === 'confirming' || next.kind === 'paying_out' ? 'Waiting for the network…' : due ? `${rent?.month ? new Date(`${rent.month}-01T12:00:00`).toLocaleString('en-GB', { month: 'long' }) : 'This month’s'} rent is due` : living && !shareForm && AUTO[next.kind] ? 'Deposit secured · nothing needs you now' : next.label}</StatusLine>}>
      {AUTO[next.kind] && !living && <p className="small-copy">{next.detail}{next.kind === 'wait' && ' Nothing notifies them: tell them yourself.'}</p>}
      <Figures>
        <Figure label={living ? journey.role === 'tenant' ? cashOnly || shareForm ? 'Deposit' : 'In lending' : 'Deposit held' : 'Required deposit'} value={shareForm ? money(shareForm.securityUsd6) : money(!cashOnly && living && chain ? chain.lendingValueAtomic : journey.requiredSecurity)} note={living ? 'Safe in escrow' : undefined} />
        {journey.role === 'tenant' && cashOnly && living && chain?.simulatedYield?.since && <DepositYield presentation="figure" view={chain.simulatedYield} requiredAtomic={journey.requiredSecurity} tenant request={request} agreementId={agreementId} reload={reload} />}
        {journey.role === 'tenant' && !shareForm && !cashOnly && living && chain && <Figure label="Earned for you" value={money((BigInt(chain.claimableAtomic) + BigInt(chain.releasedAtomic)).toString())} note={`Simulated · yours to keep${BigInt(chain.releasedAtomic) > 0n ? ` · ${money(chain.releasedAtomic)} claimed` : ''}`} action={BigInt(chain.claimableAtomic) > 0n ? <button className="text-button" disabled={busy} onClick={() => run(() => operation({ kind: 'release_earnings', amountAtomic: chain.claimableAtomic }, 'Claim deposit earnings to your wallet'))}>Claim</button> : undefined} />}
        {journey.rentTerms && journey.role !== 'arbitrator' && <Figure label={living ? journey.role === 'landlord' ? 'Rent this month received' : 'Rent this month' : 'Monthly rent'} value={money(journey.role === 'landlord' && living ? paid && rent ? rent.payment!.landlordRaw : '0' : journey.rentTerms.rentMonthly)} note={living ? rent ? paid && nextRentDate ? `${journey.role === 'landlord' ? `Your part · the house got ${money(rent.payment!.buildingRaw)} (20 %)` : 'Paid'} · next from ${nextRentDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} (Berlin)` : journey.role === 'landlord' ? 'Awaiting payment' : 'Due' : 'Reading rent status…' : undefined} />}
        {living && journey.rentTerms && journey.role === 'tenant' && <Figure label="To the house" value={money((BigInt(journey.rentTerms.rentMonthly) * 2000n / 10000n).toString())} note="20 % of this month’s rent" />}
        {journey.role === 'arbitrator' && chain && BigInt(chain.claimAtomic) > 0n && <Figure label="Deduction proposed" value={money(chain.claimAtomic)} />}
      </Figures>
      {!living && <ol className="tenancy-progress" aria-label="Tenancy progress">{HOME_STAGES.slice(0, homeStage(journey.stage) > 4 ? 7 : 5).map((label, index) => <li key={label} className={index < homeStage(journey.stage) ? 'complete' : undefined} aria-current={index === homeStage(journey.stage) ? 'step' : undefined}>{index < homeStage(journey.stage) && <Check size={12} aria-hidden="true" />}{index === homeStage(journey.stage) ? <strong>{label}</strong> : label}</li>)}</ol>}
      {shareForm && journey.stage !== 'agreement' && <MoreRow title="Share deposit" meta={tenancyNeedsPerson(journey) ? 'Needs you' : next.label} defaultOpen={tenancyNeedsPerson(journey) || journey.stage === 'move-out'}>{(living || !AUTO[next.kind]) && <p className="small-copy">{next.detail}</p>}<ShareDeposit rentalId={agreementId} request={request} reload={reload} /></MoreRow>}
      {(!shareForm || journey.stage === 'agreement') && !AUTO[next.kind] && next.kind !== 'done' && next.kind !== 'cancelled' && <ActionBox title={next.label}>
        <p>{next.detail}</p>
        {next.kind === 'accept_agreement' && <><p className="small-copy">Deposit: {shareForm ? `${money(shareForm.securityUsd6)} secured by test shares` : money(journey.requiredSecurity)}.{journey.rentTerms && <> Monthly rent: {money(journey.rentTerms.rentMonthly)}, including a 20 % house share.</>} Deposit earnings belong to the tenant.</p><MoreRow title="Review the agreement terms"><div className="small-copy">
          {shareForm ? <><p>Security: {depositUsd(shareForm.securityUsd6)} USD, backed by test TSLA; factory {shareForm.factory ?? 'not deployed yet'}, oracle {shareForm.oracle}. Response: {shareForm.responseWindow / 86400} days; return: {shareForm.returnWindow / 86400} days; arbitration: {shareForm.arbitrationWindow / 86400} days.</p><ShareDepositRules /></> : <p>These terms cover {journey.property}, the {money(journey.requiredSecurity)} test USDC required deposit, and whether the tenant may claim surplus while the tenancy is active. The tenant keeps deposit assets above an approved deduction at settlement, whatever the release setting. Site-minted tUSDC stays in cash escrow: it is not lent. This site pays labelled simulated yield to the tenant in tUSDC, separate from the escrow. Test tokens have no value.</p>}
          {agreement?.rentTerms ? <RentTerms terms={agreement.rentTerms} /> : <p><strong>These terms cover the deposit and its parties, not monthly rent or tenancy dates.</strong> The landlord chooses the arbitrator before acceptance.</p>}
          {agreement && <p>Tenant: {agreement.parties.tenant?.wallet?.address ? `${agreement.parties.tenant.wallet.address.slice(0, 5)}…${agreement.parties.tenant.wallet.address.slice(-5)}` : 'not available'} · Landlord: {agreement.parties.landlord?.wallet?.address ? `${agreement.parties.landlord.wallet.address.slice(0, 5)}…${agreement.parties.landlord.wallet.address.slice(-5)}` : 'not available'} · Arbitrator: {agreement.parties.arbitrator?.wallet?.address ? `${agreement.parties.arbitrator.wallet.address.slice(0, 5)}…${agreement.parties.arbitrator.wallet.address.slice(-5)}` : 'not available'}</p>}
          {agreement && <p>Tenant acceptance: {agreement.accepted.tenant?.digest === agreement.digest ? 'accepted' : 'waiting'} · Landlord acceptance: {agreement.accepted.landlord?.digest === agreement.digest ? 'accepted' : 'waiting'}.{!shareForm && <> Surplus: {agreement.releaseAllowed ? 'tenant may claim during the tenancy' : 'locked until settlement'}.</>}</p>}
        </div></MoreRow></>}
        {next.kind === 'accept_agreement' && recordBlocker && <p className="action-blocker" role="status">{recordBlocker}</p>}
        {oneButton && actionButton}
        {next.kind === 'secure_deposit' && <div className="small-copy faucet-note">
          {cashOnly ? <TestUsdc request={request} /> : <p>This existing tenancy uses Circle devnet test USDC, not the site&apos;s tUSDC. Use <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer">Circle&apos;s faucet</a> on Solana devnet, sent to your wallet {wallet.wallets.find((w) => w.chainType === 'solana')?.address ?? 'address in Me'}.</p>}
        </div>}
        {next.kind === 'respond_claim' && (
          <div className="inline-form">
            <p>Landlord’s reason: {agreement ? agreement.records.filter((record) => record.name === 'Move-out deduction').at(-1)?.body ?? 'No recorded reason available.' : 'Loading the landlord’s recorded reason…'}</p>
            <p>You get back {money(settlementSplit(journey.requiredSecurity, next.claimAtomic).tenantAtomic)} test USDC · landlord gets {money(next.claimAtomic)} test USDC. Preview, not a confirmed payout; simulated earnings are accounted for at settlement.</p>
            {recordBlocker && <p className="action-blocker" role="status">{recordBlocker}</p>}
            <div className="deduction-choices">
              <button className="button primary" disabled={busy || !agreement} onClick={() => run(() => operation({ kind: 'accept_and_settle' }, 'Agree and settle the deposit'))}>
                Agree and settle
              </button>
              <button className="button secondary" type="button" disabled={busy} aria-expanded={showDispute} onClick={() => setShowDispute(!showDispute)}>
                Dispute deduction
              </button>
            </div>
            {showDispute && <div className="inline-form">
              <label>Dispute reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              {reasonBlocker && <p className="action-blocker">{reasonBlocker}</p>}
              <button className="button secondary" disabled={busy || !agreement || Boolean(reasonBlocker)} onClick={() => run(() => operation({ kind: 'respond_to_claim', accept: false }, 'Dispute the deduction', needsReason(reason)))}>
                Send dispute to arbitrator
              </button>
            </div>}
          </div>
        )}
        {next.kind === 'decide_claim' && (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(() => operation({ kind: 'resolve_and_settle', amountAtomic: claimAmount(amount, next.claimAtomic) }, 'Arbitration decision', needsReason(reason))); }}>
            <p>Landlord’s reason: {agreement ? agreement.records.filter((record) => record.name === 'Move-out deduction').at(-1)?.body ?? 'No recorded reason available.' : 'Loading reasons…'}</p>
            <p>Tenant’s dispute reason: {agreement ? agreement.records.filter((record) => record.name === 'Dispute the deduction').at(-1)?.body ?? 'No recorded reason available.' : 'Loading reasons…'}</p>
            <p>Allowed deduction: 0 to {money(next.claimAtomic)} test USDC. You decide only this disputed claim.</p>
            <label>Landlord receives (test USDC)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            {(() => { try { const split = settlementSplit(journey.requiredSecurity, claimAmount(amount, next.claimAtomic)); return <p>Tenant gets back {money(split.tenantAtomic)} test USDC · landlord gets {money(split.landlordAtomic)} test USDC. Preview, not a confirmed payout.</p>; } catch { return <p>Enter a deduction within the allowed range to preview the split.</p>; } })()}
            <label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            {(recordBlocker || amountBlocker || reasonBlocker) && <p className="action-blocker">{recordBlocker || amountBlocker || reasonBlocker}</p>}
            <button className="button primary large" disabled={busy || !agreement || Boolean(amountBlocker || reasonBlocker)}>Decide deduction and settle <ArrowRight size={17} /></button>
          </form>
        )}
        {next.kind === 'invite_arbitrator' && link && (
          <div className="invite-link">
            <input readOnly value={link.url} onFocus={(e) => e.target.select()} />
            <button className="button secondary" onClick={() => void navigator.clipboard.writeText(link.url).then(() => setMessage('Link copied.')).catch(() => setMessage('Copy failed; select and copy the link above.'))}><Copy size={15} /> Copy</button>
            <p className="small-copy">Saved link {invitationStatus(link.createdAt, clock) === 'valid' ? 'not yet expired on this device' : 'expired'}; its 24-hour window began at {new Date(link.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. The person must open it on the same web address ({window.location.origin}); it works once. A new link replaces this one.</p>
            {invitationStatus(link.createdAt, clock) === 'valid' && <p className="small-copy">Awaiting arbitrator. A link may also stop working if replaced or already used.</p>}
            {invitationStatus(link.createdAt, clock) === 'expired' && <p className="small-copy">This link has expired. Make a new one below.</p>}
          </div>
        )}
        {cancelAction}
      </ActionBox>}
      {next.kind === 'confirming' && <p role="status">{confirmationSince !== null && confirmationStalled(confirmationSince, clock) && 'This is taking longer than usual. '}{!shareForm && <button className="button secondary" onClick={() => void run(reconcile)} disabled={busy}>Check again</button>}</p>}
      {action}
      {canProposeMoveOut && <button type="button" className="text-button" onClick={() => { const row = document.getElementById(`moving-out-${agreementId}`) as HTMLDetailsElement | null; if (row) { row.open = true; row.scrollIntoView({ block: 'start' }); row.focus({ preventScroll: true }); } }}>Tenant moving out?</button>}
      {cancelAction && (AUTO[next.kind] || (shareForm && journey.stage !== 'agreement')) && <ActionBox title="Cancel during setup" tone="neutral">{cancelAction}</ActionBox>}
      {agreementError && <p className="note" role="alert">Agreement records are unavailable. Review the reasons before signing. <button className="button secondary" onClick={() => setAgreementRetry((count) => count + 1)}>Retry records</button></p>}
      {(message || automationMessage) && <p className="note" role="status">{message || automationMessage}</p>}
      </Hero>
      <MoreList title="About this tenancy">
        {journey.rentTerms && journey.role !== 'arbitrator' && <MoreRow title="Rent & receipts" meta={journey.stage === 'agreement' ? 'Terms to review' : paid?.heading ?? (rent ? 'Not paid yet' : 'Reading status')}>{journey.stage !== 'agreement' && history}<RentTerms terms={journey.rentTerms} /></MoreRow>}
        {journey.role !== 'arbitrator' && moveInAvailable(journey.stage, chain?.phase) && <MoreRow title="Move-in handover" meta={!journey.handover ? 'Not recorded yet' : journey.handover.confirmed.tenant && journey.handover.confirmed.landlord ? 'Confirmed by both' : journey.handover.confirmed[journey.role] ? 'Waiting for the other party' : 'Needs your confirmation'}><MoveInHandover agreementId={agreementId} role={journey.role} initial={journey.handover} request={request} /></MoreRow>}
        {journey.role !== 'arbitrator' && living && <MoreRow id={`service-charges-${agreementId}`} title="Service charges · example"><ServiceCharges agreementId={agreementId} request={request} /></MoreRow>}
        {(journey.role === 'tenant' || canProposeMoveOut) && <MoreRow id={`moving-out-${agreementId}`} title="Moving out">
          {journey.role === 'tenant' && <p>The landlord proposes a deduction, including zero. You agree or dispute it; if disputed, the arbitrator decides. Then the deposit is settled and paid out.</p>}
          {canProposeMoveOut && <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(() => operation({ kind: 'propose_claim', amountAtomic: claimAmount(amount, journey.requiredSecurity) }, 'Move-out deduction', needsReason(reason))); }}>
            <p>0 is allowed; the reason is required. The maximum is {money(journey.requiredSecurity)} test USDC. No notification is sent to the tenant; tell them yourself.</p>
            <label>Deduction in test USDC<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. No damage, flat handed over clean" /></label>
            {(amountBlocker || reasonBlocker) && <p className="action-blocker">{amountBlocker || reasonBlocker}</p>}
            <button className="button primary large" disabled={busy || Boolean(amountBlocker || reasonBlocker)}>Propose deduction to tenant <ArrowRight size={17} /></button>
          </form>}
        </MoreRow>}
        <MoreRow title="Agreement & activity"><TenancyDetails journey={journey} request={request} />{journey.role !== 'arbitrator' && cashOnly && chain?.simulatedYield?.since && (!living || journey.role === 'landlord') && <DepositYield view={chain.simulatedYield} requiredAtomic={journey.requiredSecurity} tenant={journey.role === 'tenant'} request={request} agreementId={agreementId} reload={reload} />}</MoreRow>
      </MoreList>
    </div>;}}
  </RentPayments>;
}

type BuildingRentTerms = { buildingId: string; shareBps: number; rentMonthly: string; landlordWallet: string };

function RentTerms({ terms }: { terms: BuildingRentTerms }) {
  const buildingRaw = (BigInt(terms.rentMonthly) * 2000n / 10000n).toString();
  return <div className="small-copy">
    <p><strong>Monthly rent: {money(terms.rentMonthly)} test dollars · Robinhood Chain testnet.</strong> Fixed 20 % building share: {money(buildingRaw)}; landlord receives {money((BigInt(terms.rentMonthly) - BigInt(buildingRaw)).toString())}. Building share rounds down to the token unit; landlord receives the remainder.</p>
    <p>A fixed 20 % of this test rent goes to the fictional building&apos;s tHOME stakers; the rest goes to the landlord. This simulates how a tokenized building could share net rental income; in a real building rent goes to the property owner under the lease. Not legal advice.</p>
    <p>Building: {terms.buildingId}. Landlord recipient: <span style={{ overflowWrap: 'anywhere' }}>{terms.landlordWallet}</span>. These accepted terms bind the rent split as well as the separate deposit terms. Deposit earnings belong to the tenant; fictional units have no value or legal rights.</p>
  </div>;
}

type RentStepView = {
  id: string; kind: 'landlord' | 'building'; recipient: string; amountRaw: string;
  state: 'prepared' | 'signed' | 'submitted' | 'confirmed' | 'stopped';
  request: EvmSigningRequest | null; hash?: `0x${string}`; error: string | null; retryable?: boolean;
};
type RentPaymentView = {
  id: string; month: string; rentMonthly: string; landlordRaw: string; buildingRaw: string;
  state: 'prepared' | 'pending' | 'confirmed' | 'stopped'; steps: RentStepView[]; error: string | null;
};
type RentView = {
  agreementId: string; month: string; rentMonthly: string; landlordRaw: string; buildingRaw: string;
  role: 'tenant' | 'landlord'; active: boolean; payment: RentPaymentView | null; history: RentPaymentView[];
};

function rentWorkflow(view: RentView | null) {
  return view?.payment ?? view?.history.find(payment => payment.state !== 'confirmed') ?? null;
}

function RentPayments({ agreementId, role, request, enabled, children }: {
  agreementId: string; role: TenancyJourney['role']; request: Request; enabled: boolean;
  children: (view: { rent: RentView | null; due: boolean; action: ReactNode; history: ReactNode }) => ReactNode;
}) {
  const wallet = useRentalWallet();
  const [rent, setRent] = useState<RentView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Keep exact approved bytes through ambiguous submission failures; never approve replacements.
  const [signed, setSigned] = useState<Record<string, `0x${string}`>>({});
  const [review, setReview] = useState<string | null>(null);
  const acting = useRef(false);
  const automaticReview = useRef<string | null>(null);
  const path = `/api/rent?agreement=${encodeURIComponent(agreementId)}`;
  const load = useCallback(async () => {
    const result = await request<{ rent: RentView | null }>(path);
    setRent(result.rent);
    return result.rent;
  }, [path, request]);
  useEffect(() => {
    if (!enabled || role === 'arbitrator') return;
    let active = true;
    const update = async () => {
      try {
        const result = await request<{ rent: RentView | null }>(path);
        if (active) setRent(result.rent);
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Could not read rent.'); }
    };
    void update();
    const timer = setInterval(() => void update(), 15000);
    return () => { active = false; clearInterval(timer); };
  }, [path, request, role, enabled]);
  async function run(work: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true); setError('');
    try { await work(); }
    catch (reason) {
      try {
        if (await recoverExpiredRentReview(reason, () => { setSigned({}); setReview(null); }, prepareReview)) {
          setError('Review refreshed. Check it before signing again.');
        } else setError(reason instanceof Error ? reason.message : 'Rent action failed. Check status before retrying.');
      } catch (refreshError) { setError(refreshError instanceof Error ? refreshError.message : 'Could not refresh rent review.'); }
    } finally { acting.current = false; setBusy(false); }
  }
  async function action(action: 'prepare' | 'reconcile' | 'submit', stepId?: string, signedTransaction?: `0x${string}`) {
    const result = await request<{ rent: RentView | null }>('/api/rent', { agreementId, action, stepId, signedTransaction });
    setRent(result.rent);
    return result.rent;
  }
  async function prepareReview() {
    const updated = await action('prepare');
    const step = rentWorkflow(updated)?.steps.find(item => item.state !== 'confirmed');
    if (step?.state === 'prepared' && !step.hash && step.request) {
      setSigned(bytes => { const retained = { ...bytes }; delete retained[step.id]; return retained; });
      setReview(step.id);
    } else setReview(null);
  }
  const payment = rentWorkflow(rent);
  const currentTransfer = payment?.steps.find(step => step.state !== 'confirmed');
  const nextReviewId = rent?.role === 'tenant' && rent.active && currentTransfer?.state === 'prepared'
    && payment?.steps[0]?.state === 'confirmed' && !currentTransfer.hash ? currentTransfer.id : null;
  useEffect(() => {
    if (!nextReviewId || automaticReview.current === nextReviewId || review === nextReviewId || acting.current) return;
    const timer = setTimeout(() => {
      automaticReview.current = nextReviewId;
      void run(prepareReview);
    }, 0);
    return () => clearTimeout(timer);
    // Advance only on a newly confirmed first transfer, not every polling refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextReviewId, busy, review]);
  const month = payment?.month ?? rent?.month;
  const monthLabel = month ? new Date(`${month}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'This month';
  const paidMonth = rent ? paidRentMonth(rent) : null;
  const due = Boolean(role === 'tenant' && ((rent?.active && !paidMonth) || (payment && payment.state !== 'confirmed')));
  const actionContent = <div className="rent-action"><ActionBox title={payment && payment.state !== 'confirmed' ? 'Finish this rent payment' : `Pay rent for ${monthLabel}`}>
    {error && <p className="note" role="alert">{error}</p>}
    {!rent && !error && <p role="status">Loading rent status…</p>}
    <button type="button" className="text-button rent-refresh" disabled={busy} onClick={() => void run(async () => { if (role === 'landlord') await load(); else await action('reconcile'); })}>Refresh</button>
    {rent && <>
      {rent.role === 'tenant' && rent.active && !payment && <button className="button primary" disabled={busy} onClick={() => void run(prepareReview)}>Pay transfer 1</button>}
      {paidMonth ? <>
        <p>Landlord: {money(payment!.landlordRaw)} test dollars · building stakers: {money(payment!.buildingRaw)} test dollars · Robinhood Chain testnet</p>
        <p>{paidMonth.nextDue}</p>
        {payment!.steps.map(step => step.hash && <p key={step.id}><a href={`https://explorer.testnet.chain.robinhood.com/tx/${step.hash}`} target="_blank" rel="noopener noreferrer">{step.kind === 'landlord' ? 'Landlord' : 'Building stakers'} confirmed receipt</a></p>)}
      </> : <>
        {month !== rent.month && <p role="status">Finish this saved {monthLabel} payment before starting rent for {new Date(`${rent.month}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}. Confirmed transfers will not be paid again.</p>}
        <p>{money(payment?.rentMonthly ?? rent.rentMonthly)} in two transfers: {money(payment?.landlordRaw ?? rent.landlordRaw)} to your landlord and {money(payment?.buildingRaw ?? rent.buildingRaw)} to the house (fixed 20 %). You review each transfer before signing.</p>
        {!rent.active && <p role="status">This tenancy is not active for rent payment.</p>}
      </>}
      <p className="small-copy">Fictional test rent: no value, no legal rights.</p>
      {payment?.error && <p className="note" role="alert">{payment.error}</p>}
      {!paidMonth && payment?.steps.map((step, index) => <div key={step.id} style={{ marginTop: 16, overflowWrap: 'anywhere' }}>
        <strong>Transfer {index + 1}: {step.kind === 'landlord' ? 'Landlord' : 'Building distributor'} · {money(step.amountRaw)} test dollars</strong>
        <p className="small-copy">Exact amount: {step.amountRaw} token units · recipient: {step.recipient} · {step.state}</p>
        {step.hash && <a href={`https://explorer.testnet.chain.robinhood.com/tx/${step.hash}`} target="_blank" rel="noopener noreferrer">{step.state === 'confirmed' ? 'Confirmed transfer receipt' : 'Submitted transaction (not yet confirmed)'}</a>}
        {step.error && <p className="note" role="alert">{step.error}</p>}
        {rent.role === 'tenant' && rent.active && currentTransfer?.id === step.id && ((!step.hash && !signed[step.id] && step.state === 'prepared') || (step.state === 'stopped' && (step.retryable || (!step.hash && !signed[step.id])))) && <>
          {review !== step.id || !step.request ? <button className="button primary" disabled={busy} onClick={() => void run(prepareReview)}>Pay transfer {index + 1}</button> : <div className="small-copy">
            <p>{step.request.description}</p>
            <p>Chain ID: {step.request.transaction.chainId} · token contract: {step.request.transaction.to} · expires: {step.request.expiresAt}</p>
            <p>Transaction data: {String(step.request.transaction.data ?? '')}</p>
            <button className="button primary" disabled={busy} onClick={() => void run(async () => {
              const current = await load();
              const fresh = rentWorkflow(current)?.steps.find(item => item.id === step.id);
              if (!current?.active || fresh?.state !== 'prepared' || fresh.hash || !fresh.request) { setReview(null); throw new Error('Transfer status changed. Check rent status.'); }
              if (JSON.stringify(fresh.request) !== JSON.stringify(step.request)) { setReview(null); throw new Error('Transfer changed. Review it again.'); }
              if (Date.parse(fresh.request.expiresAt) <= Date.now()) { await prepareReview(); setError('Review refreshed. Check it before signing.'); return; }
              const bytes = await wallet.signEvmTransaction(fresh.request);
              setSigned(previous => ({ ...previous, [step.id]: bytes }));
              setReview(null);
              await action('submit', step.id, bytes);
            })}>Sign and send transfer {index + 1}</button>
          </div>}
        </>}
        {rent.role === 'tenant' && !step.retryable && (signed[step.id] || step.state === 'signed' || step.state === 'submitted') && step.state !== 'confirmed' && <button className="button primary" disabled={busy} onClick={() => void run(async () => {
          const current = await action('reconcile');
          const fresh = rentWorkflow(current)?.steps.find(item => item.id === step.id);
          if (signed[step.id] && fresh && !fresh.hash && fresh.state !== 'confirmed') await action('submit', step.id, signed[step.id]);
        })}>Retry the same signed transfer</button>}
      </div>)}
    </>}
  </ActionBox></div>;
  const rentRecords = rent?.history.some(record => record.id === payment?.id) || !payment
    ? rent?.history ?? [] : [payment, ...rent?.history ?? []];
  const history = <>
    {error && <p className="note" role="alert">{error}</p>}
    {!rent && !error && <p>Loading rent status…</p>}
    <button type="button" className="text-button" disabled={busy} onClick={() => void run(async () => { if (role === 'landlord') await load(); else await action('reconcile'); })}>Refresh</button>
    {rent && <>
      {paidMonth && <p>{paidMonth.heading}. {paidMonth.nextDue}</p>}
      {rentRecords.length === 0 && <p>No rent payment records yet.</p>}
      {rentRecords.map(payment => <div key={payment.id} style={{ overflowWrap: 'anywhere' }}>
        <p><strong>{payment.month}</strong> · {payment.state} · landlord {money(payment.landlordRaw)} / building {money(payment.buildingRaw)} test dollars</p>
        {payment.steps.map(step => <p key={step.id}>{step.kind}: {step.state} · {money(step.amountRaw)} test dollars · exact amount: {step.amountRaw} token units · recipient: {step.recipient}{step.hash && <> · <a href={`https://explorer.testnet.chain.robinhood.com/tx/${step.hash}`} target="_blank" rel="noopener noreferrer">Transaction receipt</a></>}</p>)}
      </div>)}
    </>}
  </>;
  return children({ rent, due, action: due ? actionContent : error && enabled ? <p role="alert">{error}</p> : null, history });
}

type TenancyAgreement = {
  createdAt: string;
  requiredSecurity: string;
  releaseAllowed: boolean;
  rentTerms?: BuildingRentTerms;
  digest: string | null;
  accepted: Partial<Record<'tenant' | 'landlord', { digest: string; at: string }>>;
  parties: Partial<Record<'tenant' | 'landlord' | 'arbitrator', { subject: string; wallet?: { address: string } }>>;
  records: { id: string; name: string; body: string; by: string; at: string }[];
};
type TenancyOperation = {
  id: string;
  action: { kind: string };
  role: string;
  state: string;
  createdAt: string;
  signature: string | null;
};

function TenancyDetails({ journey, request }: { journey: TenancyJourney; request: Request }) {
  const [agreement, setAgreement] = useState<TenancyAgreement | null>(null);
  const [operations, setOperations] = useState<TenancyOperation[]>([]);
  const [error, setError] = useState('');
  const [operationsError, setOperationsError] = useState(false);
  const { agreementId, chain } = journey;
  const hasChain = chain !== null;
  useEffect(() => {
    let active = true;
    Promise.allSettled([
      request<{ agreement: TenancyAgreement }>(`/api/agreements/${encodeURIComponent(agreementId)}`),
      hasChain ? request<{ operations: TenancyOperation[] }>(`/api/finance/solana?agreement=${encodeURIComponent(agreementId)}`) : Promise.resolve(null),
    ]).then(([terms, snapshot]) => {
      if (!active) return;
      if (terms.status === 'fulfilled') {
        setAgreement(terms.value.agreement);
        setError('');
      } else setError(terms.reason instanceof Error ? terms.reason.message : 'Agreement records are unavailable.');
      setOperations(snapshot.status === 'fulfilled' ? snapshot.value?.operations ?? [] : []);
      setOperationsError(snapshot.status === 'rejected');
    });
    return () => { active = false; };
  }, [request, agreementId, hasChain, chain?.phase, journey.stage, journey.next.kind, chain?.releasedAtomic]);
  const entries = agreement ? [
    { id: 'created', at: agreement.createdAt, title: 'Agreement created', detail: 'Recorded tenancy terms' },
    ...(['tenant', 'landlord'] as const).flatMap((role) => agreement.accepted[role]
      ? [{ id: `accepted-${role}`, at: agreement.accepted[role].at, title: `Agreement accepted by ${role}`, detail: 'Same agreement digest' }]
      : []),
    ...agreement.records.map((record) => ({
      id: record.id, at: record.at, title: `${record.name} · ${Object.entries(agreement.parties).find(([, value]) => value?.subject === record.by)?.[0] ?? 'party'}`, detail: record.body,
    })),
    ...operations.map((op) => ({
      id: op.id, at: op.createdAt, title: operationLabels[op.action.kind] ?? op.action.kind.replaceAll('_', ' '),
      detail: `${op.role} · ${op.state}${op.signature ? ` · transaction ${op.signature}` : ''}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)) : [];
  return (
    <div className="tenancy-details">
    <p className="small-copy">Under §551 BGB a real deposit must be invested at the usual savings rate; its earnings belong to the tenant and add to the deposit.{journey.depositForm?.kind === 'shares' ? ' This test share-backed security earns no deposit yield.' : ' On this site, earnings on a real-money deposit would come from lending it out.'} This is not legal advice; these test tokens have no value.</p>
      {error && <p className="note" role="alert">{error}</p>}
      {!agreement && !error && <p className="small-copy">Loading tenancy records…</p>}
      {agreement && (
        <>
          <dl className="tenancy-record-facts">
            <div><dt>Agreement</dt><dd>{agreement.digest && agreement.accepted.tenant?.digest === agreement.digest && agreement.accepted.landlord?.digest === agreement.digest ? 'Accepted by both parties' : 'Awaiting acceptance'}</dd></div>
            <div><dt>{journey.depositForm?.kind === 'shares' ? 'Security · backed by test TSLA' : 'Required deposit · test USDC'}</dt><dd>{money(journey.depositForm?.kind === 'shares' ? journey.depositForm.securityUsd6 : agreement.requiredSecurity)}{journey.depositForm?.kind !== 'shares' && ' test USDC'}</dd></div>
            {journey.depositForm?.kind !== 'shares' && <div><dt>Earnings release policy</dt><dd>{agreement.releaseAllowed ? 'Tenant may claim surplus during tenancy' : 'Surplus remains locked until settlement'} · {!chain ? 'test tokens only; any deposit earnings belong to the tenant.' : chain.depositMint === SOLANA_TEST_USDC_MINT ? 'the deposit stays in cash escrow; this site pays labelled simulated yield to the tenant.' : 'devnet lending pays nothing; earnings are simulated.'}</dd></div>}
            {chain && <div><dt>Claim status</dt><dd>{chain.phase === 'claim-proposed' ? 'Awaiting tenant answer' : chain.phase === 'disputed' ? 'Disputed' : chain.phase === 'settling' ? 'Settling' : chain.phase === 'closed' ? 'Closed' : BigInt(chain.claimAtomic) > 0n ? 'Claim recorded' : 'No deduction proposed'}</dd></div>}
            {chain && BigInt(chain.claimAtomic) > 0n && <div><dt>Requested deduction</dt><dd>{money(chain.claimAtomic)} test USDC</dd></div>}
            {chain && (chain.phase === 'settling' || chain.phase === 'closed') && <div><dt>Approved deduction</dt><dd>{money(chain.approvedClaimAtomic)} test USDC</dd></div>}
          </dl>
          {agreement.digest && <p className="small-copy">Agreement digest: <span className="mono">{agreement.digest}</span></p>}
          <h3>Activity & shared records</h3>
          <p className="small-copy">Only this tenancy’s recorded agreement, evidence and test-network operations. Prepared operations are not completed payments.</p>
          {operationsError && <p className="note">Test-network operations are unavailable right now; agreement records are still shown.</p>}
          <div className="tenancy-activity">
            {entries.map((entry) => (
              <article className="record-item" key={entry.id}>
                <strong>{entry.title}</strong>
                <span className="small-copy">{new Date(entry.at).toLocaleString('en-GB')}</span>
                <p className="record-body">{entry.detail}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function JoinInvitation({ request, encoded, onDone }: { request: Request; encoded: string; onDone: () => Promise<void> }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [home, setHome] = useState<{ property: string; requiredSecurity: string; depositForm?: DepositForm } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const value = useMemo(() => invitationPayload(encoded), [encoded]);
  useEffect(() => {
    if (!value) return;
    let active = true;
    request<{ invitation: { property: string; requiredSecurity: string; depositForm?: DepositForm } }>(`/api/agreements/${encodeURIComponent(value.id)}`, { action: 'preview', role: value.role, token: value.token })
      .then(({ invitation }) => { if (active) { setHome(invitation); setPreviewFailed(false); } })
      .catch(() => { if (active) setPreviewFailed(true); });
    return () => { active = false; };
  }, [value, request, previewRetry]);
  async function join() {
    if (!value) return;
    setBusy(true);
    try {
      await request(`/api/agreements/${encodeURIComponent(value.id)}`, { action: 'join', role: value.role, token: value.token });
      history.replaceState(null, '', window.location.pathname + window.location.search);
      await onDone();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The invitation could not be used.');
    } finally { setBusy(false); }
  }
  return (
    <ActionBox level={2} title={value ? `Join as ${value.role}` : 'Invitation'}>
      {!value ? <p>This invitation link is malformed. Ask the landlord for a new one.</p> : <>
        {home ? <p>{home.property} · {home.depositForm?.kind === 'shares' ? `${depositUsd(home.depositForm.securityUsd6)} USD security in test TSLA. A verified EVM wallet is required.` : `${money(home.requiredSecurity)} test USDC deposit at stake.`}</p> : previewFailed ? <p>This invitation cannot be previewed. It may have expired or been replaced. <button className="button secondary" onClick={() => setPreviewRetry((count) => count + 1)}>Try again</button></p> : <p>Checking this tenancy invitation…</p>}
        <p>{value.role === 'arbitrator' ? 'You decide a disputed deduction only, up to the landlord’s claim. You cannot take the deposit or start a claim.' : 'You join as the tenant. The landlord may propose a deduction at move-out; you may agree or dispute it.'} Joining records your account and wallet as the {value.role} on this tenancy; it does not sign or fund the deposit.</p>
        <button className="button primary large" disabled={!home || busy} onClick={() => void join()}>{busy ? <Loader2 className="spin" size={16} /> : null} Join this tenancy <ArrowRight size={17} /></button>
      </>}
      <button className="button secondary" onClick={() => { history.replaceState(null, '', window.location.pathname + window.location.search); window.dispatchEvent(new HashChangeEvent('hashchange')); }}>Not now</button>
      {message && <p className="note" role="alert">{message}</p>}
    </ActionBox>
  );
}

const PRESETS = [
  'photo-1502672260266-1c1ef2d93688',
  'photo-1522708323590-d24dbb6b0267',
  'photo-1560448204-e02f11c3d0e2',
  'photo-1493809842364-78817add7ffb',
  'photo-1484154218962-a197022b5858',
  'photo-1505691938895-1758d7feb511',
].map((id) => `/samples/${id}.jpg`);

function ListingCard({ listing, children, photoNotice = true }: { listing: PublicListing; children?: React.ReactNode; photoNotice?: boolean }) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const d = listing.details;
  const facts = [d.city || 'City not specified', d.rooms ? `${d.rooms} room${d.rooms > 1 ? 's' : ''}` : 'Rooms not specified', d.sizeSqm ? `${d.sizeSqm} m²` : '',
    d.availableFrom ? `from ${new Date(d.availableFrom).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''].filter(Boolean);
  return (
    <article className="listing-card">
      <div className="listing-photo">
        {/* eslint-disable-next-line @next/next/no-img-element -- self-hosted illustrative samples */}
        {d.photos[photoIndex] ? <img src={d.photos[photoIndex]} alt={`Illustrative sample interior ${photoIndex + 1}, not a photograph of this dwelling`} loading="lazy" /> : <HomeIcon size={42} aria-label="No listing photo" />}
        {d.photos.length > 1 && <span className="photo-count">{photoIndex + 1}/{d.photos.length}</span>}
      </div>
      <div className="listing-body">
        <header><strong>{listing.title}{listing.sample && !listing.title.toLowerCase().includes('sample') ? ' · sample home' : ''}</strong><span className="listing-rent">{money(listing.rentMonthly)}<small>/month · {listing.buildingRent ? 'test dollars · Robinhood testnet' : 'test USDC'}</small></span></header>
        {listing.buildingRent && <p className="small-copy">Fictional tHOME building · fixed 20 % rent share to stakers; 80 % to the landlord. Deposit and its earnings stay separate; test units have no value or legal rights.</p>}
        {facts.length > 0 && <p className="listing-facts">{facts.join(' · ')}</p>}
        {photoNotice && d.photos.length > 0 && <p className="small-copy">Illustrative sample interiors, not photographs of this dwelling.</p>}
        <p className="listing-deposit"><span>Required deposit · {listing.depositForm?.kind === 'shares' ? 'Robinhood Chain testnet' : 'Solana devnet'}</span><strong>{listing.depositForm?.kind === 'shares' ? `${depositUsd(listing.depositForm.securityUsd6)} USD · test TSLA` : `${money(listing.requiredSecurity)} test USDC`}</strong></p>
        {listing.location && <FlatMap location={listing.location} />}
        {children}
        {(listing.description || d.photos.length > 1) && <div className="listing-details">
          {listing.description && <p className="listing-description">{listing.description}</p>}
          {d.photos.length > 1 && <div className="listing-gallery" aria-label={`Photos of ${listing.title}`}>
            {d.photos.map((photo, index) => <button type="button" key={index} aria-label={`Show photo ${index + 1} of ${listing.title}`} aria-pressed={photoIndex === index} onClick={() => setPhotoIndex(index)}>
              {/* eslint-disable-next-line @next/next/no-img-element -- self-hosted illustrative samples */}
              <img src={photo} alt="" loading="lazy" />
            </button>)}
          </div>}
        </div>}
      </div>
    </article>
  );
}

function ApplicantsReview({ listing, request, reload }: { listing: PublicListing; request: Request; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(body: unknown) {
    setBusy(true); setError('');
    try { await request(`/api/listings/${listing.id}`, body); await reload(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Please try again.'); }
    finally { setBusy(false); }
  }
  return <div id={`listing-${listing.id}`} tabIndex={-1}><ActionBox level={2} title={`${listing.title} · ${listing.applications?.length ?? 0} application${listing.applications?.length === 1 ? '' : 's'}`}>
    <p className="small-copy">Choosing creates the agreement and cannot be undone here. Tell the applicant yourself; the app sends no notification.</p>
    {listing.applications?.map(a => <div className="applicant" key={a.id}><div><strong>{a.name}</strong><p>{a.message}</p></div><button className="button primary" disabled={busy} onClick={() => { if (window.confirm(`Choose ${a.name} for ${listing.title}? This creates the agreement and cannot be undone here.`)) void act({action: 'choose', applicationId: a.id}); }}>Choose this tenant</button></div>)}
    <button className="button secondary" disabled={busy} onClick={() => { if (window.confirm(`Close ${listing.title}? Applicants will not be notified. This cannot be undone.`)) void act({action: 'close'}); }}>Close listing</button>
    {error && <p className="note" role="alert">{error}</p>}
    <ListingCard listing={listing} />
  </ActionBox></div>;
}

function ApplicationStatus({ listing, request, reload }: { listing: PublicListing; request: Request; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function withdraw() {
    if (!window.confirm(`Withdraw your application for ${listing.title}? This cannot be undone.`)) return;
    setBusy(true); setError('');
    try { await request(`/api/listings/${listing.id}`, {action: 'withdraw'}); await reload(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Please try again.'); }
    finally { setBusy(false); }
  }
  return <div id={`listing-${listing.id}`} tabIndex={-1}><ActionBox level={2} title={listing.title} tone="waiting">
    <p>{applicationStatusLabel(listing)}</p>
    {listing.relation === 'applicant' && listing.status === 'open' && <button className="button secondary" disabled={busy} onClick={() => void withdraw()}>Withdraw application</button>}
    {error && <p className="note" role="alert">{error}</p>}
  </ActionBox></div>;
}

function takePublishHomeIntent() {
  if (typeof window === 'undefined') return false;
  const pending = sessionStorage.getItem(PUBLISH_HOME_NAVIGATION_INTENT) === '1';
  sessionStorage.removeItem(PUBLISH_HOME_NAVIGATION_INTENT);
  return pending;
}

function PublishHome({ listings, request, reload, go, tenancyIds }: {
  listings: PublicListing[]; request: Request; reload: () => Promise<void>; go: (area: Area) => void; tenancyIds: Set<string>;
}) {
  const [posting, setPosting] = useState(takePublishHomeIntent);
  useEffect(() => {
    const open = () => { if (takePublishHomeIntent()) setPosting(true); };
    window.addEventListener(PUBLISH_HOME_NAVIGATION_INTENT, open);
    return () => window.removeEventListener(PUBLISH_HOME_NAVIGATION_INTENT, open);
  }, []);
  const [depositForm, setDepositForm] = useState<'cash' | 'shares'>('cash');
  const [depositTracksRent, setDepositTracksRent] = useState(true);
  const [buildingHome, setBuildingHome] = useState(false);
  const [form, setForm] = useState({ title: '', city: '', rooms: '2', sizeSqm: '55', availableFrom: '', description: '', rent: '900', deposit: '2700', releaseAllowed: true });
  const [photos, setPhotos] = useState<string[]>([]);
  const [location, setLocation] = useState<HomeLocation | undefined>();
  const [catalogue, setCatalogue] = useState<{ id: string; name: string; center: [number, number] }[]>([]);
  useEffect(() => {
    if (!posting) return;
    let active = true;
    request<{ state: string; data?: { coveredCities: typeof catalogue }; coveredCities?: typeof catalogue }>('/api/city-signals?city=strausberg')
      .then(result => { if (active) setCatalogue(result.data?.coveredCities ?? result.coveredCities ?? []); }).catch(() => {});
    return () => { active = false; };
  }, [posting, request]);
  const cityCenter = catalogue.find(city => city.name.toLowerCase() === form.city.trim().toLowerCase() || city.id === form.city.trim().toLowerCase())?.center;
  const [feedback, setFeedback] = useState<{ target: string | null; message: string }>({ target: null, message: '' });
  async function act(work: () => Promise<unknown>, target: string | null = null) {
    setFeedback({ target, message: '' });
    try {
      await work();
      await reload();
    } catch (e) {
      setFeedback({ target, message: e instanceof Error ? e.message : 'Please try again.' });
    }
  }
  const suggestedDeposit = (rent: string, kind = depositForm) => {
    try {
      const maximum = BigInt(maximumDepositSecurity(parseAmount(rent.replace(',', '.')), kind));
      const fraction = (maximum % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
      return `${maximum / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
    } catch { return null; }
  };
  const togglePhoto = (url: string) =>
    setPhotos((current) => (current.includes(url) ? current.filter((p) => p !== url) : current.length >= 4 ? current : [...current, url]));
  const field = (key: keyof typeof form) => ({ value: String(form[key]), onChange: (e: { target: { value: string } }) => {
    const value = e.target.value;
    if (key === 'deposit') setDepositTracksRent(value.replace(',', '.') === suggestedDeposit(form.rent));
    setForm((current) => {
      if (key === 'rent') {
        const suggestion = suggestedDeposit(value);
        return { ...current, rent: value, ...(depositTracksRent && suggestion !== null ? { deposit: suggestion } : {}) };
      }
      return { ...current, [key]: value };
    });
  } });
  const mine = listings.filter((l) => l.relation === 'landlord' && !(l.agreementId && tenancyIds.has(l.agreementId)) && !(l.status === 'open' && (l.applications?.length ?? 0) > 0));
  return (
    <section className="card homes">
      <div className="housing-listing-heading">
        <button type="button" className="button secondary" aria-expanded={posting} onClick={() => setPosting(!posting)}><Plus size={15} /> {listings.some(l => l.relation === 'landlord') ? 'Rent out another home' : 'Rent out a home'}</button>
      </div>
      {feedback.target === null && feedback.message && <p className="note" role="alert">{feedback.message}</p>}
      {posting && (
        <form className="listing-form" onSubmit={(e) => { e.preventDefault(); void act(async () => {
          const rentMonthly = parseAmount(form.rent.replace(',', '.'));
          const requiredSecurity = parseAmount(form.deposit.replace(',', '.'));
          validateDepositSecurity(rentMonthly, requiredSecurity, depositForm);
          await request('/api/listings', {
            title: form.title, city: form.city, location, rooms: Number(form.rooms), sizeSqm: Number(form.sizeSqm), availableFrom: form.availableFrom,
            description: form.description, photos, rentMonthly, requiredSecurity, releaseAllowed: form.releaseAllowed,
            depositForm, buildingHome,
          });
          setPosting(false);
        }, 'post'); }}>
          <label className="wide">Title<input required placeholder="Bright 2-room flat near the park" {...field('title')} /></label>
          <label>City<input placeholder="Strausberg" {...field('city')} /></label>
          <label>Rooms<input type="number" min={1} max={20} {...field('rooms')} /></label>
          <label>Size (m²)<input type="number" min={10} max={1000} {...field('sizeSqm')} /></label>
          <label>Available from<input type="date" {...field('availableFrom')} /></label>
          <label>Monthly cold rent ({buildingHome ? 'test dollars · Robinhood testnet' : 'test USDC'})<input inputMode="decimal" {...field('rent')} /></label>
          <label>Deposit ({depositForm === 'shares' ? 'USD' : 'test USDC'})<input inputMode="decimal" {...field('deposit')} /></label>
          <label>Deposit form<select value={depositForm} onChange={e => {
            const kind = e.target.value as 'cash' | 'shares';
            setDepositForm(kind);
            setDepositTracksRent(true);
            const suggestion = suggestedDeposit(form.rent, kind);
            if (suggestion !== null) setForm(current => ({ ...current, deposit: suggestion }));
          }}><option value="cash">Cash · site tUSDC</option><option value="shares">Shares · test TSLA</option></select></label>
          {depositForm === 'shares' && <div className="wide"><ShareDepositRules />{!shareDepositManifest.factory && <p role="status">Share deposit not deployed yet. Publication and funding are disabled.</p>}</div>}
          <label className="policy-check wide"><input type="checkbox" checked={buildingHome} onChange={event => setBuildingHome(event.target.checked)} /> Fictional tHOME building home · fixed 20 % of test rent to building stakers, 80 % to landlord.</label>
          {buildingHome && <div className="wide small-copy"><p>A fixed 20 % of this test rent goes to the fictional building&apos;s tHOME stakers; the rest goes to the landlord. This simulates how a tokenized building could share net rental income; in a real building rent goes to the property owner under the lease. Not legal advice.</p><p>Monthly rent uses test dollars on Robinhood Chain testnet in two separate transfers. The deposit remains separate; deposit earnings belong to the tenant. Fictional units have no value and confer no ownership or tenancy rights.</p></div>}
          <p className="wide small-copy">{depositForm === 'shares'
            ? 'Share-backed security is capped at two months’ net cold rent because 150% share cover reaches the three-month cap under §551(1) BGB; not legal advice; test networks.'
            : 'Cash security is capped at three months’ net cold rent under §551(1) BGB; not legal advice; test networks.'} {suggestedDeposit(form.rent) !== null && `Suggested maximum: ${suggestedDeposit(form.rent)} ${depositForm === 'shares' ? 'test USD security' : 'test USDC'}.`} Token escrow is not a statement of legal compliance.</p>
          <label className="wide">Description<textarea rows={3} placeholder="Balcony, fitted kitchen, 5 minutes to the U-Bahn…" {...field('description')} /></label>
          <div className="wide"><span className="field-label">Place the flat on the map (optional)</span><FlatMap location={location} center={cityCenter} onChange={setLocation} /></div>
          <div className="wide">
            <span className="field-label">Photos (up to 4): self-hosted samples only · no uploads</span>
            <div className="photo-picker">
              {PRESETS.map((url) => (
                <button type="button" key={url.slice(-40)} className={photos.includes(url) ? 'selected' : ''} onClick={() => togglePhoto(url)}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- self-hosted illustrative samples */}
                  <img src={url} alt="" />
                  {photos.includes(url) && <span><Check size={14} /></span>}
                </button>
              ))}
            </div>
          </div>
          {depositForm === 'cash' && <label className="policy-check wide"><input type="checkbox" checked={form.releaseAllowed} onChange={(e) => setForm({ ...form, releaseAllowed: e.target.checked })} /> Let the tenant claim surplus and simulated yield during the tenancy. Site tUSDC stays in cash escrow; this site separately pays labelled simulated yield (5 % a year by default). Otherwise it is claimable after settlement. Any deposit earnings belong to the tenant, who keeps deposit value above an approved deduction at settlement either way.</label>}
          {feedback.target === 'post' && feedback.message && <p className="note wide" role="alert">{feedback.message}</p>}
          <button className="button primary large" disabled={depositForm === 'shares' && !shareDepositManifest.factory}>Publish home</button>
        </form>
      )}
      {mine.length > 0 && (
        <div className="my-listings">
          <h3>My listings</h3>
          {mine.map((l) => (
            <div key={l.id} id={`listing-${l.id}`} tabIndex={-1}>
              <ListingCard listing={l}>
                <p className="small-copy">{l.status === 'open' ? `Review applications (${l.applicants})` : l.status === 'closed' ? 'Listing closed' : 'Tenant chosen'}</p>
                {l.status === 'open' && <button className="button secondary" onClick={() => { if (window.confirm(`Close ${l.title}? Applicants will not be notified. This cannot be undone.`)) void act(() => request(`/api/listings/${l.id}`, { action: 'close' }), l.id); }}>Close listing</button>}
                {l.agreementId && <button type="button" className="text-button" onClick={() => goToSection(go, 'home', `tenancy-${l.agreementId}`)}>Open the agreement →</button>}
                {feedback.target === l.id && feedback.message && <p className="note" role="alert">{feedback.message}</p>}
              </ListingCard>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ListingBrowser({ listings, request, reload, loaded, loadError, testTools }: { listings: PublicListing[]; request: Request; reload: () => Promise<void>; loaded: boolean; loadError: string; testTools: boolean }) {
  const [applyTo, setApplyTo] = useState<string | null>(null);
  const [application, setApplication] = useState({ name: '', message: '' });
  const [feedback, setFeedback] = useState<{target: string | null; message: string}>({target: null, message: ''});
  const others = listings.filter(l => l.relation === null && l.status === 'open');
  async function act(work: () => Promise<unknown>, target: string) {
    setFeedback({target, message: ''});
    try { await work(); await reload(); } catch (error) { setFeedback({target, message: error instanceof Error ? error.message : 'Please try again.'}); }
  }
  return <section className="card homes" tabIndex={-1}><h2>Find a home</h2>{others.length > 0 && <p className="small-copy">Photos are illustrative sample interiors, not photographs of these homes.</p>}
      <div className="listing-grid">
        {others.map((l) => (
          <div key={l.id} id={`listing-${l.id}`} tabIndex={-1}>
            <ListingCard listing={l} photoNotice={false}>
            {(applyTo === l.id ? (
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act(async () => {
                await request(`/api/listings/${l.id}`, { action: 'apply', ...application });
                setApplyTo(null);
              }, l.id); }}>
                <label>Nickname shown to the landlord<input required minLength={2} maxLength={40} value={application.name} onChange={(e) => setApplication({ ...application, name: e.target.value })} /><span className="small-copy">No real name needed; this test site does not verify identity</span></label>
                <label>Message to the landlord (optional)<input maxLength={500} value={application.message} onChange={(e) => setApplication({ ...application, message: e.target.value })} /></label>
                {feedback.target === l.id && feedback.message && <p className="note" role="alert">{feedback.message}</p>}
                <p className="small-copy">{l.depositForm?.kind !== 'shares' && <>Site tUSDC stays in cash escrow, not lent. Yield is simulated and paid separately to the tenant; {l.releaseAllowed ? 'claimable during the tenancy.' : 'claimable after settlement.'} </>}This sends your application. It does not reserve the home or lock a deposit.</p>
                {l.depositForm?.kind === 'shares' ? <ShareDepositApplication listingId={l.id} request={request} /> : <button className="button primary">Send application</button>}
              </form>
            ) : (
              <button className="button primary" onClick={() => setApplyTo(l.id)}>Apply for this home</button>
            ))}
            {feedback.target === l.id && feedback.message && applyTo !== l.id && <p className="note" role="alert">{feedback.message}</p>}
            </ListingCard>
          </div>
        ))}
      </div>
      {loaded && !loadError && others.length === 0 && <p className="small-copy">No homes are available to apply for right now.{testTools && ' Local rehearsal tools below can add sample homes.'}</p>}
      {!loaded && !loadError && <p className="small-copy" role="status">Checking available homes…</p>}
    </section>;
}

function TestTools({ tenancies, listings, helper, busy, log }: {
  tenancies: TenancyJourney[]; listings: PublicListing[];
  request: Request; helper: Helper; busy: boolean; log: string;
}) {
  function runHelper(body: Record<string, unknown>) {
    void helper(body);
  }
  const disabled = busy;
  return (
    <div className="test-tools">
      <p className="small-copy">These sample parties sign real test-network transactions with operator-held test keys; they are not proof of a person’s wallet. Simulated earnings are separately credited test USDC. Your own tenancy actions remain in its card.</p>
      <div className="test-tool-row">
        <span>Test listings</span>
        <button className="button test-helper" disabled={disabled} onClick={() => runHelper({ action: 'post_home' })}>Add sample homes</button>
      </div>
      {tenancies.map((tenancy) => {
        const act = tenancy.next.kind === 'invite_arbitrator' || (tenancy.next.kind === 'wait' && tenancy.chain?.phase !== 'active');
        const startMoveOut = tenancy.chain?.phase === 'active' && tenancy.role === 'tenant';
        const interest = startMoveOut;
        if (!act && !interest) return null;
        return <div className="test-tool-row" key={tenancy.agreementId}>
          <span>{tenancy.property}</span>
          {act && <button className="button test-helper" disabled={disabled} onClick={() => runHelper({ action: 'act', agreementId: tenancy.agreementId })}>
            {tenancy.next.kind === 'invite_arbitrator' ? 'Use the test arbitrator instead' : 'Let the test party do their step'}
          </button>}
          {startMoveOut && <button className="button test-helper" disabled={disabled} onClick={() => runHelper({ action: 'act', agreementId: tenancy.agreementId })}>Test landlord starts move-out</button>}
          {interest && <button className="button test-helper" disabled={disabled} onClick={() => runHelper({ action: 'interest', agreementId: tenancy.agreementId })}>Simulate a month of interest</button>}
        </div>;
      })}
      {listings.filter((listing) => listing.status === 'open' && (listing.relation === 'landlord' || listing.relation === 'applicant')).map((listing) => (
        <div className="test-tool-row" key={listing.id}>
          <span>{listing.title}</span>
          {listing.relation === 'landlord'
            ? <button className="button test-helper" disabled={disabled} onClick={() => runHelper({ action: 'apply', listingId: listing.id })}>Add a test applicant</button>
            : <button className="button test-helper" disabled={disabled} onClick={() => runHelper({ action: 'act', listingId: listing.id })}>Let the test landlord choose</button>}
        </div>
      ))}
      {log && <p className="test-helper-note" role="status">{busy && <Loader2 className="spin" size={14} />} {log}</p>}
    </div>
  );
}
