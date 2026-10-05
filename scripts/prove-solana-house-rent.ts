import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { address, createNoopSigner, generateKeyPairSigner } from '@solana/kit';
import { walletFor } from '../src/server/agreements.ts';
import { verifyPrivyToken } from '../src/server/identity.ts';
import { getStore } from '../src/server/store.ts';
import { assertTestSignerAllowed, testIdentity, signPrepared } from '../src/server/test-signer.ts';
import { loadSolanaHouseManifest } from '../src/server/solana-house-config.ts';
import { configuredSolanaOperations, type PreparedSolanaOperation } from '../src/server/solana-operations.ts';
import { prepareSolanaHouseAction, submitSolanaHouseAction, cancelSolanaHouseReview, readSolanaHouseSnapshot, type SolanaHouseSnapshot } from '../src/server/building-solana.ts';
import { depositRewardsInstruction, pendingOwed } from '../src/finance/solana/house.ts';
import { prepareRent, submitRent, readRent, solanaRentInstructions } from '../src/server/rent-payments.ts';
import { mintTestUsdc } from '../src/server/test-usdc.ts';
import { testUsdcPayoutContext } from '../src/server/test-usdc-payout.ts';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { decodeClassicTokenAccount } from '../src/finance/solana/observations.ts';

// Opt-in app-service proof, not a browser/Privy UX claim. No key files are read here.
//   --run all (ephemeral, in-memory operator fixture; complete house + rent-builder cycle)
// Node --conditions=react-server --experimental-strip-types scripts/prove-solana-house-rent.ts
//   --prepare buy|stake|deposit-rewards|claim|reinvest|unstake|rent
//   --submit OPERATION_ID | --reconcile OPERATION_ID
// Requires SOLANA_HOUSE_RENT_PROOF=1 and the site's existing sponsor/RPC/house environment.
// User signs the exact emitted transactionBase64 externally AFTER reading the review.
// Submission additionally requires SOLANA_HOUSE_RENT_REVIEWED_ID=OPERATION_ID and
// SOLANA_HOUSE_RENT_SIGNED_BASE64. Never print credentials or signed transaction bytes.
// Identity: SOLANA_HOUSE_RENT_ACCESS_TOKEN, or explicitly gated SOLANA_TEST_SIGNER_MODE=1
// plus SOLANA_HOUSE_RENT_WALLET (public address only; recorded as operator fixture evidence).
// Amounts: SOLANA_HOUSE_RENT_AMOUNT_ATOMIC (buy cash, stake/unstake units, deposit cash).
// --run all funding: SOLANA_HOUSE_RENT_FUNDING=sponsor-ata explicitly selects an exact
// 64 tUSDC transfer from the configured sponsor's ATA, never an automatic faucet fallback.
// Rent requires SOLANA_HOUSE_RENT_AGREEMENT_ID: an actual accepted, active local tenancy.
// Streaming is REAL elapsed devnet time, never an instant payout or clock warp. For example,
// 60.48 fictional tUSDC funding streams 100 cash atomic units/second to a sole staker. Read fresh
// claim/reinvest reviews; no automatic seven-day wait, funding or substitute fee payer.
const [phase, argument] = process.argv.slice(2);
if (process.env.SOLANA_HOUSE_RENT_PROOF !== '1' || !['--prepare', '--submit', '--reconcile', '--run'].includes(phase ?? '') || !argument || process.argv.length !== 4)
  throw new Error('Explicit opt-in required: SOLANA_HOUSE_RENT_PROOF=1; --run all, --prepare ACTION, --submit ID, or --reconcile ID.');
