'use client';
import { createContext, useContext, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { tabFromSearch, withTab } from './workspace-location';
import './section-tabs.css';

export interface SectionTab {
  /** Also the panel's element id, so it is a jump target (see `SECTIONS` in data/sections.ts). */
  id: string;
  label: string;
  content: ReactNode;
}

const ActiveTabContext = createContext(true);
export const InitialTabContext = createContext<string | undefined>(undefined);
export function useSectionTabActive() { return useContext(ActiveTabContext); }

/**
 * The sections of one area, one at a time. Every panel stays mounted and is only hidden, so a
 * half-finished workflow keeps its state when the person looks at another section, and
 * `goToSection` can find a target in any panel and select the tab that contains it.
 */
export function SectionTabs({ label, tabs, initialTab }: { label: string; tabs: SectionTab[]; initialTab?: string }) {
  const params = useSearchParams();
  const serverTab = useContext(InitialTabContext);
  const active = tabFromSearch(params?.toString() ?? new URLSearchParams({ tab: initialTab ?? serverTab ?? '' }).toString(), tabs.map((tab) => tab.id));
  function select(id: string) {
    if (active === id) return;
    window.history.pushState(null, '', withTab(window.location.href, id));
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : direction ? (index + direction + tabs.length) % tabs.length : -1;
    if (next < 0) return;
    event.preventDefault();
    select(tabs[next].id);
    document.getElementById(`${tabs[next].id}-tab`)?.focus();
  }
  return (
    <div className="section-tabs">
      <nav className="section-tabs-nav" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button key={tab.id} id={`${tab.id}-tab`} type="button" role="tab" data-section-tab={tab.id} aria-controls={tab.id}
            aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1}
            onKeyDown={(event) => moveTab(event, index)} onClick={() => select(tab.id)}>{tab.label}</button>
        ))}
      </nav>
      {tabs.map((tab) => (
        <section key={tab.id} id={tab.id} role="tabpanel" aria-labelledby={`${tab.id}-tab`} className="section-panel" data-section-panel={tab.id} tabIndex={-1}
          hidden={active !== tab.id}>
          <ActiveTabContext.Provider value={active === tab.id}>
            {tab.content}
          </ActiveTabContext.Provider>
        </section>
      ))}
    </div>
  );
}
