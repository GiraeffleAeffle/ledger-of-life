import { Building2, Fingerprint, Home, LayoutDashboard, Lightbulb, Wallet, type LucideIcon } from 'lucide-react';

/** The signed-in areas of Ledger of Life (docs/LEDGER_OF_LIFE.md, section 3). */
export type Area = 'overview' | 'me' | 'home' | 'money' | 'places' | 'ideas';

export const AREAS: { id: Area; label: string; icon: LucideIcon; question: string }[] = [
  { id: 'overview', label: 'Today', icon: LayoutDashboard, question: 'What is happening in my city, and what needs me?' },
  { id: 'me', label: 'Me', icon: Fingerprint, question: 'Who am I here, and what may others learn?' },
  { id: 'home', label: 'Home', icon: Home, question: 'Where do I live, and what is locked or owed there?' },
  { id: 'money', label: 'Money', icon: Wallet, question: 'What do I own and earn?' },
  { id: 'places', label: 'Places', icon: Building2, question: 'What is changing where I live, and where can I have a say?' },
  { id: 'ideas', label: 'Ideas', icon: Lightbulb, question: 'What is planned, how would it work, and what would it enable?' },
];

export const areaLabel = (area: Area) => AREAS.find((a) => a.id === area)!.label;
