'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BookOpen, ChevronRight, Cpu, ShieldCheck } from 'lucide-react';
import { AREAS, areaLabel, type Area } from './areas';
import { MyHome } from './home';
import { DemoContext } from './demo-context';
import { useRentalWallet } from '@/wallets';
import { AreaErrorBoundary } from './area-error-boundary';
import { areaFromSearch, withArea } from './workspace-location';
import { THREAD } from '@/data/path';
import { BrandEndorsement } from './brand-endorsement';
import './workspace.css';

const PRIMARY = AREAS.filter((item) => !item.secondary);
/** What works without an account; the six areas all need one. */
const PUBLIC_LINKS = [
  { href: '/welcome/strausberg', label: 'Welcome guide', icon: BookOpen },
  { href: '/library', label: 'Public AI desk', icon: Cpu },
] as const;

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

  // Signed-out visitors get the no-account paths instead of six destinations that all end at sign-in.
  // While sign-in is still unknown the usual navigation stays, so signed-in people never see it flicker.
  const signedOut = wallet.ready && !wallet.authenticated;
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
        <nav aria-label={signedOut ? 'Without an account' : 'Your account'}>
          {signedOut ? PUBLIC_LINKS.map((item) => (
            <Link key={item.href} className="nav-item" href={item.href}><item.icon size={18} />{item.label}</Link>
          )) : PRIMARY.map((item) => (
            <button key={item.id} className={`nav-item ${area === item.id ? 'selected' : ''}`}
              aria-current={area === item.id ? 'page' : undefined} onClick={() => openArea(item.id)}>
              <item.icon size={18} />{item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-foot">{THREAD}</div>
          {!signedOut && <button type="button" className={`text-button sidebar-roadmap ${area === 'ideas' ? 'selected' : ''}`}
            aria-current={area === 'ideas' ? 'page' : undefined} onClick={() => openArea('ideas')}>Roadmap: what is built, what is next</button>}
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
        <nav className="mobile-nav" aria-label={signedOut ? 'Without an account' : 'Account navigation'}>
          {signedOut ? PUBLIC_LINKS.map((item) => (
            <Link key={item.href} href={item.href}><item.icon size={19} /><span>{item.label}</span></Link>
          )) : PRIMARY.map((item) => (
            <button key={item.id} aria-current={area === item.id ? 'page' : undefined} onClick={() => openArea(item.id)}>
              <item.icon size={19} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
