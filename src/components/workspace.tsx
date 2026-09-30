'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import { AREAS, areaLabel, type Area } from './areas';
import { MyHome } from './home';
import { DemoContext } from './demo-context';
import { useRentalWallet } from '@/wallets';
import { AreaErrorBoundary } from './area-error-boundary';
import { areaFromSearch, withArea } from './workspace-location';

export function Workspace() {
  const [area, setArea] = useState<Area>('overview');
  const [announcement, setAnnouncement] = useState('');
  const wallet = useRentalWallet();
  const areaRef = useRef(area);
  const readyRef = useRef(false);
  useEffect(() => {
    const fromUrl = () => setArea(areaFromSearch(window.location.search));
    fromUrl();
    readyRef.current = true;
    window.addEventListener('popstate', fromUrl);
    return () => window.removeEventListener('popstate', fromUrl);
  }, []);
  useEffect(() => {
    document.title = `${areaLabel(area)} · Ledger of Life`;
    if (areaRef.current !== area) {
      areaRef.current = area;
      setAnnouncement(`${areaLabel(area)} area`);
      requestAnimationFrame(() => {
        const heading = document.querySelector<HTMLElement>('#main .page-heading h1, #main .area-error h1, #main h1');
        if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      });
    }
  }, [area]);
  function openArea(next: Area) {
    if (next === area) return;
    if (readyRef.current) window.history.pushState(null, '', withArea(window.location.href, next));
    setArea(next);
    document.getElementById('main')?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }

  return (
    <div className="app-shell wealth-app">
      <a className="skip-link" href="#main">Skip to workspace</a>
      <aside className="sidebar">
        <button className="brand" onClick={() => openArea('overview')}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span>Ledger<br /><strong>of Life</strong></span>
        </button>
        <nav aria-label="Your account">
          {AREAS.map((item) => (
            <button key={item.id} className={`nav-item ${area === item.id ? 'selected' : ''}`}
              aria-current={area === item.id ? 'page' : undefined} onClick={() => openArea(item.id)}>
              <item.icon size={18} />{item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-foot">Everything that is yours,<span>in one place.</span></div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb"><ShieldCheck size={16} /><span>Account</span><ChevronRight size={14} /><strong>{areaLabel(area)}</strong></div>
          <div className="topbar-actions">
            {wallet.ready && wallet.authenticated && <><span className="account-label" title={wallet.backupEmail ?? undefined}>{wallet.backupEmail || `Account ${wallet.subject?.slice(-8) ?? ''}`}</span>
              <button className="topbar-signout" onClick={() => void wallet.logout()}>Sign out</button></>}
            <DemoContext />
          </div>
        </header>
        <main id="main" className="main-content">
          <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
          <AreaErrorBoundary key={area} area={area} goToday={() => openArea('overview')}><MyHome area={area} go={openArea} /></AreaErrorBoundary>
        </main>
        <nav className="mobile-nav" aria-label="Account navigation">
          {AREAS.map((item) => (
            <button key={item.id} aria-current={area === item.id ? 'page' : undefined} onClick={() => openArea(item.id)}>
              <item.icon size={19} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
