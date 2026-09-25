'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  FileText,
  House,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Scale,
  ShieldCheck,
  Sparkles,
  Sprout,
  X,
} from 'lucide-react';
import { networks, type Network, type Role } from '@/domain/assets';
import {
  summary,
  type Command,
  type FinancialOperation,
  type OperationKind,
  type WorkspaceState,
} from '@/domain/workflow';
import { Neighborhood } from './neighborhood';
import { HoldingsShowcase } from './holdings-showcase';
import {
  Badge,
  ConfirmOperation,
  DepositSnapshot,
  Journey,
  Metric,
  NextStep,
  PageHeading,
  PortfolioActions,
  Projection,
  Records,
  Settlement,
  kindLabels,
  money,
} from './workspace-panels';

export type View = 'overview' | 'deposit' | 'settlement' | 'records' | 'activity' | 'connections';
const people = { tenant: 'Maya', landlord: 'Alex', arbitrator: 'Jordan' };
const roles: Role[] = ['tenant', 'landlord', 'arbitrator'];
async function api(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

export function Workspace() {
  const [network, setNetwork] = useState<Network>('solana');
  const [role, setRole] = useState<Role>('tenant');
  const [view, setView] = useState<View>('overview');
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const [confirmation, setConfirmation] = useState<FinancialOperation | null>(null);
  const [showProjection, setShowProjection] = useState(false);
  const [connections, setConnections] = useState<ReactNode>(null);
  const main = useRef<HTMLElement>(null);
  const totals = state ? summary(state) : null;

  useEffect(() => {
    const agreementId = new URLSearchParams(window.location.search).get('agreement');
    if (!agreementId || !/^[a-zA-Z0-9_-]{1,160}$/.test(agreementId)) return;
    const frame = window.requestAnimationFrame(() => setView('connections'));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api('/api/demo', { network }, controller.signal)
      .then((result) => {
        setState(result.state);
        setFailed(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setNotice(error.message);
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, [network]);
  useEffect(() => {
    if (view === 'connections' && !connections)
      import('./connections').then((module) => setConnections(<module.Connections />));
  }, [view, connections]);

  async function refresh() {
    if (state) {
      const result = await api(`/api/workspaces/${state.id}?role=${role}`);
      setState(result.state);
    }
  }
  async function command(value: Command) {
    if (!state || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await api(`/api/workspaces/${state.id}`, {
        role,
        command: value,
        commandId: crypto.randomUUID(),
        revision: state.revision,
      });
      setState(result.state);
      setFailed(false);
      if (value.type === 'plan') setConfirmation(result.state.operations[0]);
      else setNotice(result.state.activity[0]?.detail || 'Saved.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Please try again.');
      setFailed(true);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function reconcile() {
    if (!state || busy) return;
    setBusy(true);
    try {
      const result = await api(`/api/workspaces/${state.id}/reconcile`, { role });
      setState(result.state);
      setNotice(result.state.activity[0].detail);
      setFailed(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Reconciliation is unavailable.');
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: View) {
    setView(next);
    setNotice('');
    main.current?.scrollIntoView({ block: 'start' });
  }
  const plan = (kind: OperationKind, amount?: string) => command({ type: 'plan', kind, amount });
  async function restart() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api('/api/demo', { network, restart: true });
      setState(result.state);
      setNotice('A fresh fictional tenancy is ready.');
      setConfirmation(null);
      setFailed(false);
    } catch (error) {
      setNotice(String(error));
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  function download() {
    if (!state) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `example-${network}-tenancy.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  const nav = [
    {
      id: 'overview' as const,
      label: role === 'tenant' ? 'Your overview' : 'Overview',
      icon: LayoutDashboard,
    },
    { id: 'deposit' as const, label: 'Rental deposit', icon: LockKeyhole },
    { id: 'settlement' as const, label: 'Claims & settlement', icon: Scale },
    { id: 'records' as const, label: 'Shared records', icon: FileText },
    { id: 'activity' as const, label: 'Activity', icon: Clock3 },
  ];

  return (
    <div className="app-shell wealth-app">
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate('overview')}>
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>
            Deposit
            <br />
            <strong>workspace</strong>
          </span>
        </button>
        <div className="workspace-picker">
          <span className="avatar small">{people[role][0]}</span>
          <div>
            <strong>{people[role]}’s workspace</strong>
            <span>{role[0].toUpperCase() + role.slice(1)}</span>
          </div>
          <span className="tiny-dot" />
        </div>
        <span className="nav-caption">YOUR WORKSPACE</span>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <button
              className={`nav-item ${view === item.id ? 'selected' : ''}`}
              key={item.id}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Sprout size={23} />
            <strong>
              Small beginnings.
              <br />
              Something of your own.
            </strong>
            <p>A personal portfolio that stays with you, wherever you live next.</p>
          </div>
          <button
            className={`nav-item ${view === 'connections' ? 'selected' : ''}`}
            aria-current={view === 'connections' ? 'page' : undefined}
            onClick={() => navigate('connections')}
          >
            <Link2 size={18} />
            Connections & proof
          </button>
          <div className="sidebar-foot">
            Built around your next chapter.<span>Brand name to come.</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            {view === 'connections' ? (
              <>
                <ShieldCheck size={16} />
                <span>Account</span>
                <ChevronRight size={14} />
                <strong>Connected proof</strong>
              </>
            ) : (
              <>
                <House size={16} />
                <span>Cedar Court</span>
                <ChevronRight size={14} />
                <strong>Apartment 04</strong>
              </>
            )}
          </div>
          {view !== 'connections' && (
            <div className="topbar-right">
              <span className="demo-label">
                <span />
                Persistent demonstration
              </span>
              <button className="reset-button" disabled={busy} onClick={restart}>
                <RotateCcw size={15} />
                <span>Restart</span>
              </button>
            </div>
          )}
        </header>
        <main id="main" ref={main} className="main-content">
          {view !== 'connections' && (
            <div className="demo-toolbar">
              <span>
                <Sparkles size={15} />
                Try the same journey from every side.
              </span>
              <div className="role-switch" role="group" aria-label="Choose demonstration role">
                {roles.map((item) => (
                  <button
                    key={item}
                    disabled={busy}
                    aria-pressed={role === item}
                    onClick={() => {
                      setRole(item);
                      setView('overview');
                      setConfirmation(null);
                      setNotice('');
                    }}
                  >
                    {item[0].toUpperCase() + item.slice(1)}
                  </button>
                ))}
              </div>
              <label className="network-picker">
                <span className="sr-only">Demonstration network</span>
                <select
                  value={network}
                  disabled={busy}
                  onChange={(event) => {
                    setState(null);
                    setNetwork(event.target.value as Network);
                    setConfirmation(null);
                    setNotice('');
                  }}
                >
                  <option value="solana">Solana · USDC</option>
                  <option value="robinhood">Robinhood · USDG</option>
                </select>
              </label>
            </div>
          )}
          {notice && (
            <div
              className={`notice ${failed ? 'is-error' : ''}`}
              role={failed ? 'alert' : 'status'}
            >
              <CircleHelp size={18} />
              <span>{notice}</span>
              <button
                className="icon-button"
                aria-label="Dismiss message"
                onClick={() => setNotice('')}
              >
                <X size={17} />
              </button>
            </div>
          )}
          {!state && view !== 'connections' && (
            <section className="card loading-card">
              <Sprout size={28} />
              <h1>
                {failed ? 'Your workspace needs a connection.' : 'Preparing your next chapter…'}
              </h1>
              <p>
                {failed
                  ? 'The persistent store is unavailable. Open connection status to see what needs setup.'
                  : 'Loading your saved example tenancy.'}
              </p>
              {failed && (
                <button className="button primary" onClick={() => navigate('connections')}>
                  View connections <ArrowRight size={17} />
                </button>
              )}
            </section>
          )}
          {state && totals && (
            <>
              {totals.pending && (
                <div className="pending-banner">
                  <Clock3 size={20} />
                  <div>
                    <strong>A confirmed instruction is awaiting reconciliation.</strong>
                    <p>Your previous balances stay visible until its result is recorded.</p>
                  </div>
                  <button className="button primary" disabled={busy} onClick={reconcile}>
                    Check result <RefreshCw size={16} />
                  </button>
                </div>
              )}
              {view === 'overview' && (
                <>
                  <PageHeading
                    eyebrow="A PLACE TO LIVE. ROOM TO GROW."
                    title={
                      role === 'tenant'
                        ? 'Make room for your future.'
                        : role === 'landlord'
                          ? 'A clear picture of every obligation.'
                          : 'Give every account a fair hearing.'
                    }
                    text={
                      role === 'tenant'
                        ? 'Your deposit secures your home. Eligible earnings can help you build something of your own.'
                        : role === 'landlord'
                          ? 'Follow the deposit, share the records and agree an understandable settlement.'
                          : 'Review the shared evidence and record a decision within the claim’s limits.'
                    }
                  />
                  {role === 'tenant' ? (
                    <>
                      <div className="wealth-grid">
                        <section className="portfolio-hero">
                          <div className="section-heading">
                            <span className="card-label">
                              <Sprout size={18} />
                              YOUR PERSONAL PORTFOLIO
                            </span>
                            <Badge>Yours beyond this tenancy</Badge>
                          </div>
                          <div className="wealth-value">{money(totals.portfolioValue)}</div>
                          <p className="hero-caption">A beginning that can grow with you.</p>
                          <div className="wealth-breakdown">
                            <div>
                              <span>Personal cash</span>
                              <strong>{money(state.personal.cash)}</strong>
                            </div>
                            <div>
                              <span>Investment value</span>
                              <strong>{money(totals.investmentValue)}</strong>
                            </div>
                            <div>
                              <span>Released from deposit</span>
                              <strong>{money(state.security.released)}</strong>
                            </div>
                          </div>
                          <div className="hero-actions">
                            <button
                              className="button light"
                              disabled={busy || state.personal.cash === '0' || totals.pending}
                              onClick={() => plan('buy', state.personal.cash)}
                            >
                              Invest personal cash <ArrowUpRight size={17} />
                            </button>
                            <button
                              className="text-button light-text"
                              onClick={() => setShowProjection(!showProjection)}
                            >
                              Explore eight years <ArrowRight size={16} />
                            </button>
                          </div>
                          <div className="hero-proof">
                            Example cash and holding · no real investment or bank transfer
                          </div>
                        </section>
                        <section className="future-card">
                          <span className="eyebrow">YOUR NEXT CHAPTER</span>
                          <h2>
                            Today, a home.
                            <br />
                            Tomorrow, more possibilities.
                          </h2>
                          <p>
                            Each eligible contribution starts a personal holding. It stays yours
                            when the keys change hands.
                          </p>
                          <Neighborhood />
                          <span className="small-copy">
                            Optional savings can add to the same journey.
                          </span>
                        </section>
                      </div>
                      {showProjection && <Projection />}
                      <NextStep
                        state={state}
                        role={role}
                        busy={busy}
                        command={command}
                        plan={plan}
                        navigate={navigate}
                      />
                      <HoldingsShowcase state={state} />
                      <div className="two-panels">
                        <DepositSnapshot state={state} open={() => navigate('deposit')} />
                        <PortfolioActions
                          state={state}
                          busy={busy || totals.pending}
                          plan={plan}
                          command={command}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="metric-grid">
                        <Metric
                          label="Rental security held"
                          value={money(state.security.assets)}
                          detail={
                            state.stage === 'closed'
                              ? 'The settlement is complete.'
                              : 'Separate from the tenant’s personal portfolio.'
                          }
                          icon={<LockKeyhole size={19} />}
                        />
                        <Metric
                          label="Requested deduction"
                          value={money(state.claim.amount)}
                          detail={
                            state.claim.state === 'none'
                              ? 'No claim has been proposed.'
                              : state.claim.state === 'paid'
                                ? 'The approved allocation was paid.'
                                : 'A request is not a completed payment.'
                          }
                          icon={<Scale size={19} />}
                        />
                        <Metric
                          label={role === 'arbitrator' ? 'Assigned review' : 'Agreement status'}
                          value={
                            role === 'arbitrator'
                              ? state.claim.state === 'disputed'
                                ? 'Needs review'
                                : 'No open review'
                              : state.accepted.landlord
                                ? 'Accepted'
                                : 'Your turn'
                          }
                          detail={
                            role === 'arbitrator'
                              ? 'Authority is limited to this assigned case.'
                              : 'Both parties accept before funding.'
                          }
                          icon={<ShieldCheck size={19} />}
                        />
                      </div>
                      <NextStep
                        state={state}
                        role={role}
                        busy={busy}
                        command={command}
                        plan={plan}
                        navigate={navigate}
                      />
                      <div className="two-panels">
                        <section className="card">
                          <span className="eyebrow">THE SHARED TENANCY</span>
                          <h2>Cedar Court, Apartment 04</h2>
                          <p className="section-copy">
                            Maya and Alex share the same security balance, records and claim
                            history. Jordan can decide a disputed allocation.
                          </p>
                          <button className="button secondary" onClick={() => navigate('records')}>
                            Review shared records <FileText size={17} />
                          </button>
                        </section>
                        <section className="card pale">
                          <Sprout size={23} />
                          <h2>The tenant’s assets stay theirs.</h2>
                          <p className="section-copy">
                            You can review rental security and authorized settlement. Personal
                            investments are outside your spending and arbitration authority.
                          </p>
                          <button className="text-button" onClick={() => navigate('settlement')}>
                            Open settlement <ArrowRight size={17} />
                          </button>
                        </section>
                      </div>
                    </>
                  )}
                  <Journey state={state} />
                </>
              )}
              {view === 'deposit' && (
                <>
                  <PageHeading
                    eyebrow="SECURITY WITH CLEAR RULES"
                    title="Your rental deposit, explained."
                    text="See what is held, what has earned and what the agreement allows to leave the tenancy."
                  />
                  <div className="two-panels">
                    <DepositSnapshot state={state} />
                    <section className="card">
                      <span className="eyebrow">EARNINGS RELEASE POLICY</span>
                      <h2>Security first. Eligible earnings next.</h2>
                      <p className="section-copy">
                        The example agreement permits earnings release while the 3,000-unit security
                        requirement stays funded. A shortfall, disputed obligation or unavailable
                        redemption blocks a release.
                      </p>
                      <dl className="detail-list">
                        <div>
                          <dt>Earned in total</dt>
                          <dd>{money(state.security.earned)}</dd>
                        </div>
                        <div>
                          <dt>Currently releasable</dt>
                          <dd>{money(totals.releasable)}</dd>
                        </div>
                        <div>
                          <dt>Already released</dt>
                          <dd>{money(state.security.released)}</dd>
                        </div>
                        <div>
                          <dt>Redemption available</dt>
                          <dd>{money(state.security.liquid)}</dd>
                        </div>
                      </dl>
                      {role === 'tenant' && (
                        <button
                          className="button primary"
                          disabled={busy || totals.releasable === '0' || totals.pending}
                          onClick={() => plan('release', totals.releasable)}
                        >
                          Release eligible earnings <ArrowRight size={17} />
                        </button>
                      )}
                    </section>
                  </div>
                  <NextStep
                    state={state}
                    role={role}
                    busy={busy}
                    command={command}
                    plan={plan}
                    navigate={navigate}
                  />
                  <section className="card fixture-tools">
                    <div>
                      <span className="eyebrow">CONTROLLED TEST EVENTS</span>
                      <h2>Explore changing conditions.</h2>
                      <p>
                        These buttons change fictional accounting, never a live lending position.
                      </p>
                    </div>
                    <div className="button-row">
                      <button
                        className="button secondary"
                        disabled={
                          busy ||
                          totals.pending ||
                          !state.security.supplied ||
                          state.stage !== 'active'
                        }
                        onClick={() => command({ type: 'fixture_return', amount: '10000000' })}
                      >
                        Add $10 example earnings
                      </button>
                      <button
                        className="button secondary"
                        disabled={
                          busy ||
                          totals.pending ||
                          state.security.principal === '0' ||
                          state.stage === 'closed'
                        }
                        onClick={() =>
                          command({
                            type: 'fixture_liquidity',
                            available: state.security.liquid === '0',
                          })
                        }
                      >
                        {state.security.liquid === '0'
                          ? 'Restore example liquidity'
                          : 'Test unavailable redemption'}
                      </button>
                    </div>
                  </section>
                </>
              )}
              {view === 'settlement' && (
                <Settlement
                  state={state}
                  role={role}
                  busy={busy || totals.pending}
                  command={command}
                  plan={plan}
                />
              )}
              {view === 'records' && <Records state={state} busy={busy} command={command} />}
              {view === 'activity' && (
                <>
                  <PageHeading
                    eyebrow="EVERY STEP HAS A RECORD"
                    title="A history everyone can follow."
                    text="Prepared instructions, confirmations and completed effects remain distinct."
                  />
                  <div className="section-heading section-toolbar">
                    <Badge tone="neutral">Revision {state.revision}</Badge>
                    <button className="button secondary" onClick={download}>
                      <Download size={16} />
                      Download example ledger
                    </button>
                  </div>
                  <section className="card">
                    <ol className="event-list">
                      {state.activity.map((event) => (
                        <li key={event.id}>
                          <span className="event-icon">
                            <Check size={15} />
                          </span>
                          <div>
                            <strong>{event.title}</strong>
                            <p>{event.detail}</p>
                            <span>
                              {event.by} · {new Date(event.at).toLocaleString()}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                  <section className="card operation-section">
                    <h2>Operation evidence</h2>
                    {state.operations.length === 0 ? (
                      <p className="section-copy">
                        Financial operations appear here after a plan is prepared.
                      </p>
                    ) : (
                      state.operations.map((operation) => (
                        <details className="operation-detail" key={operation.id}>
                          <summary>
                            <span>{kindLabels[operation.kind]}</span>
                            <Badge tone={operation.state === 'completed' ? 'green' : 'neutral'}>
                              {operation.state.replaceAll('_', ' ')}
                            </Badge>
                          </summary>
                          <dl className="detail-list">
                            <div>
                              <dt>Operation</dt>
                              <dd className="mono">{operation.id}</dd>
                            </div>
                            <div>
                              <dt>Amount in atomic units</dt>
                              <dd>{operation.amount}</dd>
                            </div>
                            <div>
                              <dt>Evidence</dt>
                              <dd>{operation.proof?.detail || 'No completed receipt.'}</dd>
                            </div>
                            <div>
                              <dt>Reference</dt>
                              <dd className="mono">{operation.proof?.reference || 'Pending'}</dd>
                            </div>
                          </dl>
                        </details>
                      ))
                    )}
                  </section>
                </>
              )}
            </>
          )}
          {view === 'connections' &&
            (connections || (
              <section className="card">
                <h1>Loading connections…</h1>
              </section>
            ))}
          <footer className="content-footer">
            <span>
              <ShieldCheck size={15} />
              Fictional people, balances and investments. Changes persist for this browser.
            </span>
            <button onClick={() => navigate('connections')}>
              See integration evidence <ArrowUpRight size={15} />
            </button>
          </footer>
        </main>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {nav.slice(0, 4).map((item) => (
            <button
              key={item.id}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} />
              <span>
                {item.id === 'settlement'
                  ? 'Settlement'
                  : item.id === 'records'
                    ? 'Records'
                    : item.id === 'deposit'
                      ? 'Deposit'
                      : 'Overview'}
              </span>
            </button>
          ))}
          <button
            aria-current={view === 'connections' ? 'page' : undefined}
            aria-label="Account and connections"
            onClick={() => navigate('connections')}
          >
            <Link2 size={19} />
            <span>Account</span>
          </button>
        </nav>
      </div>
      <ConfirmOperation
        operation={confirmation}
        currency={networks[network].currency}
        busy={busy}
        close={() => setConfirmation(null)}
        confirm={async () => {
          if (confirmation) {
            await command({ type: 'authorize', operationId: confirmation.id });
            setConfirmation(null);
          }
        }}
      />
    </div>
  );
}
