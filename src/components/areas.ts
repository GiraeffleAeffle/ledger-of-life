import { Building2, Fingerprint, Home, LayoutDashboard, Lightbulb, Wallet, type LucideIcon } from 'lucide-react';
import { TEST_CITY_INVESTMENTS, type TestCityInvestmentId } from '@/data/local-investments';

/**
 * The signed-in areas of Ledger of Life (docs/LEDGER_OF_LIFE.md, section 3; placement rule in
 * docs/INFORMATION_ARCHITECTURE.md). Each area answers one question. A feature has exactly one home area,
 * where the person operates it; every other area may show a one-line reference that links there.
 */
export type Area = 'overview' | 'me' | 'home' | 'money' | 'places' | 'ideas';

export interface AreaDefinition {
  id: Area;
  label: string;
  icon: LucideIcon;
  /** The one question this area answers. */
  question: string;
  /** What may be operated here. Anything else is a reference that links to its home. */
  owns: string;
}

export const AREAS: AreaDefinition[] = [
  { id: 'overview', label: 'Today', icon: LayoutDashboard, question: 'Your identity, home, assets and place — connected in one ledger.',
    owns: 'A glance at every area and what needs you now. Links only; nothing is operated here.' },
  { id: 'me', label: 'Me', icon: Fingerprint, question: 'Who am I here, and what may others learn?',
    owns: 'Identity, passkeys, wallets, roles, timeline, and every connection you configure.' },
  { id: 'home', label: 'Home', icon: Home, question: 'Where do I live, and what is locked or owed there?',
    owns: 'The dwelling you rent or rent out: listings, agreement, deposit, service charges, move-out.' },
  { id: 'money', label: 'Money', icon: Wallet, question: 'What do I own, owe and earn?',
    owns: 'Every balance, position and income line: holdings, shares and loans, local stakes, devices that earn.' },
  { id: 'places', label: 'Places', icon: Building2, question: 'What is changing where I live, and where can I have a say?',
    owns: 'Public civic information: map, projects, city feed, evidence. No personal positions.' },
  { id: 'ideas', label: 'Ideas', icon: Lightbulb, question: 'What works, what comes next, and which adapter connects it?',
    owns: 'The status of every capability, built or planned. Nothing is operated here.' },
];

export const areaLabel = (area: Area) => AREAS.find((a) => a.id === area)!.label;

export const CIVIC_NAVIGATION_INTENT = 'ledger-of-life:civic-navigation-intent';
export type CivicNavigationIntent =
  | { kind: 'scenario' | 'map' }
  | { kind: 'investment'; cityId: string; projectId: TestCityInvestmentId }
  | { kind: 'event'; cityId: string; eventId: string }
  | { kind: 'project'; cityId: string; projectId: string; signalId?: string; lens: 'outcomes' | 'connections' }
  | { kind: 'signal'; cityId: string; signalId: string; lens: 'outcomes' | 'connections' };
/** One-use navigation intent; neither a financial action nor a saved city choice. */
export function openCivicScenario(go: (area: Area) => void) {
  sessionStorage.setItem(CIVIC_NAVIGATION_INTENT, JSON.stringify({ kind: 'scenario' } satisfies CivicNavigationIntent));
  window.dispatchEvent(new Event(CIVIC_NAVIGATION_INTENT));
  goToSection(go, 'places', 'selected-project');
}
export function openCivicProject(go: (area: Area) => void, cityId: string, projectId: string, signalId?: string) {
  sessionStorage.setItem(CIVIC_NAVIGATION_INTENT, JSON.stringify({ kind: 'project', cityId, projectId, signalId, lens: 'outcomes' } satisfies CivicNavigationIntent));
  window.dispatchEvent(new Event(CIVIC_NAVIGATION_INTENT));
  goToSection(go, 'places', 'selected-project');
}
export function openCivicSignal(go: (area: Area) => void, cityId: string, signalId: string) {
  sessionStorage.setItem(CIVIC_NAVIGATION_INTENT, JSON.stringify({ kind: 'signal', cityId, signalId, lens: 'outcomes' }));
  window.dispatchEvent(new Event(CIVIC_NAVIGATION_INTENT));
  goToSection(go, 'places', 'selected-project');
}
export function openCivicMap(go: (area: Area) => void) {
  sessionStorage.setItem(CIVIC_NAVIGATION_INTENT, JSON.stringify({ kind: 'map' } satisfies CivicNavigationIntent));
  window.dispatchEvent(new Event(CIVIC_NAVIGATION_INTENT));
  goToSection(go, 'places', 'personal-map');
}

