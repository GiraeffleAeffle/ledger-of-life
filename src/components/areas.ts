import { Building2, Fingerprint, Home, LayoutDashboard, Lightbulb, Wallet, type LucideIcon } from 'lucide-react';
import { TEST_CITY_INVESTMENTS, type TestCityInvestmentId } from '@/data/local-investments';
import { STAGES, type StageId } from '@/data/path';

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
  /** Where this area sits on the thread (src/data/path.ts), shown above its heading. */
  eyebrow: string;
  /** The one question this area answers. */
  question: string;
  /** What may be operated here. Anything else is a reference that links to its home. */
  owns: string;
  /** Reached from the sidebar foot, Today and the explainer, not from the main navigation. */
  secondary?: boolean;
}

/** "STAGE 3 OF 4 · KEEP YOUR ASSETS": the path's own words, so every heading says where it sits. */
function stageLine(ids: StageId[]) {
  const stages = STAGES.filter((stage) => ids.includes(stage.id));
  const numbers = stages.length === 1 ? `STAGE ${stages[0].number}` : `STAGES ${stages[0].number}–${stages.at(-1)!.number}`;
  return `${numbers} OF ${STAGES.length} · ${stages.map((stage) => stage.name.toUpperCase()).join(', ')}`;
}

/** The main navigation follows the path: Today, Home, Money, Places, then Me (the toolbox for every stage). */
export const AREAS: AreaDefinition[] = [
  { id: 'overview', label: 'Today', icon: LayoutDashboard, eyebrow: 'YOUR PATH', question: 'Your next step, and where you are on the path.',
    owns: 'A glance at every area and what needs you now. Links only; nothing is operated here.' },
  { id: 'home', label: 'Home', icon: Home, eyebrow: stageLine(['home', 'deposit']), question: 'Find a home, agree the deposit, and see what is owed.',
    owns: 'The dwelling you rent or rent out: listings, agreement, deposit, service charges, move-out.' },
  { id: 'money', label: 'Money', icon: Wallet, eyebrow: stageLine(['assets', 'city']), question: 'Your test holdings, collateral, loans and recorded activity.',
    owns: 'Every balance, position and income line: holdings, shares and loans, local stakes, devices that earn.' },
  { id: 'places', label: 'Places', icon: Building2, eyebrow: stageLine(['city']), question: "Get settled, see what's changing, and find the published ways to take part.",
    owns: 'Public civic information: map, projects, city feed, evidence. No personal positions.' },
  { id: 'me', label: 'Me', icon: Fingerprint, eyebrow: 'FOR EVERY STAGE', question: 'Your access, private history and connections.',
    owns: 'Identity, passkeys, wallets, roles, timeline, and every connection you configure.' },
  { id: 'ideas', label: 'Roadmap', icon: Lightbulb, eyebrow: 'WHAT IS BUILT, WHAT IS NEXT', question: 'What is built, what is a prototype, and what is planned?',
    owns: 'The status of every capability, built or planned. Nothing is operated here.', secondary: true },
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
export function openShareWorkflow(go: (area: Area) => void, choice: 'borrow' | 'lend') {
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
