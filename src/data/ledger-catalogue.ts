import type { Area } from '../components/areas';
import type { RealityLevel } from './reality';
import type { SectionId } from './sections';

export type CapabilityStatus = 'planned' | 'prototype' | 'partly built' | 'illustration' | 'built';
export const STATUS_LABEL: Record<CapabilityStatus, string> = { planned: 'Planned', prototype: 'Prototype', 'partly built': 'Partly built', illustration: 'Illustration', built: 'Built' };
export interface Idea {
  id: string;
  topic: LedgerTopicId;
  destination?: { area: Area; section?: SectionId };
  title: string;
  how: string;
  enables: string;
  status: CapabilityStatus;
  needs?: string;
}

/** Single source for capability status, topic and the one place each capability is operated; mirrors docs/LEDGER_OF_LIFE.md and the ontology's roadmap items. */
export const IDEAS: Idea[] = [
  { id: 'today-cockpit', topic: 'identity', destination: { area: 'overview' }, status: 'built', title: 'Your ledger at a glance',
    how: 'A household-first overview connects identity, home, money, productive assets and public life. Real attention, followed projects and dated city news follow; each topic opens its working area.',
    enables: 'Understand what belongs in your ledger, what is connected and what you can do next.' },
  { id: 'city-news-feed', topic: 'places', destination: { area: 'places', section: 'city-news' }, status: 'partly built', title: 'City news & events',
    how: 'Published city feed files show attributed headlines, original links and publication dates in Places. Today previews three official press headlines; event times appear only when sourced.',
    enables: 'Read a dated local source once, not a copied article or an invented event date.',
    needs: 'Published official feeds for more cities.' },
  { id: 'regional-shared-topics', topic: 'places', destination: { area: 'places', section: 'regional-topics' }, status: 'partly built', title: 'In your region',
    how: 'Published Märkisch-Oderland source items group topics shared by municipalities. Your city’s items rank first; original links and separate stages remain visible. Interpretive summaries say “Not yet checked”.',
    enables: 'See where neighbouring municipalities work on similar topics without treating an agenda or proposal as an adopted policy.',
    needs: 'Reviewed interpretation and published regional coverage beyond Märkisch-Oderland.' },
  { id: 'timeline', topic: 'identity', destination: { area: 'me', section: 'life-timeline' }, status: 'partly built', title: 'Life timeline',
    how: 'Tenancies from this app appear automatically; earlier places you add yourself (labeled as your own statement); later a residence attestation from the EU wallet.',
    enables: 'Keep a private history when moving. Sharing a person-approved derived tenancy history remains planned, not available to landlords today.' },
  { id: 'roles', topic: 'identity', status: 'planned', title: 'Roles in every part of your life',
    how: 'Each context (tenancy, club, building, city) grants you a role; the EU wallet proves eligibility such as residence or age.',
    enables: 'One identity for tenant, landlord, club member and resident, and each context learns only what it needs.' },
  { id: 'service-charges', topic: 'home', destination: { area: 'home', section: 'home-tenancies' }, status: 'prototype', title: 'Real-time service charges',
    how: 'Example service-charge statement with a landlord-set test prepayment and optional live daily Home Assistant consumption; no escrow funding or payouts.',
    enables: 'See an illustrative running balance. It is not a legal annual statement or money movement.',
    needs: 'Real meter and invoice data before an actual service-charge balance can be calculated.' },
  { id: 'stock-deposit', topic: 'money', destination: { area: 'money', section: 'share-workflows' }, status: 'prototype', title: 'Share-backed deposit',
    how: 'A working Robinhood Chain testnet pledge uses isolated fake tTSLA with a simulated price: pledge 150 % of a new test deposit (125 % maintenance), inspect a price-drop top-up or protective sale, then a move-out claim and return of remaining shares. Existing legacy official-TSLA positions stay readable.',
    enables: 'Keep remaining test shares after a claim rather than treating the full pledge as rent paid.' },
  { id: 'borrow-against-shares', topic: 'money', destination: { area: 'money', section: 'share-workflows' }, status: 'prototype', title: 'Loan against shares',
    how: 'Works on Robinhood Chain testnet: borrow test USD up to 50 % of your test shares\' value, interest accrues per second, at 80 % the pool liquidates, and repaying returns your shares.',
    enables: 'See an independent test loan and its debt, repayment and liquidation risk without confusing it with the direct stock pledge.' },
  { id: 'local-investments', topic: 'money', destination: { area: 'money', section: 'local-investments' }, status: 'prototype', title: 'Local stakes in your own city',
    how: 'Buy distinct fictional housing-project or local-workshop units with your own wallet on Robinhood testnet. Actual test cash, token holdings and checked receipts stay separate from the building concept and possible city effects.',
    enables: 'Use personal or borrowed same-chain test cash to acquire a visible test stake without selling the pledged shares. These units grant no real company, cooperative or property rights.',
    needs: 'Verified issuers, legal rights, regulated arrangements and project evidence before any real investment or impact claim.' },
  { id: 'home-tokens', topic: 'home', destination: { area: 'money', section: 'local-investments' }, status: 'planned', title: 'Home shares towards owning a home',
    how: 'A future issuer could define a legal housing interest or down-payment credit. The separate test-investment example only transfers fictional issuer units; it does not grant those rights.',
    enables: 'Explore a possible renting-to-ownership path without presenting a test token as an apartment or land-register title.' },
  { id: 'devices', topic: 'devices', status: 'planned', title: 'Electric car and other devices',
    how: 'Charging and vehicle-to-grid income read like the solar and validator adapters.',
    enables: 'Everything your hardware earns in one total.' },
  { id: 'local-ai', topic: 'devices', destination: { area: 'money', section: 'local-ai' }, status: 'prototype', title: 'Local AI & GPU hosting',
    how: 'A configured Ollama node answers real questions. Personal access uses a finite x402 authorization and a confirmed same-chain payment after successful inference; a public library desk uses the same node without a wallet.',
    enables: 'Use local GPU capacity, inspect measured work and settled receipts, and compare paid or free access with editable host-cost assumptions.',
    needs: 'Reliable operating capacity and real customer demand before treating an earnings scenario as a business forecast.' },
  { id: 'budget', topic: 'places', destination: { area: 'places', section: 'city-system' }, status: 'partly built', title: 'Where the money goes',
    how: 'Places links Strausberg’s 2025/26 ordinance and planned investment outlays of €17,941,270 (2025) and €12,609,320 (2026). The detailed plan is offered for inspection. The independent municipal-balance scenario is hypothetical, not an actual spending or tax breakdown.',
    enables: 'Distinguish an adopted headline plan from money spent or an individual tax receipt.',
    needs: 'The complete city budget plan and verified line items before a spending breakdown can be shown.' },
  { id: 'scales', topic: 'places', destination: { area: 'places', section: 'personal-map' }, status: 'partly built', title: 'From your street to the world',
    how: 'The private personal map now matches city-wide published signals against on-device home/work pins in a neighbourhood ring and approximate straight commute corridor. Places still links district → state → Germany → EU portals; those wider levels are not live feeds.',
    enables: 'Start with what may affect your neighbourhood and city without disclosing your exact home or work to the server.',
    needs: 'Reviewed coverage across more cities and district/state/world levels.' },
  { id: 'measurable', topic: 'places', destination: { area: 'places', section: 'city-system' }, status: 'partly built', title: 'A measurable city',
    how: 'Places compares 251 s before with 235 s during Münster’s 2021 bus-priority trial on the same full route, sourced to an official GPS evaluation; nearby DWD weather and citizen PM readings remain separate context.',
    enables: 'Inspect a real historical before/during measurement without mistaking it for a proven lane effect or a calibrated city-wide sensor layer.',
    needs: 'Comparable longer-term or controlled observations to attribute benefits; verified environmental coverage and reviewed interpretation for broader city outcomes.' },
  { id: 'decisions', topic: 'places', destination: { area: 'places', section: 'public-decisions' }, status: 'partly built', title: 'Council papers & meetings',
    how: 'Strausberg ALLRIS meeting calendar and document search are linked; no working public OParl endpoint was confirmed and no agendas are imported.',
    enables: 'Reach the official source yourself, without presenting unverified meeting records as a feed.',
    needs: 'A structured meeting feed (OParl or reviewed atlas/CCF data) for read-only meetings.' },
  { id: 'welcome', topic: 'places', destination: { area: 'places', section: 'community-discovery' }, status: 'partly built', title: 'Welcome to your new city',
    how: 'Named OSM clubs and sports facilities are read-only, grouped by type and linked to OSM; Strausberg city and district directories are linked. Welcome vouchers can be illustrated without claiming a real offer.',
    enables: 'Find nearby activities now and explore a clearly simulated welcome voucher next.',
    needs: 'City partners for any real voucher redemption, registration help or consent-based matching.' },
  { id: 'bank-accounts', topic: 'money', status: 'planned', title: 'Bank accounts in the same ledger',
    how: 'A future authorized bank-data connection could place cash accounts beside wallet holdings. No bank account, transaction feed or payment authority is connected today.',
    enables: 'A broader household view without treating test-network balances as bank money.',
    needs: 'An authorized banking provider, a defined data/consent contract and revocation before any real account connection.' },
];

