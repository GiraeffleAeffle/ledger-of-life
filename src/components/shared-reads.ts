/**
 * Shares one in-flight read per key between components that ask at the same time, but only among callers holding the
 * same `owner` (the authorized request function). That function belongs to one signed-in account generation; reusing its
 * read for a later generation would surface "Account changed" (or another account's answer) to the new one.
 * Settled reads are never reused.
 */
export function sharedReads<Owner extends object, T>() {
  const pending = new Map<string, { owner: Owner; promise: Promise<T> }>();
  return {
    read(owner: Owner, key: string, start: () => Promise<T>): Promise<T> {
      const current = pending.get(key);
      if (current?.owner === owner) return current.promise;
      const entry = { owner, promise: start() };
      pending.set(key, entry);
      const settle = () => { if (pending.get(key) === entry) pending.delete(key); };
      void entry.promise.then(settle, settle);
      return entry.promise;
    },
    clear() { pending.clear(); },
  };
}
