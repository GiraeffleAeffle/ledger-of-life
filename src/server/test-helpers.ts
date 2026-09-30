import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type KeyPairSigner,
} from '@solana/kit';
import { buildTestCreditYield, derivePayoutAddress } from '../finance/solana/index.ts';
import { RpcSolanaGateway } from './solana-rpc.ts';
import { configuredFeeSponsor } from './solana-service.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { acceptAgreement, addAgreementRecord, inviteToAgreement, joinAgreement, type Agreement } from './agreements.ts';
import { tenancyJourney, type JourneyRole } from './journey.ts';
import { applyToListing, chooseApplicant, createListing, PRESET_PHOTOS, type Listing } from './listings.ts';
import { ensurePayoutAccounts, solanaConfigurationFor, solanaServicesFor } from './solana-tenancies.ts';
import { signPrepared, testIdentity, TEST_SUBJECT_PREFIX, type TestRole } from './test-signer.ts';
import type { Store } from './store.ts';
import { operatorTestCapability } from './test-capability.ts';

/**
 * Local-only helpers: operator-held test keys play the *other* people in a tenancy so one real
 * passkey account can walk the whole journey. They use the same services as real people; only
 * the signature is produced here. Their actions are fixtures, never wallet evidence.
 */
export function testHelpersEnabled(_request: Request, environment: Record<string, string | undefined> = process.env) {
  return operatorTestCapability(environment);
}

async function signers(environment: Record<string, string | undefined>) {
  const dir = resolve(environment.SOLANA_TEST_SIGNER_DIR || '.testnet-secrets/test-signer');
  const entries = await Promise.all((['tenant', 'landlord', 'arbitrator'] as const).map(async (role) => {
    const bytes = new Uint8Array(JSON.parse(await readFile(resolve(dir, `${role}.json`), 'utf8')));
    const signer = await createKeyPairSignerFromBytes(bytes);
    return [role, { signer, identity: testIdentity(role, signer.address) }] as const;
  }));
  return Object.fromEntries(entries) as Record<TestRole, { signer: KeyPairSigner; identity: VerifiedIdentity }>;
}

const gate = async (_store: Store, identity: VerifiedIdentity) => ({ wallet: identity.wallets[0], proof: null });
const isTest = (subject: string | undefined) => Boolean(subject?.startsWith(TEST_SUBJECT_PREFIX));

async function finalize<T extends { state: string }>(check: () => Promise<T>) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await check();
    if (result.state === 'finalized') return result;
    if (result.state === 'failed') throw new Error('The test party’s transaction failed.');
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 2500);
    await pause.promise;
  }
  throw new Error('Still confirming. Press the helper again in a moment.');
}

const SAMPLE_HOMES = [
  {
    title: 'Bright 2-room flat near the park', city: 'Berlin-Friedrichshain', rooms: 2, sizeSqm: 58, availableFrom: '2026-11-01',
    description: 'Sunny corner flat on the 3rd floor with balcony, wooden floors and a fitted kitchen. Five minutes to the park and the U-Bahn.',
    rentMonthly: '1150000000', requiredSecurity: '1000000', photo: 0,
  },
  {
    title: 'Quiet studio with garden view', city: 'Hamburg-Eimsbüttel', rooms: 1, sizeSqm: 34, availableFrom: '2026-10-15',
    description: 'Compact studio facing the courtyard garden. New bathroom, washing machine connection, bike cellar.',
    rentMonthly: '780000000', requiredSecurity: '1000000', photo: 3,
  },
  {
    title: 'Family home with 4 rooms', city: 'Munich-Sendling', rooms: 4, sizeSqm: 96, availableFrom: '2026-12-01',
    description: 'Spacious flat for a family: two bedrooms, a study, open kitchen, loggia and a parking space in the courtyard.',
    rentMonthly: '2100000000', requiredSecurity: '2000000', photo: 1,
  },
];

