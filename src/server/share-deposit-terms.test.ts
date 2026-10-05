import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cashDepositForm, canonicalDeposit, shareDepositForm, solanaShareDepositForm } from '../domain/deposit-form.ts';
import type { ShareDepositView } from '../domain/share-deposit.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { SHARES_PROGRAM_ID, SHARES_PRICE_AUTHORITY, SHARES_INITIALIZER, DAILY_FAUCET_BUDGET, DEBT_EXPOSURE_CAP, sharesAddresses } from '../finance/solana/shares.ts';
import { agreementDigest, inviteToAgreement, joinAgreement, type Agreement } from './agreements.ts';
import { createListing, applyToListing, chooseApplicant, listListings } from './listings.ts';
import { tenancyJourney } from './journey.ts';
import { LocalStore } from './store.ts';

const person = (subject: string): VerifiedIdentity => ({ subject, sessionId: subject, expiresAt: Date.now() / 1000 + 3600, passkeyCount: 1,
  wallets: [{ id: `${subject}-sol`, address: `${subject}-sol-address`, chainType: 'solana' }, { id: `${subject}-evm`, address: `0x${subject.padEnd(40, '1').slice(0, 40)}`, chainType: 'ethereum' }] });
const pins = { programId: SHARES_PROGRAM_ID, shareMint: SHARES_PRICE_AUTHORITY, price: SHARES_INITIALIZER };
const baseAgreement = (): Agreement => ({ id: 'fixed', network: 'solana', property: 'Test flat', requiredSecurity: '2000000', releaseAllowed: false, createdAt: '', revision: 0,
  parties: Object.fromEntries(['tenant', 'landlord', 'arbitrator'].map(role => [role, { subject: role, wallet: person(role).wallets[0] }])), invitations: {}, accepted: {}, records: [] });