export type LedgerTopicId = 'identity' | 'home' | 'money' | 'devices' | 'places';
export type AdapterConnection = 'account' | 'eudi' | 'tenancy' | 'solana' | 'robinhood' | 'homeAssistant' | 'validator' | 'city' | 'local' | 'host' | 'future';
export type AdapterDirection = 'account' | 'read-only' | 'signed' | 'device-local' | 'illustration';
export type AdapterAction =
  | { kind: 'area'; area: Area; section?: SectionId; label: string }
  | { kind: 'idea'; idea: string; label: string }
  | { kind: 'share'; choice: 'deposit' | 'borrow'; label: string }
  | { kind: 'scenario'; label: string };
export type AdapterEffort = 'automatic' | 'one tap' | 'few minutes' | 'needs a device or service' | 'not available yet';
/**
 * Plain-language facts about one adapter, each checked against the code that implements it
 * (see docs/INFORMATION_ARCHITECTURE.md, "Explaining an adapter"). Say what is true, including what
 * the operator can see and what disconnecting does not undo. A roadmap adapter says it does nothing yet.
 */
export interface AdapterExplanation {
  /** What it adds to your ledger, in one sentence a first-time person understands. */
  brings: string;
  /** What is read, from where, and how often. */
  reads: string;
  /** What this app stores about you, and where. States whether a secret ever returns to the browser. */
  keeps: string;
  /** Who can see it: you, the parties to an agreement, the operator, the public chain. */
  visibility: string;
  /** What has to exist first, including things only the operator controls. */
  needs: string;
  /** How to stop it, and what stopping does not undo. */
  disconnect: string;
  effort: AdapterEffort;
  reality: RealityLevel;
  /** One thing to keep in mind when reading its numbers or status. */
  caveat?: string;
}
export interface LedgerAdapter {
  id: string;
  topic: LedgerTopicId;
  name: string;
  source: string;
  environment: string;
  maturity: CapabilityStatus;
  connection: AdapterConnection;
  direction: AdapterDirection;
  explain: AdapterExplanation;
  capabilities: string[];
  action: AdapterAction;
  secondaryAction?: AdapterAction;
  settings?: SectionId;
  /** Part of Today's getting-started guide. Lower `order` comes first. */
  setup?: { order: number; title: string; optional?: boolean };
}
export const LEDGER_TOPICS: { id: LedgerTopicId; name: string; question: string; area: Area }[] = [
  { id: 'identity', name: 'Identity & life', question: 'Who I am, my roles and my history', area: 'me' },
  { id: 'home', name: 'Home & living', question: 'My tenancy, deposit and running costs', area: 'home' },
  { id: 'money', name: 'Money & ownership', question: 'What I hold, earn, lock and owe', area: 'money' },
  { id: 'devices', name: 'Energy & devices', question: 'Things I run and what they produce', area: 'money' },
  { id: 'places', name: 'Places & participation', question: 'What changes around me and where I can act', area: 'places' },
];