/** The test landlord publishes a few realistic sample homes (skips ones already listed). */
export async function postTestHome(store: Store, environment = process.env) {
  const { landlord } = await signers(environment);
  const existing = (await store.scan<Listing>('listing:', '', 200))
    .filter((row) => row.value.landlord.subject === landlord.identity.subject && row.value.status === 'open')
    .map((row) => row.value.title);
  const posted = [];
  for (const home of SAMPLE_HOMES) {
    if (existing.includes(home.title)) continue;
    posted.push(await createListing(store, landlord.identity, {
      ...home,
      photos: [PRESET_PHOTOS[home.photo], PRESET_PHOTOS[(home.photo + 2) % PRESET_PHOTOS.length]],
      releaseAllowed: true,
    }));
  }
  return posted;
}

export async function addTestApplicant(store: Store, user: VerifiedIdentity, listingId: string, environment = process.env) {
  const listing = await store.get<Listing>(`listing:${listingId}`);
  if (!listing || listing.landlord.subject !== user.subject) throw new Error('Add test applicants only to your own listing.');
  const { tenant } = await signers(environment);
  return applyToListing(store, tenant.identity, listingId, { name: 'Sample tenant (fixture)', message: 'A sample test tenant applying so you can continue.' });
}

/** Performs every step that is currently up to a test party in this listing or tenancy. */
export async function actForTestParties(
  store: Store,
  user: VerifiedIdentity,
  target: { listingId?: string; agreementId?: string },
  environment = process.env,
): Promise<string[]> {
  const people = await signers(environment);
  const done: string[] = [];
  if (target.listingId) {
    const listing = await store.get<Listing>(`listing:${target.listingId}`);
    if (!listing || !isTest(listing.landlord.subject)) throw new Error('This listing does not belong to the test landlord.');
    const application = listing.applications.find((item) => item.subject === user.subject) ?? listing.applications[0];
    if (!application) throw new Error('Nobody applied yet.');
    const chosen = await chooseApplicant(store, people.landlord.identity, listing.id, application.id);
    done.push('Test landlord chose an applicant');
    target = { agreementId: chosen.agreementId ?? undefined };
  }
  if (!target.agreementId) return done;
  const load = async () => (await store.get<Agreement>(`agreement:${target.agreementId}`))!;
  let agreement = await load();
  if (!Object.values(agreement.parties).some((party) => party?.subject === user.subject))
    throw new Error('You are not part of this tenancy.');
  if (!agreement.parties.arbitrator) {
    // Whoever is the landlord (test or you) invites; the test arbitrator joins with that token.
    const landlordIsTest = isTest(agreement.parties.landlord?.subject);
    const invite = await inviteToAgreement(store, agreement.id, landlordIsTest ? people.landlord.identity : user, 'arbitrator');
    await joinAgreement(store, agreement.id, people.arbitrator.identity, 'arbitrator', invite.token);
    done.push('The test arbitrator joined');
    agreement = await load();
  }
  const resolveServices = (s: Store, id: string | null) => solanaServicesFor(s, id, environment, gate);
  for (let round = 0; round < 3; round++) {
    let acted = false;
    for (const role of ['landlord', 'tenant', 'arbitrator'] as JourneyRole[]) {
      if (!isTest(agreement.parties[role]?.subject)) continue;
      const { identity, signer } = people[role];
      const journey = await tenancyJourney(store, identity, agreement, resolveServices);
      const next = journey.next;
      const services = await resolveServices(store, agreement.id);
      const operation = async (action: Record<string, unknown>, evidence?: string) => {
        const op = await services!.service.prepare(identity, `test-${randomUUID()}`, action);
        await services!.service.authorize(identity, op.id, await signPrepared(signer, op.transactionBase64));
        if (evidence) await addAgreementRecord(store, agreement.id, identity, action.kind === 'propose_claim' ? 'Move-out deduction' : action.kind === 'respond_to_claim' ? 'Dispute the deduction' : 'Arbitration decision', `${evidence}\n\nSigned sample operation ${op.id}.`);
        await finalize(() => services!.service.reconcile(identity, op.id));
      };
      switch (next.kind) {
        case 'invite_arbitrator': {
          const invite = await inviteToAgreement(store, agreement.id, identity, 'arbitrator');
          await joinAgreement(store, agreement.id, people.arbitrator.identity, 'arbitrator', invite.token);
          break;
        }
        case 'accept_agreement':
          await acceptAgreement(store, agreement.id, identity, next.digest);
          break;
        case 'create_space': {
          await ensurePayoutAccounts(store, agreement.id, environment);
          const init = await services!.initialization.prepare(identity);
          if (init.state === 'prepared') await services!.initialization.sign(identity, await signPrepared(signer, init.transactionBase64));
          await finalize(() => services!.initialization.reconcile(identity));
          break;
        }
        case 'secure_deposit':
          await operation({ kind: 'fund_and_supply' });
          break;
        case 'propose_claim':
          await operation({ kind: 'propose_claim', amountAtomic: '100000' }, 'Sample test landlord: small cleaning fee of 0.10 test USDC.');
          break;
        case 'respond_claim':
          await operation({ kind: 'accept_and_settle' });
          break;
        case 'decide_claim':
          await operation({ kind: 'resolve_and_settle', amountAtomic: (BigInt(next.claimAtomic) / 2n).toString() }, 'Sample test arbitrator: split the disputed amount.');
          break;
        case 'settle':
          await operation({ kind: 'redeem_and_settle' });
          break;
        default:
          continue;
      }
      done.push(`Test ${role}: ${next.label}`);
      acted = true;
      agreement = await load();
    }
    if (!acted) break;
  }
  return done;
}