if (process.env.DATABASE_URL) throw new Error('This proof only uses the local app database.');
const manifest = loadSolanaHouseManifest();
if (!manifest || manifest.cluster !== 'devnet') throw new Error('A deployed devnet house manifest is required.');
const generatedSigner = phase === '--run' ? await generateKeyPairSigner() : null;
if (generatedSigner) assertTestSignerAllowed(process.env, manifest);
const fixtureWallet = generatedSigner?.address ?? process.env.SOLANA_HOUSE_RENT_WALLET;
if (fixtureWallet) assertTestSignerAllowed(process.env, manifest);
const identity = fixtureWallet ? testIdentity('tenant', address(fixtureWallet)) : await verifyPrivyToken(process.env.SOLANA_HOUSE_RENT_ACCESS_TOKEN ?? '');
if (fixtureWallet) {
  // Each fixture wallet owns its own durable app lane; the shared role fixture subject
  // would otherwise attach a new wallet to a prior run's prepared house operation.
  identity.subject = `test-signer:house-rent:${fixtureWallet}`;
  identity.sessionId = `test-signer:house-rent-session:${fixtureWallet}`;
  identity.wallets[0].id = `test-signer:house-rent-wallet:${fixtureWallet}`;
}
const wallet = walletFor(identity, 'solana');
const houseId = 'neighbourhood-homes';
const house = manifest.houses[houseId];
const evidencePath = new URL('../docs/evidence/SOLANA_HOUSE_RENT_APP_PROOFS_2026-10-05.json', import.meta.url);
const store = await getStore();
type Snapshot = { slot: string; chainTimestamp: string; cashAtomic: string; walletUnitsAtomic: string; stakedAtomic: string; claimedTotalAtomic: string; earnedAtomic: string; revenueTotalAtomic: string; revenueBySourceAtomic: string[]; rewardCashAtomic: string; deskCashAtomic: string; totalStakedAtomic: string; rewardDurationSeconds: string; periodFinish: string };
type Proof = { id: string; action: string; subject: string; wallet: string; feePayer: string; review: Record<string, unknown>; before: Snapshot; evidenceKind: string; agreementId?: string; stepId?: string };
function publicSnapshot(snapshot: SolanaHouseSnapshot) {
  return { slot: snapshot.slot, chainTimestamp: snapshot.nowSeconds.toString(), cashAtomic: snapshot.cash.toString(), walletUnitsAtomic: snapshot.walletUnits.toString(), stakedAtomic: (snapshot.position?.staked ?? 0n).toString(), claimedTotalAtomic: (snapshot.position?.claimedTotal ?? 0n).toString(), earnedAtomic: (snapshot.position ? pendingOwed(snapshot.house, snapshot.position, snapshot.nowSeconds) : 0n).toString(), revenueTotalAtomic: snapshot.house.revenueTotal.toString(), revenueBySourceAtomic: snapshot.house.revenueBySource.map(String), rewardCashAtomic: snapshot.rewardCash.toString(), deskCashAtomic: snapshot.deskCash.toString(), totalStakedAtomic: snapshot.house.totalStaked.toString(), rewardDurationSeconds: snapshot.house.rewardDuration.toString(), periodFinish: snapshot.house.periodFinish.toString() };
}
try {
  const context = await configuredSolanaOperations(store, { cluster: 'devnet', genesisHash: manifest.genesisHash, maximumSponsorLamports: 10_000_000n });
  if (wallet.address === context.sponsor.address) throw new Error('Use a separate user wallet; the site sponsor remains the only fee payer.');
  const snapshot = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await readSolanaHouseSnapshot(manifest, houseId, context.gateway, wallet.address); }
      catch (error) {
        if (phase !== '--run' || !(error instanceof Error) || error.message !== 'House clock does not match its finalized bank.') throw error;
        console.log(JSON.stringify({ phase: 'incoherent-finalized-clock-reobserve', acceptedSnapshot: false }));
        await delay(Math.min(1000 * (attempt + 1), 10_000));
      }
    }
  };
  const key = (id: string) => `house-rent-proof:${id}`;
  if (phase === '--run') {
    if (argument !== 'all' || !generatedSigner) throw new Error('Use --run all for the complete operator fixture proof.');
    const runId = randomUUID();
    const records: Record<string, unknown>[] = [];
    let abortedAttempts: unknown[] = [];
    try {
      const previous = JSON.parse(await readFile(evidencePath, 'utf8'));
      if (previous.genesisHash !== manifest.genesisHash || previous.programId !== manifest.programId) throw new Error('Existing proof evidence belongs to another deployment.');
      if (previous.proofs?.some((proof: { action?: string; state?: string }) => proof.action === 'unstake' && proof.state === 'confirmed')) throw new Error('This evidence already contains a complete proof; do not create another funded ephemeral run.');
      abortedAttempts = [...(previous.abortedAttempts ?? []), { ...previous, abortedAttempts: undefined, status: 'prior-aborted-attempt-preserved' }];
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const save = async () => {
      await mkdir(dirname(evidencePath.pathname), { recursive: true });
      await writeFile(evidencePath, JSON.stringify({ network: 'solana-devnet', genesisHash: manifest.genesisHash, programId: manifest.programId, house: house.house, evidenceKind: 'ephemeral-operator-fixture-app-services-not-Privy-or-browser-UX', runId, wallet: wallet.address, sponsor: context.sponsor.address, abortedAttempts, note: 'House actions use the app service; rent proves the exact app transaction builder and reconciliation, not tenancy acceptance or browser UX. Funding and rewards are fictional; real devnet time, no clock warp. User wallet signs once per operation, sponsor also signs as fee payer.', proofs: records }, null, 2) + '\n');
    };
    // Establish a coherent house/Clock bank before any fixture funding signature.
    await snapshot();
    if (process.env.SOLANA_HOUSE_RENT_FUNDING === 'sponsor-ata') {
      const [source] = await findAssociatedTokenPda({ owner: address(context.sponsor.address), mint: address(manifest.cashMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const [destination] = await findAssociatedTokenPda({ owner: address(wallet.address), mint: address(manifest.cashMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const row = (await context.gateway.multiple([source])).accounts[0];
      const token = row ? decodeClassicTokenAccount(row) : null;
      const amountAtomic = '64000000';
      if (!token || token.authority !== context.sponsor.address || token.mint !== manifest.cashMint || !token.initialized || token.frozen || BigInt(token.amountAtomic) < BigInt(amountAtomic)) throw new Error(`Fund the existing sponsor tUSDC ATA ${source} with at least 64 fictional tUSDC before this explicitly opted-in proof.`);
      const review = { network: 'solana-devnet', genesisHash: manifest.genesisHash, asset: manifest.cashMint, amountAtomic, source, recipient: destination, owner: wallet.address, authority: context.sponsor.address, feePayer: context.sponsor.address, description: 'Transfer exactly 64 fictional tUSDC from the configured site sponsor ATA to this ephemeral fixture; sponsor is the only funding signer and fee payer. No minting or escrow validator changes.' };
      let funded: { id: string; signature: string } | undefined;
      for (let attempt = 0; !funded; attempt++) {
        console.log(JSON.stringify({ phase: 'exact-review-before-sponsor-funding-signature', review }));
        try {
          funded = await context.operations.executeAsSponsor({ kind: 'house-proof:fixture-funding', requestId: runId, review, instructions: [
            getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(address(context.sponsor.address)), owner: address(wallet.address), mint: address(manifest.cashMint), ata: destination, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
            getTransferCheckedInstruction({ source, mint: address(manifest.cashMint), destination, authority: createNoopSigner(address(context.sponsor.address)), amount: BigInt(amountAtomic), decimals: 6 }),
          ], expectedDeltas: [
            { account: source, mint: manifest.cashMint, owner: context.sponsor.address, direction: 'debit', minimumAtomic: amountAtomic, maximumAtomic: amountAtomic },
            { account: destination, mint: manifest.cashMint, owner: wallet.address, direction: 'credit', minimumAtomic: amountAtomic, maximumAtomic: amountAtomic, allowCreated: true },
          ] });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Simulation bank changed; request a fresh review') throw error;
          // Re-enter the SAME sponsor request, never a second funding intent.
          console.log(JSON.stringify({ phase: 'sponsor-funding-prebroadcast-bank-reobserve', requestId: runId }));
          await delay(Math.min(1000 * (attempt + 1), 10_000));
        }
      }
      let result = await context.operations.reconcile({ id: funded.id });
      for (let attempt = 0; result.state === 'broadcast' && attempt < 60; attempt++) {
        await delay(2000);
        result = await context.operations.reconcile({ id: funded.id });
      }
      if (result.state !== 'confirmed') throw new Error(`Sponsor funding ${funded.id} ${result.state}; signature ${funded.signature}; reconcile original bytes, never replace.`);
      records.push({ action: 'fixture-sponsor-ata-funding', review, operationId: funded.id, signature: funded.signature, explorerUrl: `https://explorer.solana.com/tx/${funded.signature}?cluster=devnet`, amountAtomic });
    } else {
      if (process.env.SOLANA_HOUSE_RENT_FUNDING && process.env.SOLANA_HOUSE_RENT_FUNDING !== 'faucet') throw new Error('Choose explicit sponsor-ata funding or the existing faucet; no automatic fallback.');
      const fundingEnvironment = { ...process.env, SOLANA_TEST_USDC_AMOUNT: '10000' };
      const fundingContext = await testUsdcPayoutContext(wallet.address, fundingEnvironment);
      if (!fundingContext || fundingContext.sponsor.address !== context.sponsor.address) throw new Error('Configure the existing site faucet mint authority and same sponsor; no alternative payer/funding fallback.');
      const fundingReview = { network: 'solana-devnet', asset: manifest.cashMint, amountAtomic: '10000000000', recipient: fundingContext.ata, owner: wallet.address, mintAuthority: fundingContext.authority.address, feePayer: context.sponsor.address, description: 'Mint exactly 10000 fictional tUSDC from the existing site faucet to this ephemeral operator fixture.' };
      console.log(JSON.stringify({ phase: 'exact-review-before-faucet-signatures', review: fundingReview }));
      let funding = await mintTestUsdc(store, `test-signer:house-rent:${runId}`, wallet.address, { environment: fundingEnvironment });
      for (let attempt = 0; funding.status === 'pending' && attempt < 60; attempt++) {
        await delay(2000);
        funding = await mintTestUsdc(store, `test-signer:house-rent:${runId}`, wallet.address, { environment: fundingEnvironment });
      }
      if (funding.status !== 'confirmed') throw new Error('Faucet not confirmed; recover its durable journal, do not mint a replacement.');
      records.push({ action: 'fixture-faucet', review: fundingReview, signature: funding.signature, explorerUrl: `https://explorer.solana.com/tx/${funding.signature}?cluster=devnet`, amountAtomic: funding.amountAtomic });
    }
    await save();
    const prepareWithFreshBank = async (prepare: () => Promise<PreparedSolanaOperation>) => {
      for (let attempt = 0; ; attempt++) {
        try { return await prepare(); }
        catch (error) {
          if (!(error instanceof Error) || !['Simulation bank changed; request a fresh review', 'House clock does not match its finalized bank.'].includes(error.message)) throw error;
          // Both guards precede operation persistence/signature requests in prepare.
          // Never accept old balances or an incoherent bank; request a new observation.
          console.log(JSON.stringify({ phase: 'unsigned-prepare-fresh-observation', reason: error.message, signatureRequested: false }));
          await delay(Math.min(1000 * (attempt + 1), 10_000));
        }
      }
    };
    const execute = async (plan: PreparedSolanaOperation, action: string, before: SolanaHouseSnapshot, prepareAgain: () => Promise<PreparedSolanaOperation>, houseAction = false) => {
      let submitted: { signature: string } | undefined;
      for (let attempt = 0; ; attempt++) {
        console.log(JSON.stringify({ phase: 'exact-review-before-user-and-sponsor-signatures', action, operationId: plan.id, feePayer: plan.feePayer, network: 'solana-devnet', review: plan.review }));
        const signed = await signPrepared(generatedSigner, plan.transactionBase64);
        try {
          submitted = houseAction ? await submitSolanaHouseAction(store, identity, plan.id, signed) : await context.operations.submit({ identity, id: plan.id, signedTransactionBase64: signed });
          break;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Simulation bank changed; request a fresh review') throw error;
          const rejected = await context.operations.get(plan.id, identity);
          if (rejected.state !== 'prepared' || rejected.signature) throw error;
          console.log(JSON.stringify({ phase: 'pre-broadcast-bank-change-review-cancelled', operationId: plan.id, state: rejected.state, signatureAbsent: true }));
          if (houseAction) await cancelSolanaHouseReview(store, identity, plan.id);
          else await context.operations.cancel({ identity, id: plan.id });
          await delay(Math.min(1000 * (attempt + 1), 10_000));
          before = await snapshot();
          plan = await prepareWithFreshBank(prepareAgain);
        }
      }
      if (!submitted) throw new Error('No submitted operation; no replacement broadcast authorized.');
      let result = await context.operations.reconcile({ identity, id: plan.id });
      for (let attempt = 0; result.state === 'broadcast' && attempt < 60; attempt++) {
        await delay(2000);
        result = await context.operations.reconcile({ identity, id: plan.id });
      }
      if (result.state !== 'confirmed') throw new Error(`Operation ${plan.id} ${result.state}; signature ${submitted.signature}; reconcile the original operation, never replace it.`);
      const after = await snapshot();
      const record = { action, operationId: plan.id, review: plan.review, signature: submitted.signature, explorerUrl: `https://explorer.solana.com/tx/${submitted.signature}?cluster=devnet`, state: result.state, before: publicSnapshot(before), after: publicSnapshot(after), actualClaimedAtomic: ((after.position?.claimedTotal ?? 0n) - (before.position?.claimedTotal ?? 0n)).toString(), actualCashChangeAtomic: (after.cash - before.cash).toString(), userSignatureCount: 1, feePayer: context.sponsor.address };
      records.push(record);
      await save();
      console.log(JSON.stringify(record));
      return after;
    };
    const act = async (operation: string, amount?: string) => {
      const before = await snapshot();
      const prepare = async () => (await prepareSolanaHouseAction(store, identity, { houseId, operation, requestId: randomUUID(), ...(operation === 'buy' ? { cashAtomic: amount } : amount ? { quantity: amount } : {}) })).plan;
      return execute(await prepareWithFreshBank(prepare), operation, before, prepare, true);
    };
    const bought = await act('buy', '1000000');
    await act('stake', bought.walletUnits.toString());
    const beforeDeposit = await snapshot();
    const amount = '60480000';
    const depositReview = { network: 'solana-devnet', asset: manifest.cashMint, amountAtomic: amount, authority: wallet.address, source: beforeDeposit.cashAccount!, recipient: house.rewardVault, house: house.house, sourceKind: 3, description: 'Exactly 60.48 fictional tUSDC; streamed over seven real days, not instant rewards.' };
    const prepareDeposit = async () => context.operations.prepare({ identity, actor: address(wallet.address), walletId: wallet.id, kind: 'house-proof:deposit-rewards', requestId: randomUUID(), review: depositReview, instructions: [await depositRewardsInstruction({ authority: wallet.address, source: beforeDeposit.cashAccount!, house: house.house, programId: manifest.programId, amount, sourceKind: 3 })], expectedDeltas: [
      { account: beforeDeposit.cashAccount!, mint: manifest.cashMint, owner: wallet.address, direction: 'debit', minimumAtomic: amount, maximumAtomic: amount },
      { account: house.rewardVault, mint: manifest.cashMint, owner: house.house, direction: 'credit', minimumAtomic: amount, maximumAtomic: amount },
    ] });
    await execute(await prepareWithFreshBank(prepareDeposit), 'deposit-rewards', beforeDeposit, prepareDeposit);
    for (const operation of ['claim', 'reinvest']) {
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        const observed = await snapshot();
        const earned = observed.position ? pendingOwed(observed.house, observed.position, observed.nowSeconds) : 0n;
        if (earned >= 1000n) { ready = true; break; }
        await delay(2000);
      }
      if (!ready) throw new Error('Real streaming accrual is below 0.001 tUSDC after four minutes; no fake payout or clock warp used.');
      await act(operation);
    }
    const landlord = await generateKeyPairSigner();
    const beforeRent = await snapshot();
    const monthParts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    const month = `${monthParts.find(part => part.type === 'year')!.value}-${monthParts.find(part => part.type === 'month')!.value}`;
    const rent = await solanaRentInstructions({ month, tenant: wallet.address, landlord: landlord.address, sponsor: context.sponsor.address, mint: manifest.cashMint, house: house.house, rewardVault: house.rewardVault, programId: manifest.programId, rentMonthly: '1000000' });
    const rentReview = { network: 'solana-devnet', month, rentMonthlyAtomic: '1000000', landlordAtomic: rent.landlordRaw, houseAtomic: rent.buildingRaw, landlord: landlord.address, landlordAta: rent.landlordAta, house: house.house, rewardVault: house.rewardVault, source: rent.source, asset: manifest.cashMint, description: 'One user signature: exactly 0.8 fictional tUSDC to landlord and 0.2 to house reward vault (7-day stream). App rent builder fixture, not accepted-tenancy UX evidence.' };
    const prepareRentSplit = async () => context.operations.prepare({ identity, actor: address(wallet.address), walletId: wallet.id, kind: 'house-proof:rent-split', requestId: randomUUID(), review: rentReview, instructions: rent.instructions, expectedDeltas: rent.expectedDeltas });
    const rented = await execute(await prepareWithFreshBank(prepareRentSplit), 'rent-one-signature-80-20', beforeRent, prepareRentSplit);
    await act('unstake', rented.position!.staked.toString());
    console.log(JSON.stringify({ state: 'completed', runId, evidenceFile: evidencePath.pathname, signatures: records.length }));
  } else if (phase === '--prepare') {
    const before = await snapshot();
    const amount = process.env.SOLANA_HOUSE_RENT_AMOUNT_ATOMIC;
    let plan: PreparedSolanaOperation;
    let agreementId: string | undefined, stepId: string | undefined;
    if (argument === 'deposit-rewards') {
      if (!amount || !/^[1-9]\d{0,19}$/.test(amount) || BigInt(amount) > (1n << 64n) - 1n || BigInt(amount) > before.cash) throw new Error('Review a positive available u64 cash amount in SOLANA_HOUSE_RENT_AMOUNT_ATOMIC.');
      const review = { operation: argument, network: 'solana-devnet', genesisHash: manifest.genesisHash, asset: manifest.cashMint, amountAtomic: amount, payer: wallet.address, source: before.cashAccount!, recipient: house.rewardVault, house: house.house, sourceKind: 3, description: 'Deposit exactly this fictional tUSDC funding into the house reward vault; streamed to stakers over seven real days. No value or rights.' };
      plan = await context.operations.prepare({ identity, actor: address(wallet.address), walletId: wallet.id, kind: 'house-proof:deposit-rewards', requestId: randomUUID(), review, instructions: [await depositRewardsInstruction({ authority: wallet.address, source: before.cashAccount!, house: house.house, programId: manifest.programId, amount, sourceKind: 3 })], expectedDeltas: [
        { account: before.cashAccount!, mint: manifest.cashMint, owner: wallet.address, direction: 'debit', minimumAtomic: amount, maximumAtomic: amount },
        { account: house.rewardVault, mint: manifest.cashMint, owner: house.house, direction: 'credit', minimumAtomic: amount, maximumAtomic: amount },
      ] });
    } else if (argument === 'rent') {
      agreementId = process.env.SOLANA_HOUSE_RENT_AGREEMENT_ID;
      if (!agreementId) throw new Error('Provide an accepted active local tenancy via SOLANA_HOUSE_RENT_AGREEMENT_ID.');
      const view = await prepareRent(store, identity, agreementId);
      const payment = view?.payment;
      const step = payment?.steps[0];
      if (view?.network !== 'solana-devnet' || payment?.steps.length !== 1 || !step?.operationId || !step.solanaRequest || payment.state === 'confirmed') throw new Error('Expected one newly reviewed Solana rent transaction.');
      plan = await context.operations.get(step.operationId, identity);
      stepId = step.id;
    } else if (['buy', 'stake', 'claim', 'reinvest', 'unstake'].includes(argument)) {
      if (['buy', 'stake', 'unstake'].includes(argument) && (!amount || !/^[1-9]\d{0,19}$/.test(amount))) throw new Error('Supply the exact reviewed atomic amount.');
      const input = { houseId, operation: argument, requestId: randomUUID(), ...(argument === 'buy' ? { cashAtomic: amount } : ['stake', 'unstake'].includes(argument) ? { quantity: amount } : {}) };
      plan = (await prepareSolanaHouseAction(store, identity, input)).plan;
    } else throw new Error('Unknown proof action.');
    const proof: Proof = { id: plan.id, action: argument, subject: identity.subject, wallet: wallet.address, feePayer: plan.feePayer, review: plan.review, before: publicSnapshot(before), evidenceKind: fixtureWallet ? 'operator-fixture-app-services-not-Privy-UX' : 'verified-wallet-app-services-not-browser-UX', ...(agreementId ? { agreementId, stepId } : {}) };
    await store.create(key(plan.id), proof);
    console.log(JSON.stringify({ phase: 'review-before-user-signature', ...proof, network: 'solana-devnet', genesisHash: manifest.genesisHash, expiresAt: plan.expiresAt, transactionBase64: plan.transactionBase64, instruction: 'Read amounts, recipients and network above before signing these exact bytes. Then opt in with REVIEWED_ID and signed bytes; no message rebuilding.' }, null, 2));
  } else {
    const proof = await store.get<Proof>(key(argument));
    if (!proof || proof.subject !== identity.subject || proof.wallet !== wallet.address || proof.feePayer !== context.sponsor.address) throw new Error('Prepared proof identity/sponsor mismatch.');
    console.log(JSON.stringify({ phase: 'review-before-sponsor-signature-or-reconciliation', network: 'solana-devnet', genesisHash: manifest.genesisHash, ...proof }, null, 2));
    if (phase === '--submit') {
      if (process.env.SOLANA_HOUSE_RENT_REVIEWED_ID !== proof.id || !process.env.SOLANA_HOUSE_RENT_SIGNED_BASE64) throw new Error('Explicit exact-review acknowledgment and externally signed bytes are required.');
      const signed = process.env.SOLANA_HOUSE_RENT_SIGNED_BASE64;
      if (proof.action === 'rent') await submitRent(store, identity, proof.agreementId!, proof.stepId!, signed);
      else if (proof.action === 'deposit-rewards') await context.operations.submit({ identity, id: proof.id, signedTransactionBase64: signed });
      else await submitSolanaHouseAction(store, identity, proof.id, signed);
    }
    let result = await context.operations.reconcile({ identity, id: proof.id });
    for (let attempt = 0; result.state === 'broadcast' && attempt < 60; attempt++) {
      await delay(2000);
      result = await context.operations.reconcile({ identity, id: proof.id });
    }
    if (proof.action === 'rent') await readRent(store, identity, proof.agreementId!);
    if (result.state !== 'confirmed' || !result.signature) {
      console.log(JSON.stringify({ operationId: proof.id, ...result, instruction: 'Reconcile this ID again if pending; never replace an unresolved signature.' }));
      process.exitCode = 1;
    } else {
      const after = publicSnapshot(await snapshot());
      const record = { ...proof, state: result.state, signature: result.signature, explorerUrl: `https://explorer.solana.com/tx/${result.signature}?cluster=devnet`, recordedAt: new Date().toISOString(), after, actualClaimedAtomic: (BigInt(after.claimedTotalAtomic) - BigInt(proof.before.claimedTotalAtomic)).toString(), actualCashChangeAtomic: (BigInt(after.cashAtomic) - BigInt(proof.before.cashAtomic)).toString(), reconciliation: 'Canonical receipt and reviewed token deltas checked by shared app operation service; snapshots include real elapsed streaming accrual.' };
      let evidence: { network: string; genesisHash: string; programId: string; house: string; proofs: typeof record[] };
      try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; evidence = { network: 'solana-devnet', genesisHash: manifest.genesisHash, programId: manifest.programId, house: house.house, proofs: [] }; }
      if (evidence.genesisHash !== manifest.genesisHash || evidence.programId !== manifest.programId || evidence.house !== house.house) throw new Error('Existing evidence belongs to a different deployment.');
      if (!evidence.proofs.some(entry => entry.id === proof.id)) {
        evidence.proofs.push(record);
        await mkdir(dirname(evidencePath.pathname), { recursive: true });
        await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
      }
      console.log(JSON.stringify(record, null, 2));
    }
  }
} finally { await store.close(); }