/** One catalogue for the ledger overview, connection management and capability map.
 * A configured connection is not a healthy reading, and a wallet link is not a funded position.
 * Monetary observations remain with the existing account-bound Home/Money readers.
 */
export const LEDGER_ADAPTERS: LedgerAdapter[] = [
  { id: 'account', topic: 'identity', name: 'Passkey & own wallets', setup: { order: 1, title: 'Sign in' },
    source: 'Privy account and user-owned wallet records', environment: 'Privy development app · test networks', maturity: 'built',
    connection: 'account', direction: 'account', capabilities: ['roles'],
    action: { kind: 'area', area: 'me', section: 'account-settings', label: 'Account settings' },
    explain: {
      brings: 'One passkey sign-in and two wallets, one for Solana and one for Robinhood Chain, that only you can sign with. You approve every deposit or trade yourself.',
      reads: 'The server checks your sign-in token with Privy, then reads your Privy user and wallet records to confirm the wallets belong to you alone.',
      keeps: 'Privy holds your passkey, email and wallet keys. This app keeps a recovery record (which wallets are yours and a proof you can sign with them) and a hashed browser token. No key or secret is sent to your browser.',
      visibility: 'Only you see your settings. People you share an agreement with see your Privy id and wallet addresses. No landlord, arbitrator or server can sign for your wallets.',
      needs: 'A browser with passkey support on HTTPS or localhost, and an email address for the backup code. The full recovery check also needs a second browser (skipped in the demo).',
      disconnect: 'You can sign out. There is no control yet to remove a passkey, email or wallet, or to delete the account.',
      effort: 'few minutes', reality: 'testnet_real',
      caveat: 'These are real wallets with real keys, but this app only uses them on test networks. Do not send real funds to them.',
    } },
  { id: 'eudi', topic: 'identity', name: 'EU identity wallet', setup: { order: 4, title: 'Prove you are an adult', optional: true },
    source: 'EU Digital Identity test verifier', environment: 'EU test wallet', maturity: 'built',
    connection: 'eudi', direction: 'account', capabilities: ['roles', 'timeline'],
    action: { kind: 'area', area: 'me', section: 'identity-eudi', label: 'Manage identity proof' },
    explain: {
      brings: 'A test-only proof that you are 18 or older, kept as a badge. Today it only lets Places use the city from your EU wallet; no landlord or listing asks for it.',
      reads: 'Your birth date, and your city only if you tick that box, from the EU reference wallet on your phone, through the EU test verifier.',
      keeps: 'Only “adult” and, if you chose it, your city, plus who issued the credential and when. The birth date is used for the age check and then dropped.',
      visibility: 'Only you can read it here. The EU test verifier sees your birth date first. This app does not share the proof with landlords, agreements or any chain. A shared city is used for Places lookups.',
      needs: 'The EU reference wallet app with a test identity (PID) on a phone, and the EU test verifier being reachable.',
      disconnect: '“Forget” erases the proof stored here. It does not delete the credential in your wallet, the verifier’s copy or lookups already made.',
      effort: 'needs a device or service', reality: 'testnet_real',
    } },
  { id: 'timeline', topic: 'identity', name: 'Life timeline & contexts',
    source: 'Your agreement records and self-declared history', environment: 'Your account · self-declared places', maturity: 'partly built',
    connection: 'local', direction: 'account', capabilities: ['timeline', 'roles'],
    action: { kind: 'area', area: 'me', section: 'life-timeline', label: 'Open my timeline' },
    explain: {
      brings: 'A private history of where you have lived. Tenancies from this app appear by themselves; earlier places you add are marked as your own statement.',
      reads: 'Your saved places, and the tenancies you belong to on Solana devnet.',
      keeps: 'Your places (city, dates and a short note, up to 30) in this app’s database. Tenancy rows are worked out when you open the page and are not stored.',
      visibility: 'Only you. It is never shared with landlords or put on a chain, but the app’s operator can read the database.',
      needs: 'A signed-in account. Automatic rows need a tenancy created in this app on Solana.',
      disconnect: '“Remove” deletes one place. There is no control to clear the whole timeline, and removing a place never touches an agreement.',
      effort: 'automatic', reality: 'prototype',
      caveat: 'Places you add are your own statement, not a residence attestation.',
    } },
  { id: 'tenancy', topic: 'home', name: 'Tenancy & earning deposit', setup: { order: 3, title: 'Find or add a home' },
    source: 'Account-bound agreements and Solana escrow observations', environment: 'Solana devnet · simulated earnings', maturity: 'built',
    connection: 'tenancy', direction: 'signed', capabilities: ['today-cockpit'],
    action: { kind: 'area', area: 'home', section: 'home-tenancies', label: 'Open my home' },
    explain: {
      brings: 'An agreement between tenant, landlord and a neutral arbitrator, with the deposit held in a Solana test escrow and one guided next step from signing to move-out payout.',
      reads: 'Your agreements and listings in this app, and the escrow’s state on Solana devnet.',
      keeps: 'Listing and agreement details, both parties’ wallet addresses, acceptance digests, hashed invitations and up to 100 evidence notes, in this app’s database. Signed transaction bytes are kept on the server and never shown in the browser.',
      visibility: 'Only the parties to an agreement can read it, and they see each other’s Privy id, wallet and evidence notes. Open listings are visible to every signed-in person; only the landlord sees applicants. Chain state is public.',
      needs: 'A finished account, a counterpart and an arbitrator you invite by link, and test USDC from Circle’s faucet. The operator must have set up the devnet escrow.',
      disconnect: 'A landlord can close a listing and an applicant can withdraw an application, but only before a tenant is chosen. After that there is no cancel: a tenancy ends through move-out, settlement and payout, and chain records are permanent.',
      effort: 'needs a device or service', reality: 'testnet_simulated',
      caveat: 'Deposit earnings are simulated on devnet. Once a settlement is final, payouts go to each party’s own account and are run by the app’s sponsor.',
    } },
  { id: 'service-charges', topic: 'home', name: 'Service charges & meters',
    source: 'Tenancy example costs and optional daily Home Assistant readings', environment: 'Prototype statement', maturity: 'prototype',
    connection: 'tenancy', direction: 'account', capabilities: ['service-charges'],
    action: { kind: 'area', area: 'home', section: 'home-tenancies', label: 'View service charges' },
    explain: {
      brings: 'A clearly labelled example monthly utilities statement for a living tenancy, using a test prepayment the landlord types in and, optionally, your own Home Assistant’s electricity readings.',
      reads: 'The agreement, the prepayment, and today’s consumption from your own Home Assistant if connected. Building costs and allocation keys are fixed examples.',
      keeps: 'Only the landlord’s test prepayment, in this app’s database. Readings are not stored.',
      visibility: 'Tenant, landlord and arbitrator can all open it; only the landlord edits the prepayment. The consumption shown is the viewer’s own, so each party can see different numbers.',
      needs: 'A funded, active Solana tenancy. A live reading also needs your Home Assistant to be reachable from the app server.',
      disconnect: 'Removing Home Assistant in Me stops the live reading (it does not revoke the token there). There is no control to delete the prepayment record.',
      effort: 'automatic', reality: 'prototype',
      caveat: 'An example, not a legal annual statement. It does not move escrow money.',
    } },
  { id: 'home-equity', topic: 'home', name: 'Home ownership path',
    source: 'Home-equity capability in the product roadmap', environment: 'Planned', maturity: 'planned',
    connection: 'future', direction: 'illustration', capabilities: ['home-tokens'],
    action: { kind: 'idea', idea: 'home-tokens', label: 'View ownership plan' },
    explain: {
      brings: 'Nothing yet. A planned path where housing shares or down-payment credit could one day help you buy a home.',
      reads: 'Nothing. No data connection exists.',
      keeps: 'Nothing.',
      visibility: 'No data flows, so nothing is seen.',
      needs: 'A real issuer, a legal wrapper and a property transaction. A token cannot carry a German land-register title.',
      disconnect: 'Nothing to disconnect.',
      effort: 'not available yet', reality: 'roadmap',
      caveat: 'No property shares or land-register ownership are offered. The fictional test units in Local stakes are not this.',
    } },
  { id: 'solana', topic: 'money', name: 'Solana holdings & investing',
    source: 'Your Solana wallet, program receipts and Jupiter reference prices', environment: 'Test tokens · devnet', maturity: 'built',
    connection: 'solana', direction: 'signed', capabilities: ['today-cockpit'],
    action: { kind: 'area', area: 'money', section: 'solana-holding', label: 'Open Solana holdings' },
    explain: {
      brings: 'Your own Solana test wallet: see test USDC and tSPYx, a no-value copy of an ETF token, and buy tSPYx with test USDC, separate from your rental deposit.',
      reads: 'Your test-USDC and tSPYx balances from Solana devnet, and the live SPYx price from Jupiter (only the token, never your wallet). Refreshed every 60 seconds while Today or Money is open.',
      keeps: 'A record of each buy you prepare (wallet, quote, signed transaction) in this app’s database. Balances live on the public chain. No keys.',
      visibility: 'Only you in this app. Balances and transactions on devnet are public. Jupiter sees only the token it prices; the test market maker co-signs and pays the fee.',
      needs: 'A linked wallet (automatic) and test USDC from Circle’s faucet. Buying also needs an operator-run test market, which is off on hosted deployments.',
      disconnect: 'Nothing to unlink, and there is no sell button. The tokens stay in your wallet.',
      effort: 'needs a device or service', reality: 'testnet_real',
      caveat: 'Cash, shares and locked deposit entitlements are counted separately.',
    } },
  { id: 'robinhood', topic: 'money', name: 'Robinhood Chain shares',
    source: 'Your Robinhood Chain testnet wallet and reference-price observations', environment: 'Test network', maturity: 'built',
    connection: 'robinhood', direction: 'signed', capabilities: ['today-cockpit'],
    action: { kind: 'area', area: 'money', section: 'official-shares', label: 'Open Robinhood holdings' },
    explain: {
      brings: 'See your test USD, Robinhood’s official test TSLA and test ETH for fees. Buying test TSLA here is available only when operator tools are on.',
      reads: 'Your balances on Robinhood Chain testnet and the live TSLA price from Jupiter. Refreshed every 60 seconds while Today or Money is open.',
      keeps: 'No holdings are stored here. A test-cash “earn” job is recorded once per wallet. No keys.',
      visibility: 'Only you in this app; on-chain data is public. The test USD is this project’s own freely mintable token.',
      needs: 'A linked wallet: use Get test dollars for tUSDG and Robinhood’s faucet for test ETH and official test TSLA. Buying here also needs operator tools on.',
      disconnect: 'Nothing to unlink or sell in the app. Signing out leaves the test tokens where they are.',
      effort: 'needs a device or service', reality: 'testnet_real',
      caveat: 'A separate network and wallet from Solana. No bridge between them exists.',
    } },
  { id: 'share-finance', topic: 'money', name: 'Share-backed deposit & loan',
    source: 'Test CollateralEscrow and TestLendingPool positions', environment: 'Operator-run test market · simulated oracle', maturity: 'prototype',
    connection: 'robinhood', direction: 'signed', capabilities: ['stock-deposit', 'borrow-against-shares'],
    action: { kind: 'share', choice: 'deposit', label: 'Share-backed deposit' },
    secondaryAction: { kind: 'share', choice: 'borrow', label: 'Loan against shares' },
    explain: {
      brings: 'On Robinhood’s test network you can pledge fake test shares as a deposit, or borrow test USD against them, and watch price drops, top-ups, claims and liquidation with no real money.',
      reads: 'Your fake-share and test-USD balances, the simulated price for your wallet, and your escrow and loan positions.',
      keeps: 'Your market’s contract addresses, transaction hashes and earnings record in this app’s database. Your signed transactions are relayed only if they go to your own workflow contracts.',
      visibility: 'Only you in this app; positions are public on the test chain. The “landlord”, arbitrator and lender are operator-held test keys, not people.',
      needs: 'A Robinhood wallet with test ETH and an operator-run test environment: starting a market, price moves and liquidation are signed by the operator.',
      disconnect: 'Repaying or withdrawing returns your shares. Nothing deletes the market or its record, and operator-set prices cannot be undone.',
      effort: 'needs a device or service', reality: 'testnet_simulated',
      caveat: 'Collateral and open debt are separate. A direct share pledge is not the loan.',
    } },
  { id: 'bank-accounts', topic: 'money', name: 'Bank accounts & cash flow',
    source: 'No banking provider is connected', environment: 'Planned', maturity: 'planned',
    connection: 'future', direction: 'illustration', capabilities: ['bank-accounts'],
    action: { kind: 'idea', idea: 'bank-accounts', label: 'View banking roadmap' },
    explain: {
      brings: 'Nothing yet. A future view of your real bank balances beside your wallets, only if you authorize a bank-data provider.',
      reads: 'Nothing. No provider is connected.',
      keeps: 'Nothing.',
      visibility: 'No data flows, so nothing is seen.',
      needs: 'An authorized banking provider, a data and consent contract, and a way to revoke access.',
      disconnect: 'Nothing to disconnect.',
      effort: 'not available yet', reality: 'roadmap',
      caveat: 'Your test wallets are not bank money. No bank balance, transaction import or payment authority exists.',
    } },
  { id: 'local-capital', topic: 'money', name: 'Local stakes (test units)',
    source: 'Robinhood testnet unit/market contracts and verified purchase receipts; physical effects remain a scenario', environment: 'Test tokens · fictional issuers', maturity: 'prototype',
    connection: 'robinhood', direction: 'signed', capabilities: ['local-investments', 'home-tokens'],
    action: { kind: 'area', area: 'money', section: 'local-investments', label: 'Open local stakes' },
    secondaryAction: { kind: 'scenario', label: 'Explore the city scenario' },
    explain: {
      brings: 'Buy fictional test units of a made-up housing project (tHOME) or workshop (tWORK) in Strausberg with your own test USD. A demo of local investing with no real rights or value.',
      reads: 'Your tUSDG, test ETH and unit balances on Robinhood testnet, checked against a committed contract manifest.',
      keeps: 'Your orders, the exact transaction you signed and its hashes, in this app’s database, saved before it is sent. Each order is capped at 100 test USD.',
      visibility: 'Only you in this app. Your purchases and balances are public on the test chain. The issuers are fictional, so no real party sees anything.',
      needs: 'One Robinhood wallet: use Get test dollars for tUSDG and Robinhood’s faucet for test ETH. The operator’s contracts must be deployed.',
      disconnect: 'You can cancel a review before signing. There is no sell or redeem: a purchase is permanent and the units stay in your wallet.',
      effort: 'needs a device or service', reality: 'testnet_simulated',
      caveat: 'No real company, cooperative, property right, resale value or city benefit is implied.',
    } },
  { id: 'homeAssistant', topic: 'devices', name: 'Home solar (Home Assistant)', setup: { order: 5, title: 'Connect your solar panels', optional: true },
    source: 'Your Home Assistant, read by the app server', environment: 'Your Home Assistant · live readings', maturity: 'built',
    connection: 'homeAssistant', direction: 'read-only', capabilities: ['service-charges', 'devices'],
    action: { kind: 'area', area: 'money', section: 'solar-reading', label: 'View home solar' },
    settings: 'adapter-home-assistant',
    explain: {
      brings: 'Shows how much electricity your solar panels made today and roughly what it is worth, by reading your own Home Assistant.',
      reads: 'The app server asks your Home Assistant for the state of every entity, keeps only the solar, savings and daily-consumption sensors, and repeats this every 60 seconds while Today or Money is open.',
      keeps: 'Your Home Assistant address, access token, sensor and price per kWh in this app’s database as plain data. The token is never sent back to your browser. Readings are not stored.',
      visibility: 'Only you see the readings. The app’s operator can read the stored token and use it against your Home Assistant.',
      needs: 'A locally run build on your own network, or a production host whose operator explicitly enables Home Assistant pull, plus a reachable Home Assistant and a long-lived access token. A hosted build does not connect by default. The token acts with the permissions of the user who made it and is not limited to reading.',
      disconnect: '“Remove Home Assistant” deletes the stored address, token, sensor and tariff here, including on a host where connections are disabled. It does not revoke the token: delete it in Home Assistant under Profile → Security.',
      effort: 'needs a device or service', reality: 'read_only_live',
      caveat: 'The euro value is an estimate from your price per kWh (or a savings sensor), not a payment.',
    } },
  { id: 'validator', topic: 'devices', name: 'Validator activity', setup: { order: 6, title: 'Follow a validator', optional: true },
    source: 'Solana, Ethereum or Gnosis public validator APIs', environment: 'Real mainnet data · read-only', maturity: 'built',
    connection: 'validator', direction: 'read-only', capabilities: ['devices'],
    action: { kind: 'area', area: 'money', section: 'validator-reading', label: 'View validator reading' },
    settings: 'adapter-validator',
    explain: {
      brings: 'Shows the stake, status and recent rewards of an Ethereum, Gnosis or Solana validator you run or follow, from public blockchain data.',
      reads: 'The app server asks public Solana or PublicNode endpoints about the validator you named, every 60 seconds while Today or Money is open. Rewards are an approximation, not a statement.',
      keeps: 'The chain and public validator ID in this app’s database. Readings are not stored. There is no secret.',
      visibility: 'You see it. The app’s operator sees the saved ID, and the public endpoints see it in requests from the server, not your identity.',
      needs: 'A Solana vote account, or an Ethereum or Gnosis validator index or key, that exists on mainnet.',
      disconnect: '“Remove validator” deletes the saved ID. There is nothing to revoke and nothing changes on a chain.',
      effort: 'few minutes', reality: 'read_only_live',
      caveat: 'Naming a validator does not prove you own its stake. This reads real mainnet data, unlike the test tokens elsewhere in Money.',
    } },
  { id: 'local-ai', topic: 'devices', name: 'Local AI & GPU hosting',
    source: 'Configured Ollama model, measured inference usage and confirmed x402 receipts', environment: 'Operator’s local model · test-token payments', maturity: 'prototype',
    connection: 'host', direction: 'signed', capabilities: ['local-ai', 'devices'],
    action: { kind: 'area', area: 'money', section: 'local-ai', label: 'Open local AI' },
    explain: {
      brings: 'Ask an AI that runs on the host’s own graphics card: free at a public library desk, or for 0.01 test tokens per completed answer.',
      reads: 'Your question (up to 2,000 characters) goes to the operator’s local model host. Paid mode also reads Robinhood testnet for your balance, allowance and receipts.',
      keeps: 'Your question and its answer stay in this app’s database only while needed to finish and deliver the answer, then are removed about 10 minutes later (the host can change that). Usage counts, timings and payment receipts stay. No question goes to a cloud model.',
      visibility: 'Paid answers are visible to your account, free ones only to that visitor session. While a question is kept, the operator can read it and its answer, and the model host sees each question in clear while it runs. Anyone can see the node’s status and total usage.',
      needs: 'The operator’s model host running and reachable, and the free desk switched on. Paid answers also need a Robinhood Chain wallet, at least 0.01 test USD (tUSDG) and a one-time approval that costs test ETH.',
      disconnect: '“Finish & clear this desk” ends the free session and removes that visitor’s saved questions and answers now. Payment receipts stay, and nothing lowers a payment allowance you already approved.',
      effort: 'few minutes', reality: 'prototype',
      caveat: 'AI answers can be wrong, so check important facts. Do not enter private information on a shared desk.',
    } },
  { id: 'ev', topic: 'devices', name: 'Electric car & connected devices',
    source: 'A dependable, authorized device source is still required', environment: 'Planned', maturity: 'planned',
    connection: 'future', direction: 'illustration', capabilities: ['devices'],
    action: { kind: 'idea', idea: 'devices', label: 'View device roadmap' },
    explain: {
      brings: 'Nothing yet. A future connection could show what an electric car earns from smart charging or feeding power back to the grid.',
      reads: 'Nothing. No car, charger or grid connection exists.',
      keeps: 'Nothing.',
      visibility: 'No data flows, so nothing is seen.',
      needs: 'A dependable, authorized device source. None is chosen yet.',
      disconnect: 'Nothing to disconnect.',
      effort: 'not available yet', reality: 'roadmap',
      caveat: 'No vehicle connection, income or tokenized device position is shown or invented.',
    } },
  { id: 'city', topic: 'places', name: 'City knowledge & projects', setup: { order: 2, title: 'Choose your city' },
    source: 'Stadtstack, municipal publications and source-attributed city records', environment: 'Dated snapshot · eight pilot cities', maturity: 'partly built',
    connection: 'city', direction: 'read-only', capabilities: ['city-news-feed', 'regional-shared-topics', 'scales', 'decisions'],
    action: { kind: 'area', area: 'places', section: 'project-browser', label: 'Explore & follow projects' },
    explain: {
      brings: 'Adds your city’s published news, events, planning projects and council papers to your ledger, and lets you follow a project to see what changes.',
      reads: 'Published city files, a dated snapshot that is refreshed only when the collector is run, and the project atlas when it is reachable. Your browser reads them when you open a view.',
      keeps: 'Your chosen city, in this app’s database. Follows, home and work pins, interests and visit baselines stay in this browser only.',
      visibility: 'The app’s operator sees your chosen city and which city and signal IDs you request. Map tiles come straight from OpenFreeMap, which sees the area you view and your IP address, never your saved pins.',
      needs: 'A city name. Data exists for eight pilot cities: Köln, Münster, Wuppertal, Castrop-Rauxel, Düsseldorf, Dresden, Freiburg and Strausberg.',
      disconnect: 'Unfollow a project, remove a pin, or pick another city. A chosen city cannot be cleared, and signing out does not clear this browser’s follows or pins.',
      effort: 'one tap', reality: 'read_only_live',
      caveat: 'A snapshot, not a complete inventory. “Not yet checked” means no human has reviewed the item.',
    } },
  { id: 'civic-outcomes', topic: 'places', name: 'Budgets & measured outcomes',
    source: 'Hand-researched cases citing published ordinances, project records and official evaluation reports', environment: 'Six cases · three cities', maturity: 'partly built',
    connection: 'city', direction: 'read-only', capabilities: ['budget', 'measurable'],
    action: { kind: 'area', area: 'places', section: 'city-system', label: 'Inspect project evidence' },
    explain: {
      brings: 'For a few researched projects, shows what was planned, what was reported spent or delivered and what was measured, kept apart so a plan is not mistaken for a result.',
      reads: 'Nothing live. Six hand-written cases with source links: four in Strausberg, one in Münster and one in Rüdersdorf, last checked on 27 and 28 September 2026.',
      keeps: 'Nothing about you, except an optional follow bookmark kept in this browser.',
      visibility: 'The evidence is public. Your follows stay on your device.',
      needs: 'A chosen city that has cases. The other pilot cities have none yet.',
      disconnect: 'Nothing to connect. Unfollowing removes the bookmark from this browser.',
      effort: 'automatic', reality: 'read_only_live',
      caveat: 'Historical observations are not causal success scores. Missing costs, outcomes and geometry stay unknown.',
    } },
  { id: 'environment', topic: 'places', name: 'Weather & local environment',
    source: 'DWD via Bright Sky and sensor.community', environment: 'Read-only observations · German cities', maturity: 'built',
    connection: 'city', direction: 'read-only', capabilities: ['measurable'],
    action: { kind: 'area', area: 'places', section: 'local-readings', label: 'View nearby readings' },
    explain: {
      brings: 'Shows the current temperature from the German weather service and readings from community air-quality sensors near your city’s centre.',
      reads: 'The app server finds your city’s centre, then asks Bright Sky (German weather service data) and sensor.community for readings within 5 km. Results are cached for 10 minutes.',
      keeps: 'Nothing about you. Weather and sensor results are cached on the server by city.',
      visibility: 'The data services see your city name or centre coordinates from the server’s address, never your account or pins.',
      needs: 'A German city that OpenStreetMap can locate, and at least one outdoor sensor within 5 km for air quality.',
      disconnect: 'Nothing to disconnect. Choose another city to change the location.',
      effort: 'automatic', reality: 'read_only_live',
      caveat: 'Nearby readings are not calibrated city-wide pollution or project impact.',
    } },
  { id: 'community', topic: 'places', name: 'Community & newcomer welcome',
    source: 'OSM leisure places and researched official directories', environment: 'Discovery live · welcome offers planned', maturity: 'partly built',
    connection: 'city', direction: 'read-only', capabilities: ['welcome', 'roles'],
    action: { kind: 'area', area: 'places', section: 'community-discovery', label: 'Discover local activities' },
    explain: {
      brings: 'Lists sports facilities in your city and links official club directories, so a newcomer can find somewhere to join.',
      reads: 'The app server asks public OpenStreetMap servers (Overpass) for sports facilities in your city that have no club or sport tag, cached for 24 hours. Official directory links exist for Strausberg only.',
      keeps: 'Nothing about you.',
      visibility: 'The OpenStreetMap servers receive your city name from the app server, not your identity or pins. Your interests stay on your device.',
      needs: 'A city that OpenStreetMap lists by that name.',
      disconnect: 'Nothing to disconnect.',
      effort: 'automatic', reality: 'read_only_live',
      caveat: 'A directory is not membership. No welcome voucher, registration or partner offer exists.',
    } },
];
