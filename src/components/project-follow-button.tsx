'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import type { FollowEntry, FollowTarget, ProjectSnapshot } from './project-following';
import { readCurrentProjectSnapshot } from './use-project-following';
import type { AuthorizedRequest } from './use-city-signals';

/** Shortlist actions share the Places following store, without mounting a refreshing hook per card. */
export function ProjectFollowButton({ request, target, title, cityName, entry, storageError, add, remove }: {
  request: AuthorizedRequest; target: FollowTarget; title: string; cityName: string;
  entry?: FollowEntry; storageError: string;
  add: (target: FollowTarget, snapshot: ProjectSnapshot) => void;
  remove: (target: FollowTarget) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function follow() {
    if (pending || entry || storageError) return;
    setPending(true);
    setError('');
    try {
      const { snapshot } = await readCurrentProjectSnapshot(request, target, cityName);
      if (mounted.current) add(target, snapshot);
    } catch {
      if (mounted.current)
        setError('Current public source could not be read in full. Follow was not saved; try again.');
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  return <div className="civic-project-follow">
    <button type="button" className="civic-follow-button" aria-pressed={Boolean(entry)}
      aria-label={`${entry ? 'Following; unfollow' : 'Follow'} ${title}`}
      disabled={pending || Boolean(storageError)}
      onClick={() => { if (entry) { setError(''); remove(target); } else void follow(); }}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill={entry ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8"><path d="M6 3.5h12v17l-6-4-6 4z" /></svg>
      {pending ? 'Checking sources…' : entry ? 'Following · Unfollow' : 'Follow'}
    </button>
    <small>Saved in this browser for this account. Nobody is notified; check again after a new published snapshot.</small>
    {error && <small role="alert">{error}</small>}
  </div>;
}
