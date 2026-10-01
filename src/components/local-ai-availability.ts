import { coveredNames } from './city-coverage.ts';
import type { ConnectorHostStatus, LocalAiMode } from '../server/local-ai-types.ts';

/** The server's total job lifetime (wake, readiness, preload, generation) is 240 s. */
export const WAKE_WAIT_MINUTES = 4;

export interface DeskAvailability {
  /** False only when no host could take the question; `reason` then says what a visitor can do. */
  canAsk: boolean;
  reason: string;
  /** Shown while asking is still possible but slower than usual. */
  notice: string;
}
interface DeskService {
  mode?: 'direct' | 'connector'; reachable: boolean; model: string; hosts?: ConnectorHostStatus[];
}

const usable = (host: ConnectorHostStatus) => host.availability === 'online' || (host.availability === 'asleep' && host.canWake === true);

/**
 * What a visitor can do with the desk right now. Only the city-host pool is judged here (free answers, or
 * paid answers allowed on city hosts); "only my own hosts" keeps its own message in the workspace.
 */
export function deskAvailability(service: DeskService | null, mode: LocalAiMode, hostScope: 'own' | 'city'): DeskAvailability {
  const open: DeskAvailability = { canAsk: true, reason: '', notice: '' };
  if (!service) return { canAsk: false, reason: 'Checking which hosts are available…', notice: '' };
  if (service.mode === 'direct') {
    return service.reachable ? open : { canAsk: false, reason: 'The local model is not reachable right now. Try again in a few minutes.', notice: '' };
  }
  if (hostScope === 'own') return open;
  const hosts = (service.hosts ?? []).filter((host) => host.state === 'active' && host.models.includes(service.model));
  if (!hosts.length) return { canAsk: false, reason: 'No city host is connected right now, so there is nothing to answer a question. Try again later.', notice: '' };
  const pool = mode === 'library' ? hosts.filter((host) => host.freePublicAnswers === true) : hosts;
  if (!pool.length) return { canAsk: false, reason: 'No host offers free answers right now. Paid answers use the same hosts and need a signed-in wallet with test tUSDG.', notice: '' };
  const ready = pool.filter(usable);
  if (!ready.length) {
    const asleep = pool.some((host) => host.availability === 'asleep');
    return { canAsk: false, notice: '', reason: asleep
      ? 'The city hosts are asleep and cannot be woken from here. They answer again once their owner switches the machine on.'
      : 'The city hosts are offline: none has reported in during the last minute. Try again later.' };
  }
  if (ready.every((host) => host.availability === 'asleep')) {
    return { canAsk: true, reason: '', notice: `The city hosts are asleep; a question wakes one, which can take up to ${WAKE_WAIT_MINUTES} minutes.` };
  }
  return open;
}

const UTC_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
/** "Last successful answer: 1 Oct 2026, 14:03 UTC", or a plain statement that none exists. */
export function lastAnswerText(lastSuccessAt: string | null | undefined): string {
  const time = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
  return Number.isFinite(time) ? `Last successful answer: ${UTC_TIME.format(time)} UTC.` : 'No answer has been completed yet.';
}

/** `?city=<id>` from the Home neighbourhood step; only ids of covered cities are accepted. */
export function libraryCityFromParam(value: string | string[] | null | undefined): string | null {
  return typeof value === 'string' && Object.hasOwn(coveredNames, value) ? value : null;
}
export function cityQuestionStart(cityId: string): string {
  return `Public information for ${coveredNames[cityId]}: `;
}