export const LOCAL_INVESTMENT_NAVIGATION_INTENT = 'ledger-of-life:local-investment-navigation-intent';
export function openLocalInvestment(go: (area: Area) => void, projectId: TestCityInvestmentId) {
  sessionStorage.setItem(LOCAL_INVESTMENT_NAVIGATION_INTENT, projectId);
  window.dispatchEvent(new Event(LOCAL_INVESTMENT_NAVIGATION_INTENT));
  goToSection(go, 'money', 'local-investments');
}
export function openInvestmentOnMap(go: (area: Area) => void, projectId: TestCityInvestmentId) {
  const project = TEST_CITY_INVESTMENTS.find((item) => item.id === projectId);
  if (!project) return;
  sessionStorage.setItem(CIVIC_NAVIGATION_INTENT, JSON.stringify({
    kind: 'investment', cityId: project.cityId, projectId,
  } satisfies CivicNavigationIntent));
  window.dispatchEvent(new Event(CIVIC_NAVIGATION_INTENT));
  goToSection(go, 'places', 'personal-map');
}

export function openCityEvent(go: (area: Area) => void, cityId: string, eventId: string) {
  sessionStorage.setItem(CIVIC_NAVIGATION_INTENT, JSON.stringify({ kind: 'event', cityId, eventId } satisfies CivicNavigationIntent));
  window.dispatchEvent(new Event(CIVIC_NAVIGATION_INTENT));
  goToSection(go, 'places', 'selected-project');
}
export const LOCAL_AI_NAVIGATION_INTENT = 'ledger-of-life:local-ai-navigation-intent';
export function openLocalAi(go: (area: Area) => void, mode: 'paid' | 'library' = 'paid') {
  sessionStorage.setItem(LOCAL_AI_NAVIGATION_INTENT, mode);
  window.dispatchEvent(new Event(LOCAL_AI_NAVIGATION_INTENT));
  goToSection(go, 'money', 'local-ai');
}

export const ADAPTER_NAVIGATION_INTENT = 'ledger-of-life:adapter-navigation-intent';
export const IDEA_NAVIGATION_INTENT = 'ledger-of-life:idea-navigation-intent';
export function openLedgerAdapter(go: (area: Area) => void, adapterId: string) {
  sessionStorage.setItem(ADAPTER_NAVIGATION_INTENT, adapterId);
  window.dispatchEvent(new Event(ADAPTER_NAVIGATION_INTENT));
  goToSection(go, 'me', 'ledger-adapters');
}
export function openLedgerIdea(go: (area: Area) => void, ideaId: string) {
  sessionStorage.setItem(IDEA_NAVIGATION_INTENT, ideaId);
  window.dispatchEvent(new Event(IDEA_NAVIGATION_INTENT));
  goToSection(go, 'ideas', 'selected-capability');
}
export const SHARE_NAVIGATION_INTENT = 'ledger-of-life:share-navigation-intent';
export function openShareWorkflow(go: (area: Area) => void, choice: 'deposit' | 'borrow') {
  sessionStorage.setItem(SHARE_NAVIGATION_INTENT, choice);
  window.dispatchEvent(new Event(SHARE_NAVIGATION_INTENT));
  goToSection(go, 'money', 'share-workflows');
}

/**
 * Move between the existing six areas and focus the requested in-page destination after React mounts it.
 * A target inside a hidden section tab (`SectionTabs`) first selects that tab; a target inside a closed
 * `<details>` opens it.
 */
export function goToSection(go: (area: Area) => void, area: Area, id: string) {
  go(area);
  const root = document.getElementById('main') ?? document.body;
  const observer = new MutationObserver(focus);
  function focus() {
    const target = document.getElementById(id);
    if (!target) return;
    const hiddenPanel = target.closest<HTMLElement>('[data-section-panel][hidden]');
    if (hiddenPanel) {
      // The tab switch re-renders the panel; the observer runs focus() again once `hidden` is removed.
      document.querySelector<HTMLElement>(`[data-section-tab="${hiddenPanel.dataset.sectionPanel}"]`)?.click();
      return;
    }
    observer.disconnect();
    clearTimeout(timeout);
    for (let parent = target.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    target.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    target.focus({ preventScroll: true });
  }
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  const timeout = window.setTimeout(() => observer.disconnect(), 15_000);
  requestAnimationFrame(focus);
}
