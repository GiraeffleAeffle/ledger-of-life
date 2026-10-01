import type { Area } from './areas';

/** Where a next step leads: an area, and optionally the section to open and focus there. */
export type NextStepTarget = { area: Area; section?: string };
export type NextStepLink = { label: string; target: NextStepTarget };
export type NextStep = {
  title: string;
  detail?: string;
  /** The one thing to do now. Absent while the app is still checking. */
  action?: NextStepLink;
  /** Equal alternatives when nothing waits for this person. */
  choices?: NextStepLink[];
  /** Something waits for this person: shown in full on every area, not only on Today and Home. */
  urgent?: boolean;
};

type Tenancy = {
  agreementId: string;
  property: string;
  stage: string;
  next: { kind: string; label: string; detail: string };
};
type Listing = {
  id: string;
  title: string;
  relation: 'landlord' | 'applicant' | 'chosen' | null;
  status: string;
  applications?: readonly unknown[];
  agreementId: string | null;
};
export type NextStepFacts = {
  /** Still reading homes and listings for the first time. */
  loading: boolean;
  /** An invitation link was opened in this browser. */
  invitation: boolean;
  homeError: string;
  tenancies: readonly Tenancy[];
  /** Tenancies whose reading failed. */
  unavailable: number;
  listings: readonly Listing[];
};

const START: NextStepLink[] = [
  { label: 'Choose your city', target: { area: 'places', section: 'city-choice' } },
  { label: 'Get test money', target: { area: 'money', section: 'test-money' } },
];
const tenancy = (t: Tenancy): NextStepTarget => ({ area: 'home', section: `tenancy-${t.agreementId}` });

/** Steps that wait for this person, in their own words. */
const YOUR_TURN: Record<string, (property: string) => { title: string; label: string }> = {
  invite_arbitrator: (p) => ({ title: `Invite a neutral arbitrator for ${p}.`, label: 'Open invitation step' }),
  accept_agreement: (p) => ({ title: `Review the deposit terms for ${p}.`, label: 'Review agreement' }),
  create_space: (p) => ({ title: `Your landlord step: prepare the empty deposit escrow for ${p}.`, label: 'Review escrow step' }),
  secure_deposit: (p) => ({ title: `Your tenant step: secure the test deposit for ${p}.`, label: 'Review deposit' }),
  respond_claim: (p) => ({ title: `Review the landlord’s proposed deduction for ${p}.`, label: 'Review deduction' }),
  decide_claim: (p) => ({ title: `Your arbitrator step: decide the disputed deduction for ${p}.`, label: 'Review dispute' }),
  settle: (p) => ({ title: `The deduction is decided. Complete the test settlement for ${p}.`, label: 'Review settlement' }),
};
const SOMEONE_ELSE = new Set(['wait', 'confirming', 'paying_out']);

/**
 * The one "what now" for a signed-in person, from facts the app already holds.
 * Precedence: an opened invitation, home steps that wait for this person, applicants to review,
 * steps waiting on someone else or the network, applications in progress, read failures,
 * a secured or finished home, and only then the open choice of where to start.
 * Unknown stays unknown: while reading, or after a failed read, nothing is offered as done or empty.
 */
export function nextStep(facts: NextStepFacts): NextStep {
  if (facts.loading) return { title: 'Checking your homes and applications…' };
  if (facts.invitation) return {
    title: 'You have an invitation to a home.',
    detail: 'See the home, your role and the test deposit before you accept.',
    action: { label: 'Review invitation', target: { area: 'home' } },
    urgent: true,
  };
  for (const t of facts.tenancies) {
    const step = YOUR_TURN[t.next.kind]?.(t.property);
    if (step) return { title: step.title, action: { label: step.label, target: tenancy(t) }, urgent: true };
  }
  const review = facts.listings.find((l) => l.relation === 'landlord' && l.status === 'open' && (l.applications?.length ?? 0) > 0);
  if (review) {
    const count = review.applications!.length;
    return {
      title: `${count} application${count === 1 ? '' : 's'} for ${review.title} ${count === 1 ? 'needs' : 'need'} your review.`,
      action: { label: 'Review applicants', target: { area: 'home', section: `listing-${review.id}` } },
      urgent: true,
    };
  }
  // While living, "wait" means nothing is pending; that quiet state must not outrank an application in progress.
  const waiting = facts.tenancies.find((t) => SOMEONE_ELSE.has(t.next.kind) && !(t.next.kind === 'wait' && t.stage === 'living'));
  if (waiting) return {
    title: `${waiting.property}: ${waiting.next.label}.`,
    detail: waiting.next.detail,
    action: { label: 'View home status', target: tenancy(waiting) },
  };
  const hasTenancy = (l: Listing) => facts.tenancies.some((t) => t.agreementId === l.agreementId);
  const chosen = facts.listings.find((l) => l.relation === 'chosen' && l.status !== 'closed' && !hasTenancy(l));
  if (chosen) return {
    title: `The landlord chose you for ${chosen.title}.`,
    detail: 'Your deposit agreement is being prepared.',
    action: { label: 'View status', target: { area: 'home', section: `listing-${chosen.id}` } },
  };
  const applied = facts.listings.find((l) => l.relation === 'applicant' && l.status === 'open');
  if (applied) return {
    title: `Your application for ${applied.title} is with the landlord.`,
    detail: 'The app sends no notification: tell the landlord yourself.',
    action: { label: 'View application', target: { area: 'home', section: `listing-${applied.id}` } },
  };
  if (facts.homeError || facts.unavailable > 0) return {
    title: 'We could not check all of your homes.',
    detail: 'Your progress has not been reset. Home shows what failed and lets you try again.',
    action: { label: 'Open Home', target: { area: 'home' } },
  };
  const living = facts.tenancies.find((t) => t.next.kind !== 'done' && t.next.kind !== 'cancelled');
  if (living) return {
    title: `The test deposit for ${living.property} is secured. Nothing needs you now.`,
    action: { label: 'View home status', target: tenancy(living) },
    choices: START,
  };
  const finished = facts.tenancies.find((t) => t.next.kind === 'done');
  if (finished) return {
    title: `${finished.property} is paid out. Your records stay in Home.`,
    action: { label: 'View payout summary', target: tenancy(finished) },
    choices: [{ label: 'Find another home', target: { area: 'home', section: 'home-options' } }, ...START],
  };
  return {
    title: 'Your account is ready. Start with a home.',
    detail: 'Most people start here: find a home, agree the terms, then secure the deposit.',
    action: { label: 'Find a home', target: { area: 'home', section: 'home-options' } },
    choices: START,
  };
}
