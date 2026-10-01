import { randomUUID } from 'node:crypto';
import { ConflictError } from './errors.ts';
import type { Store } from './store.ts';
import { executeTestUsdcPayout, testUsdcPayoutContext, type TestUsdcClient } from './test-usdc-payout.ts';
const DAY = 86_400_000;
const KEY = 'solana-test-usdc:devnet';
type Journal = {
  subject: string; at: number; lease: string; busyUntil: number;
  authority: string; sponsor: string; amountAtomic: string; ata: string;
  signed?: string; signature?: string; messageSha256?: string; lastValidBlockHeight?: string;
  done?: boolean;
};
type Ledger = { accounts: Record<string, number>; wallets: Record<string, Journal>; day: string; count: number };
type Client = TestUsdcClient;
type Options = { environment?: Record<string, string | undefined>; client?: Client; now?: () => number };

function positiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('Invalid test USDC faucet amount or daily cap.');
  return Number(value);
}

/** Only the server's verified identity may select the recipient; no request amount or wallet is accepted. */
export async function mintTestUsdc(store: Store, subject: string, verifiedWallet: string, options: Options = {}) {
  const environment = options.environment ?? process.env;
  const context = await testUsdcPayoutContext(verifiedWallet, environment, options.client);
  if (!context) return { status: 'unconfigured' as const };
  const { authority, sponsor, owner, ata } = context;
  const amount = BigInt(positiveInteger(environment.SOLANA_TEST_USDC_AMOUNT, 10_000)) * 1_000_000n;
  if (amount > 18_446_744_073_709_551_615n) throw new Error('Test USDC amount exceeds the token limit.');
  const cap = positiveInteger(environment.SOLANA_TEST_USDC_DAILY_CAP, 200);
  const at = (options.now ?? Date.now)();
  const lease = randomUUID();
  try { await store.create<Ledger>(KEY, { accounts: {}, wallets: {}, day: '', count: 0 }); }
  catch (error) { if (!await store.get(KEY)) throw error; }
  const ledger = await store.update<Ledger>(KEY, (value) => {
    for (const [wallet, entry] of Object.entries(value.wallets)) {
      if (!entry.signed && entry.busyUntil <= at) {
        delete value.wallets[wallet];
        if (value.accounts[entry.subject] === entry.at) delete value.accounts[entry.subject];
        if (value.day === new Date(entry.at).toISOString().slice(0, 10)) value.count--;
      } else if (entry.done && entry.at + DAY <= at) delete value.wallets[wallet];
    }
    for (const [account, last] of Object.entries(value.accounts)) {
      if (last + DAY <= at) delete value.accounts[account];
    }
    const existing = value.wallets[owner];
    if (existing && !existing.done) {
      if (existing.subject !== subject) throw new ConflictError('This wallet already has an unresolved test USDC mint.');
      if (existing.busyUntil > at) throw new ConflictError('A test USDC mint for this wallet is already in flight.');
      if (existing.authority !== authority.address || existing.sponsor !== sponsor.address)
        throw new ConflictError('Restore the original faucet authority and sponsor to recover this mint.');
      existing.lease = lease; existing.busyUntil = at + 60_000;
      return value;
    }
    // Unresolved signed operations remain charged across days and wallet changes.
    if (Object.values(value.wallets).some((entry) => entry.subject === subject && !entry.done))
      throw new ConflictError('Recover your pending test USDC mint with its original wallet first.');
    if ((value.accounts[subject] ?? -DAY) + DAY > at || (existing && existing.at + DAY > at))
      throw new ConflictError('Test USDC is limited to once per 24 hours per account and wallet.');
    const day = new Date(at).toISOString().slice(0, 10);
    if (value.day !== day) { value.day = day; value.count = 0; }
    if (value.count >= cap) throw new ConflictError('This site has reached its daily test USDC limit. Try tomorrow.');
    value.count++;
    value.accounts[subject] = at;
    value.wallets[owner] = { subject, at, lease, busyUntil: at + 60_000, authority: authority.address, sponsor: sponsor.address, amountAtomic: amount.toString(), ata };
    return value;
  });
  let journal = ledger.wallets[owner];
  const persist = async (change: (value: Journal) => Journal) => {
    const saved = await store.update<Ledger>(KEY, (value) => {
      if (value.wallets[owner]?.lease !== lease) throw new ConflictError('Test USDC reservation changed. Retry to recover it.');
      value.wallets[owner] = change(value.wallets[owner]);
      return value;
    });
    journal = saved.wallets[owner];
  };
  try {
    const result = await executeTestUsdcPayout(context, journal, async (saved) => {
      await persist((value) => ({ ...value, ...saved }));
    });
    if (result.status === 'confirmed' || result.status === 'failed' || result.status === 'expired')
      await persist((value) => ({ ...value, done: true }));
    if (result.status === 'failed' || result.status === 'expired')
      throw new ConflictError(`The test USDC mint ${result.status === 'failed' ? 'failed' : 'expired without confirmation'}. No replacement transaction was sent.`);
    return result;
  } finally {
    await store.update<Ledger>(KEY, (value) => {
      const current = value.wallets[owner];
      if (current?.lease !== lease) return value;
      if (!current.signed) {
        delete value.wallets[owner];
        if (value.accounts[subject] === current.at) delete value.accounts[subject];
        if (value.day === new Date(current.at).toISOString().slice(0, 10)) value.count--;
      } else current.busyUntil = 0;
      return value;
    });
  }
}
