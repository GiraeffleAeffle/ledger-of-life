import { interestOptions, type Interest } from '../interests.ts';

/**
 * A city's welcome guide: what a newcomer needs in the first months, with the source of every claim.
 * It is curated public information, not an official city service and not personal data. Personal choices
 * (situation, interests) are applied on the reader's device and never leave it.
 */
export const ARRIVAL_SITUATIONS = ['within-germany', 'from-abroad', 'with-children', 'working-or-studying', 'retired'] as const;
/** The same interests as Places: one vocabulary, one on-device store. */
export const ARRIVAL_INTERESTS = interestOptions;
export const ARRIVAL_PHASES = ['first-two-weeks', 'first-month', 'months-two-and-three', 'months-four-to-six'] as const;

export type ArrivalSituation = (typeof ARRIVAL_SITUATIONS)[number];
export type ArrivalInterest = Interest;
export type ArrivalPhase = (typeof ARRIVAL_PHASES)[number];

/** Where a claim was read, and when. `checkedOn` is an ISO date (YYYY-MM-DD). */
export interface ArrivalSource {
  label: string;
  url: string;
  checkedOn: string;
}

export interface ArrivalStep {
  id: string;
  phase: ArrivalPhase;
  title: string;
  /** One or two plain sentences: why a newcomer should care. */
  why: string;
  /** What to do, concretely: what to bring, where to go or apply. German terms in brackets, for example "registration (Anmeldung)". */
  whatToDo: string;
  /** Situations this step matters most for. Absent means everyone. A step is never hidden by a situation, only highlighted. */
  situations?: readonly ArrivalSituation[];
  interests?: readonly ArrivalInterest[];
  /** The page that supports the claim. Prefer the city, district or state itself. */
  source: ArrivalSource;
  /** True only when the source is the city, district, state or federal government or a body it owns. */
  official: boolean;
  /** Anything the reader should double-check, or a limit of what was verified. */
  caveat?: string;
}

/** An organisation to ask. Organisation-level details only: never a private person's phone number or email. */
export interface ArrivalContact {
  id: string;
  name: string;
  role: string;
  url: string;
  address?: string;
  hours?: string;
  source: ArrivalSource;
}

export interface ArrivalGroup {
  id: string;
  name: string;
  kind: 'club' | 'facility' | 'service' | 'initiative';
  interests: readonly ArrivalInterest[];
  /** Plain English, one or two sentences. */
  summary: string;
  url?: string;
  address?: string;
  /** How a newcomer can try it before committing, when the source says so. */
  tryFirst?: string;
  source: ArrivalSource;
}

export interface ArrivalGuide {
  cityId: string;
  cityName: string;
  /** ISO date the guide was last assembled. */
  preparedOn: string;
  contacts: readonly ArrivalContact[];
  steps: readonly ArrivalStep[];
  groups: readonly ArrivalGroup[];
}
