/**
 * The app's one thread, in the same words everywhere: the door, Today, the area headings, Home,
 * the next step and the Roadmap. The owner's destination line with the deposit named as the hinge.
 * No runtime imports, like sections.ts.
 */
export const THREAD = 'Find a home, secure the deposit, keep your assets, help build your city.';

export type StageId = 'home' | 'deposit' | 'assets' | 'city';
export type Stage = { id: StageId; number: 1 | 2 | 3 | 4; name: string; promise: string };

export const STAGES: readonly Stage[] = [
  { id: 'home', number: 1, name: 'Find a home', promise: 'Apply to a listed home, or rent out your own.' },
  { id: 'deposit', number: 2, name: 'Secure the deposit', promise: 'Agree the terms with a neutral arbitrator, lock a test-USDC deposit, get it back at move-out.' },
  { id: 'assets', number: 3, name: 'Keep your assets', promise: 'See what you hold, what is locked and what you owe; borrow test dollars against test shares instead of selling them.' },
  { id: 'city', number: 4, name: 'Help build your city', promise: 'See what your city is deciding, follow a project, take a fictional local stake, ask the city AI desk.' },
];