/**
 * Test networks have no borrowers, so lending pays nothing. This credits stand-in interest
 * (default 0.25 test USDC, "about a month") from the test funder into the escrow via the
 * test-only program instruction; it then follows the real earnings-release rules.
 */
export async function creditTestYield(store: Store, user: VerifiedIdentity, agreementId: string, amountAtomic = '250000', environment = process.env) {
  const agreement = await store.get<Agreement>(`agreement:${agreementId}`);
  if (!agreement || !Object.values(agreement.parties).some((party) => party?.subject === user.subject))
    throw new Error('You are not part of this tenancy.');
  const [config, sponsor, people] = await Promise.all([solanaConfigurationFor(store, agreementId, environment), configuredFeeSponsor(environment), signers(environment)]);
  if (!config || !sponsor) throw new Error('The deposit service is not configured.');
  const gateway = new RpcSolanaGateway(config);
  const { tenancy } = await gateway.snapshot();
  if (tenancy.phase !== 'active') throw new Error('Interest accrues only while the deposit is active.');
  const funder = people.tenant.signer;
  const source = await derivePayoutAddress(funder.address, config.depositMint);
  const instruction = await buildTestCreditYield({ manifest: config, tenancy, funder: funder.address, source, amountAtomic });
  const lifetime = await gateway.lifetime();
  const message = appendTransactionMessageInstructions([instruction], setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: blockhash(lifetime.blockhash), lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) },
    setTransactionMessageFeePayer(address(sponsor.address), createTransactionMessage({ version: 0 })),
  ));
  const funderSigned = await partiallySignTransaction([funder.keyPair], compileTransaction(message));
  const signed = await sponsor.sign(new Uint8Array(getTransactionEncoder().encode(funderSigned)));
  const signature = getBase58Decoder().decode(getTransactionDecoder().decode(signed).signatures[address(sponsor.address)]!);
  if ((await gateway.broadcast(signed)) !== signature) throw new Error('RPC returned another signature');
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = (await gateway.rpc('getSignatureStatuses', [[signature]])) as { value: ({ err: unknown; confirmationStatus?: string } | null)[] };
    if (status.value[0]?.err) throw new Error('Crediting test interest failed.');
    if (status.value[0]?.confirmationStatus === 'finalized') return ['Credited ' + (Number(amountAtomic) / 1e6).toFixed(2) + ' test USDC of simulated interest'];
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 2000);
    await pause.promise;
  }
  throw new Error('Still confirming. Refresh in a moment.');
}
