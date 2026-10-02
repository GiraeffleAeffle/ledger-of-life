'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import { AREAS, areaLabel, type Area } from './areas';
import { MyHome } from './home';
import { DemoContext } from './demo-context';
import { useRentalWallet } from '@/wallets';
import { AreaErrorBoundary } from './area-error-boundary';
import { areaFromSearch, withArea } from './workspace-location';
import { InitialTabContext } from './section-tabs';
import { BrandEndorsement } from './brand-endorsement';
import './workspace.css';

const PRIMARY = AREAS.filter((item) => !item.secondary);

export function Workspace({ initialArea = 'overview', initialTab, sessionHint = false }: { initialArea?: Area; initialTab?: string; sessionHint?: boolean }) {
  const params = useSearchParams();
  const area = params ? areaFromSearch(params.toString()) : initialArea;
  const [announcement, setAnnouncement] = useState('');
  const wallet = useRentalWallet();
  const areaRef = useRef(area);
  useEffect(() => {
    document.title = `${areaLabel(area)} · Ledger of Life`;
    if (areaRef.current !== area) {
      areaRef.current = area;
      setAnnouncement(`${areaLabel(area)} area`);
      requestAnimationFrame(() => {
        // Section jumps already put focus on the destination in this commit.
        if (document.getElementById('main')?.contains(document.activeElement)) return;
        const heading = document.querySelector<HTMLElement>('#main .page-heading h1, #main .area-error h1, #main h1');
        if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      });
    }
  }, [area]);
  function openArea(next: Area) {
    if (next === area) return;
    window.history.pushState(null, '', withArea(window.location.href, next));
    document.getElementById('main')?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }

  const signedOut = wallet.ready && !wallet.authenticated;
  const showAccount = wallet.ready ? wallet.authenticated : sessionHint;
  return (
    <div className="app-shell wealth-app">
      <a className="skip-link" href="#main">Skip to workspace</a>
      <aside className="sidebar">
        <button className="brand" onClick={() => openArea('overview')}>
          <svg className="brand-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 44" aria-hidden="true">
            <path d="M5 31 20 39 35 31 20 23Z" fill="#76a753"/>
            <path d="M5 24 20 32 35 24 20 16Z" fill="#39a7b9"/>
            <path d="M5 17 20 25 35 17 20 9Z" fill="#e9ac43"/>
            <path d="M5 10 20 18 35 10 20 2Z" fill="#e97661"/>
            <path d="M5 10V31L20 39" fill="none" stroke="#15263b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M14 10 22 14" fill="none" stroke="#15263b" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <span className="ledger-wordmark">Ledger<br /><strong>of Life</strong></span>
        </button>
        <BrandEndorsement />
        {!signedOut && <nav aria-label="Your account">
          {!wallet.ready && !sessionHint ? <div className="skeleton-block nav-skeleton" aria-hidden="true" /> : showAccount && PRIMARY.map((item) => (
            <button key={item.id} className={`nav-item ${area === item.id ? 'selected' : ''}`}
              aria-current={area === item.id ? 'page' : undefined} onClick={() => openArea(item.id)}>
              <item.icon size={18} />{item.label}
            </button>
          ))}
        </nav>}
        <div className="sidebar-bottom">
          {showAccount && <button type="button" className={`text-button sidebar-roadmap ${area === 'ideas' ? 'selected' : ''}`}
            aria-current={area === 'ideas' ? 'page' : undefined} onClick={() => openArea('ideas')}>Roadmap: what is built, what is next</button>}
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          {!signedOut && showAccount && <div className="breadcrumb"><ShieldCheck size={16} /><span>Account</span><ChevronRight size={14} /><strong>{areaLabel(area)}</strong></div>}
          <div className="topbar-actions">
            {wallet.ready && wallet.authenticated && <><span className="account-label">{`Account ${wallet.subject?.slice(-8) ?? ''}`}</span>
              <button className="topbar-signout" onClick={() => void wallet.logout()}>Sign out</button></>}
            <DemoContext />
          </div>
        </header>
        <main id="main" className="main-content">
          <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
          <AreaErrorBoundary area={area} goToday={() => openArea('overview')}><InitialTabContext.Provider value={initialTab}><MyHome area={area} go={openArea} sessionHint={sessionHint} /></InitialTabContext.Provider></AreaErrorBoundary>
        </main>
        {!signedOut && <nav className="mobile-nav" aria-label="Account navigation">
          {!wallet.ready && !sessionHint ? <div className="skeleton-block nav-skeleton" aria-hidden="true" /> : showAccount && PRIMARY.map((item) => (
            <button key={item.id} aria-current={area === item.id ? 'page' : undefined} onClick={() => openArea(item.id)}>
              <item.icon size={19} /><span>{item.label}</span>
            </button>
          ))}
        </nav>}
      </div>
    </div>
  );
}