const hash = (value: unknown) => `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

test('v1-v4 retain their existing canonical bytes and domain separation', () => {
  for (const version of [1, 2, 3, 4]) {
    const agreement = baseAgreement();
    if (version >= 2) agreement.depositForm = version === 4 ? cashDepositForm() : shareDepositForm('2000000', '0x' + '2'.repeat(40));
    if (version === 3) agreement.rentTerms = { buildingId: 'demo-neighbourhood-homes', shareBps: 2000, rentMonthly: '1000000', landlordWallet: 'evm-landlord' };
    if (version === 4) agreement.rentTerms = { network: 'solana-devnet', house: 'house', shareBps: 2000, rentMonthly: '1000000', landlordWallet: 'sol-landlord' };
    const rent = agreement.rentTerms;
    const expected = { domain: `rental-agreement-v${version}`, id: agreement.id, network: agreement.network, property: agreement.property,
      ...(version === 1 ? { asset: 'USDC' } : { deposit: canonicalDeposit(agreement.depositForm!) }),
      ...(rent ? { rent: rent.network === 'solana-devnet' ? { network: rent.network, rentMonthly: rent.rentMonthly, shareBps: rent.shareBps, landlordWallet: rent.landlordWallet, house: rent.house } : { buildingId: rent.buildingId, shareBps: rent.shareBps, rentMonthly: rent.rentMonthly, landlordWallet: rent.landlordWallet } } : {}),
      requiredSecurity: agreement.requiredSecurity, releaseAllowed: agreement.releaseAllowed, tenant: 'tenant-sol-address', landlord: 'landlord-sol-address', arbitrator: 'arbitrator-sol-address' };
    assert.equal(agreementDigest(agreement), hash(expected));
  }
});

test('v5 binds Solana share deployment, security, cover, windows, wallets and optional rent', () => {
  const agreement = { ...baseAgreement(), depositForm: solanaShareDepositForm('2000000', pins) };
  const original = agreementDigest(agreement);
  assert.equal(original, hash({ domain: 'rental-agreement-v5', id: agreement.id, network: agreement.network, property: agreement.property, deposit: canonicalDeposit(agreement.depositForm), requiredSecurity: agreement.requiredSecurity, releaseAllowed: false, tenant: 'tenant-sol-address', landlord: 'landlord-sol-address', arbitrator: 'arbitrator-sol-address' }));
  for (const [field, value] of Object.entries({ programId: 'other-program', mint: 'other-mint', securityUsd6: '3000000', initialRatioBps: 15001, topUpRatioBps: 12501, responseWindow: 3600, returnWindow: 3600, arbitrationWindow: 3600 })) {
    assert.notEqual(agreementDigest({ ...agreement, depositForm: { ...agreement.depositForm, [field]: value } }), original, field);
  }
  for (const role of ['tenant', 'landlord', 'arbitrator'] as const) {
    const party = agreement.parties[role]!;
    assert.notEqual(agreementDigest({ ...agreement, parties: { ...agreement.parties, [role]: { ...party, wallet: { ...party.wallet, address: 'changed' } } } }), original);
  }
  for (const rentTerms of [
    { network: 'solana-devnet' as const, house: 'house', rentMonthly: '1000000', shareBps: 2000 as const, landlordWallet: 'landlord-sol-address' },
    { buildingId: 'demo-neighbourhood-homes' as const, rentMonthly: '1000000', shareBps: 2000 as const, landlordWallet: 'landlord-evm-address' },
  ]) {
    const rented = { ...agreement, rentTerms };
    assert.notEqual(agreementDigest(rented), original);
    assert.notEqual(agreementDigest({ ...rented, rentTerms: { ...rentTerms, rentMonthly: '1000001' } }), agreementDigest(rented));
  }
  const reordered = Object.fromEntries(Object.entries(agreement.depositForm).reverse()) as typeof agreement.depositForm;
  assert.equal(agreementDigest({ ...agreement, depositForm: reordered }), original);
  assert.throws(() => solanaShareDepositForm('999999', pins), /between 1 and 10,000/);
  assert.throws(() => solanaShareDepositForm('2000000', pins, { responseWindow: 3599 }), /windows/);
});

test('Solana listing pins configuration and uses Solana wallets for every role', async () => {
  const store = new LocalStore(':memory:');
  try {
    const manifest = { cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, programId: SHARES_PROGRAM_ID, cashMint: SOLANA_TEST_USDC_MINT, priceAuthority: SHARES_PRICE_AUTHORITY, initializer: SHARES_INITIALIZER, initialPriceUsdE6: '370448000', initialPricePublishedAt: '1790970931', dailyFaucetBudgetAtomic: DAILY_FAUCET_BUDGET.toString(), debtExposureCapAtomic: DEBT_EXPOSURE_CAP.toString(), ...await sharesAddresses() };
    const environment = { SOLANA_SHARES_MANIFEST: JSON.stringify(manifest) };
    const input = { title: 'Solana shares flat', rentMonthly: '1000000', requiredSecurity: '2000000', releaseAllowed: true, depositForm: 'shares-solana', programId: 'untrusted', mint: 'untrusted', initialRatioBps: 1 };
    await assert.rejects(createListing(store, person('landlord'), input, { SOLANA_SHARES_MANIFEST: '{}' }), /devnet genesis/);
    await assert.rejects(createListing(store, person('landlord'), input, {}), /not deployed/);
    await assert.rejects(createListing(store, person('landlord'), { ...input, requiredSecurity: '2000001' }, environment), /two months/);
    const listing = await createListing(store, person('landlord'), input, environment);
    assert.deepEqual(listing.depositForm, solanaShareDepositForm('2000000', manifest));
    assert.equal(listing.releaseAllowed, false);
    const ethereumOnly = { ...person('outsider'), wallets: person('outsider').wallets.filter(wallet => wallet.chainType === 'ethereum') };
    await assert.rejects(applyToListing(store, ethereumOnly, listing.id, { name: 'Outsider' }), /verified personal wallet/);
    await applyToListing(store, person('tenant'), listing.id, { name: 'Tenant' });
    const applications = (await listListings(store, person('landlord')))[0].applications!;
    const chosen = await chooseApplicant(store, person('landlord'), listing.id, applications[0].id);
    const invitation = await inviteToAgreement(store, chosen.agreementId!, person('landlord'), 'arbitrator');
    await assert.rejects(joinAgreement(store, chosen.agreementId!, { ...person('arbitrator'), wallets: person('arbitrator').wallets.filter(wallet => wallet.chainType === 'ethereum') }, 'arbitrator', invitation.token), /verified personal wallet/);
    const joined = await joinAgreement(store, chosen.agreementId!, person('arbitrator'), 'arbitrator', invitation.token);
    assert.equal(joined.network, 'solana');
    for (const role of ['tenant', 'landlord', 'arbitrator'] as const) assert.equal(joined.parties[role]?.wallet.chainType, 'solana');
  } finally { await store.close(); }
});

test('journey routes Solana shares separately and describes pledge without approval then activation', async () => {
  const store = new LocalStore(':memory:');
  try {
    const agreement = { ...baseAgreement(), depositForm: solanaShareDepositForm('2000000', pins) };
    const digest = agreementDigest(agreement)!;
    agreement.accepted = { tenant: { digest, at: '' }, landlord: { digest, at: '' } };
    let solanaReads = 0, evmReads = 0;
    const view = { deployment: 'deployed', escrow: 'escrow', state: 'AwaitingLock', actions: ['pledge'], form: agreement.depositForm } as ShareDepositView;
    const solanaReader = async () => { solanaReads++; return view; };
    const evmReader = async () => { evmReads++; return view; };
    const read = () => tenancyJourney(store, person('tenant'), agreement, undefined, evmReader, solanaReader);
    assert.match((await read()).next.detail, /exactly the remaining.*No token approval/);
    view.actions = ['activate'];
    assert.equal((await read()).next.label, 'Activate your share deposit');
    view.state = 'Active';
    assert.equal((await read()).stage, 'living');
    assert.deepEqual([solanaReads, evmReads], [3, 0]);
    const evm = { ...agreement, depositForm: shareDepositForm('2000000', '0x' + '2'.repeat(40)) };
    const evmDigest = agreementDigest(evm)!;
    evm.accepted = { tenant: { digest: evmDigest, at: '' }, landlord: { digest: evmDigest, at: '' } };
    view.state = 'AwaitingLock'; view.actions = ['approve', 'pledge'];
    assert.match((await tenancyJourney(store, person('tenant'), evm, undefined, evmReader, solanaReader)).next.detail, /Approve exactly/);
    assert.deepEqual([solanaReads, evmReads], [3, 1]);
  } finally { await store.close(); }
});
