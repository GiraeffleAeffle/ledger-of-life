import type { CivicAiSource } from './civic-ai.ts';

/** Native Ledger opinion polls: accounts are not verified residents. No ballot identity is public. */
export type CivicPhase = 'discussion' | 'ready' | 'open' | 'closed';
export type CivicStance = 'discussion' | 'pro' | 'con';
export interface CivicContribution {
  id: string; parentId: string | null; stance: CivicStance; text: string; createdAt: string;
  /** Only the signed-in author of a tagged human contribution can request a public sourced reply. */
  canRequestAi?: boolean;
  ai?: {
    authority: 'none'; provider: 'ledger-library'; jobId: string; model: string;
    sources: CivicAiSource[]; generatedAt: string;
  };
}
/** SHA-256 of the canonical public content/argument snapshot and counts/total/closedAt.
 * Excludes account identifiers, viewer fields, versions and mutable linked-city scopes.
 * This is a reproducible integrity digest, not a signature, onchain anchor or anonymity proof.
 */
export interface CivicResult {
  counts: number[]; total: number; closedAt: string; hash: string;
}
export interface CivicTopic {
  id: string; cityId: string; linkedCityIds: string[]; title: string; context: string;
  question: string; options: string[]; sourceUrl: string | null;
  /** Content/lifecycle revision. Voting and city linking do not change the reviewed ballot revision. */
  phase: CivicPhase; version: number; createdAt: string; updatedAt: string;
  openedAt: string | null; contributions: CivicContribution[];
  result: CivicResult | null; canManage: boolean; ownVote: number | null; voteCount: number;
  /** Viewer-owned @city-ai / @Mecky context, while discussion remains mutable. */
  canRequestAi?: boolean;
}
/** A bounded scan can yield an empty city-filtered page with a non-null continuation cursor. */
export interface CivicTopicList { topics: CivicTopic[]; nextCursor: string | null; }
export type CivicAction =
  | { action: 'create'; cityId: string; title: string; context: string; question: string; options: string[]; sourceUrl?: string; operationId: string }
  | { action: 'contribute'; topicId: string; version: number; stance: CivicStance; text: string; parentId: string | null; operationId: string }
  | { action: 'ready' | 'open' | 'close'; topicId: string; version: number; operationId: string }
  | { action: 'vote'; topicId: string; version: number; choice: number; operationId: string }
  | { action: 'link-city'; topicId: string; version: number; cityId: string; operationId: string };
export const CIVIC_ELIGIBILITY = 'Opinion poll by Ledger test accounts, not verified residents or an official vote. One choice per account is not one person, one vote.';
export const CIVIC_LIMITS = {
  title: 160, context: 6000, question: 500, option: 160, contribution: 2000,
  options: 5, contributions: 120, contributionsPerAccount: 20, depth: 4,
  votes: 1000, linkedCities: 8, topicsPerAccount: 30, topicsPerDay: 3,
  pageSize: 12, bodyBytes: 16_384,
} as const;
