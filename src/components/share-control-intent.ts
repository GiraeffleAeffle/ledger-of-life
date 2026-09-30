export type PendingShareControl = { operation: string; requestId: string };
type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const keyFor = (account: string) => `ledger-of-life:share-control:${account}`;

export function readPendingShareControl(storage: IntentStorage, account: string): PendingShareControl | null {
  const saved = storage.getItem(keyFor(account));
  if (!saved) return null;
  let intent: PendingShareControl;
  try { intent = JSON.parse(saved) as PendingShareControl; }
  catch { throw new Error('Saved test control cannot be decoded; resolve it before starting another operator action.'); }
  if (!intent || typeof intent.operation !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(intent.requestId))
    throw new Error('Saved test control is invalid; resolve it before starting another operator action.');
  return intent;
}
export function reserveShareControl(storage: IntentStorage, account: string, operation: string, newId: () => string): PendingShareControl {
  const saved = readPendingShareControl(storage, account);
  if (saved) {
    if (saved.operation !== operation) throw new Error(`Resume the reserved ${saved.operation.replaceAll('_', ' ')} control before another operator action.`);
    return saved;
  }
  const intent = { operation, requestId: newId() };
  storage.setItem(keyFor(account), JSON.stringify(intent));
  return intent;
}
export function clearShareControl(storage: IntentStorage, account: string, intent: PendingShareControl) {
  const saved = readPendingShareControl(storage, account);
  if (saved?.requestId === intent.requestId && saved.operation === intent.operation) storage.removeItem(keyFor(account));
}
