import type { Area } from '../components/areas';
import type { RealityLevel } from './reality';
import type { SectionId } from './sections';

export type CapabilityStatus = 'planned' | 'prototype' | 'partly built' | 'illustration' | 'built';
export const STATUS_LABEL: Record<CapabilityStatus, string> = { planned: 'Planned', prototype: 'Prototype', 'partly built': 'Partly built', illustration: 'Illustration', built: 'Built' };
export const AVAILABILITY_LABELS = ['Available on this site', 'Needs a local setup', 'Planned'] as const;
export type CapabilityAvailability = typeof AVAILABILITY_LABELS[number];
export interface Idea {
  id: string;
  topic: LedgerTopicId;
  destination?: { area: Area; section?: SectionId };
  title: string;
  how: string;
  enables: string;
  status: CapabilityStatus;
  availability: CapabilityAvailability;
  needs?: string;
}

/** Single source for capability status, topic and the one place each capability is operated; mirrors docs/LEDGER_OF_LIFE.md and the ontology's roadmap items. */
export const IDEAS: Idea[] = [
  { id: 'today-cockpit', availability: 'Available on this site', topic: 'identity', destination: { area: 'overview' }, status: 'built', title: 'Your ledger at a glance',
    how: 'A household-first overview connects identity, home, money, productive assets and public life. Real attention, followed projects and dated city news follow; each topic opens its working area.',
    enables: 'Understand what belongs in your ledger, what is connected and what you can do next.' },
  { id: 'city-news-feed', availability: 'Available on this site', topic: 'places', destination: { area: 'places', section: 'city-news' }, status: 'built', title: 'City news & events',
    how: 'Dated published snapshots show attributed headlines, original links, publication dates and sourced event times in Places. Köln uses koeln.de events, not city press; cities without a published feed say so. Today previews official press where available.',
    enables: 'Read a dated local source once, not a copied article or an invented event date.',
    needs: 'Published official feeds for more cities.' },
  { id: 'regional-shared-topics', availability: 'Available on this site', topic: 'places', destination: { area: 'places', section: 'regional-topics' }, status: 'built', title: 'In your region',
    how: 'Published Märkisch-Oderland source items group topics shared by municipalities. Your city’s items rank first; original links and separate stages remain visible. Interpretive summaries say “Not yet checked”.',
    enables: 'See where neighbouring municipalities work on similar topics without treating an agenda or proposal as an adopted policy.',
    needs: 'Reviewed interpretation and published regional coverage beyond Märkisch-Oderland.' },
  { id: 'timeline', availability: 'Available on this site', topic: 'identity', destination: { area: 'me', section: 'life-timeline' }, status: 'partly built', title: 'Life timeline',
    how: 'Tenancies from this app appear automatically; earlier places you add yourself (labeled as your own statement); later a residence attestation from the EU wallet.',
    enables: 'Keep a private history when moving. Sharing a person-approved derived tenancy history remains planned, not available to landlords today.' },
  { id: 'roles', availability: 'Planned', topic: 'identity', status: 'planned', title: 'Roles in every part of your life',
    how: 'Each context (tenancy, club, building, city) grants you a role; the EU wallet proves eligibility such as residence or age.',
    enables: 'One identity for tenant, landlord, club member and resident, and each context learns only what it needs.' },
  { id: 'rental-deposit', availability: 'Available on this site', topic: 'home', destination: { area: 'home', section: 'deposit-options' }, status: 'built', title: 'Rent a home with a deposit in escrow',
    how: 'Listing, application, agreement with a neutral arbitrator, a Solana devnet cash escrow for site-minted test USDC (tUSDC; older tenancies use Circle devnet USDC), move-out claim and payouts. The agreement covers deposit terms, not rent or dates. The site pays labelled simulated yield in tUSDC at 5 % simple annual interest by default, from confirmed funding until settlement. Earnings belong to the tenant; the release policy determines whether they can be claimed during the tenancy.',
    enables: 'Follow a home application and test-USDC deposit through move-out and payout, with three real accounts.' },
  { id: 'service-charges', availability: 'Available on this site', topic: 'home', destination: { area: 'home', section: 'home-tenancies' }, status: 'prototype', title: 'Service-charge illustration',
    how: 'Example service-charge statement with a landlord-set test prepayment and optional live daily Home Assistant consumption; no escrow funding or payouts.',
    enables: 'See an illustrative running balance. It is not a legal annual statement or money movement.',
    needs: 'Real meter and invoice data before an actual service-charge balance can be calculated.' },
  { id: 'stock-deposit', availability: 'Available on this site', topic: 'home', destination: { area: 'home', section: 'deposit-options' }, status: 'built', title: 'Share-backed deposit',
    how: 'Share-backed rental deposit with official test TSLA on Robinhood Chain testnet: 150 % cover, app-only top-up warning below 125 %, fixed-window consent or arbitration, and share payouts without a forced sale. Proven on this site on 1 October 2026 with three fresh accounts: escrow created, exact approval, pledge, a contested claim, an arbitration award and both payouts. Test tokens have no monetary value and issuer pause, block, burn and upgrade powers remain.',
    enables: 'Hold a rental deposit in test shares and get them back in kind. Cash tUSDC and its simulated yield remain separate.' },
  { id: 'borrow-against-shares', availability: 'Available on this site', topic: 'money', destination: { area: 'money', section: 'share-workflows' }, status: 'built', title: 'Loan against shares, or lend test dollars',
    how: 'With a verified shared Robinhood testnet deployment, pledge official faucet test TSLA and borrow freely mintable test dollars up to 50 % of mirrored token value. The price is copied hourly from Robinhood mainnet by an operator price job (its last run is shown, and a skipped run is flagged); borrowing and withdrawing collateral with debt need a fresh copy (26 h, 74 h at weekends). Interest accrues continuously at 5 % nominal annually (about 5.13 % effective, read from the contract); anyone can liquidate at 80 % LTV with a fresh price while unsuspended.',
    enables: 'Review loan debt and collateral, or lend test dollars for borrower-funded interest, with cash-limited withdrawals and possible bad-debt losses. You leave in kind: repay the debt and the same test TSLA returns to your wallet. Nothing is sold; a liquidation, not an exit, is the only way collateral is seized.' },
  { id: 'local-investments', availability: 'Available on this site', topic: 'money', destination: { area: 'money', section: 'local-investments' }, status: 'built', title: 'Fictional local project stakes',
    how: 'Buy and sell back fictional housing or workshop test units with your own wallet on Robinhood testnet at the fixed test issue price, subject to desk cash. The live tHOME building panel reads verified GPU receipts, your staked units and earned test dollars; host owners explicitly opt in to building payouts.',
    enables: 'Stake tHOME to earn building GPU test-dollar revenue, claim accrued earnings or unstake with your own wallet. Units must be unstaked before desk sell-back. Only staked units earn: income streams to stakers over 7 days, not as an instant payout; new revenue extends the stream. Heat needs recorded energy assumptions, solar needs local Home Assistant, and a building validator is planned unless configured. Fictional test units, no value, no rights; buying does not repay a loan.',
    needs: 'Verified issuers, legal rights, regulated arrangements and project evidence before any real investment or impact claim.' },
  { id: 'city-validator-deposits', availability: 'Planned', topic: 'home', status: 'planned', title: 'Deposits staked with a city validator',
    how: 'A possible future custody and staking arrangement would need separate legal, security and liquidity assessment; no rental deposit is staked with a city validator today.',
    enables: 'Explore local network infrastructure without promising yield, deposit availability or compliance. Test networks only; fictional units have no value and no rights.',
    needs: 'A legally assessed custody model, tenant protection, withdrawal liquidity and an independently reviewed validator integration. No legal advice.' },
  { id: 'ethereum-realtime-proving', availability: 'Planned', topic: 'devices', status: 'planned', title: 'GPUs for Ethereum real-time proving',
    how: 'Explore GPU workloads for Ethereum real-time proving separately from the current paid local AI answers. No proving customer, integration or receipts are connected today.',
    enables: 'Assess whether useful proving workloads and recoverable heat fit a local building without forecasting revenue. Fictional test units, no value, no rights.',
    needs: 'A supported proving stack, measured workloads, real demand and operational evidence before any earnings claim.' },
  { id: 'home-tokens', availability: 'Planned', topic: 'home', status: 'planned', title: 'Home shares towards owning a home',
    how: 'A future issuer could define a legal housing interest or down-payment credit. The separate test-investment example only transfers fictional issuer units; it does not grant those rights.',
    enables: 'Explore a possible renting-to-ownership path without presenting a test token as an apartment or land-register title.' },
  { id: 'devices', availability: 'Planned', topic: 'devices', status: 'planned', title: 'Electric car and other devices',
    how: 'Charging and vehicle-to-grid income read like the solar and validator adapters.',
    enables: 'Everything your hardware earns in one total.' },
  { id: 'local-ai', availability: 'Available on this site', topic: 'devices', destination: { area: 'money', section: 'local-ai' }, status: 'built', title: 'Local AI & GPU hosting',
    how: 'An available configured host answers real questions. Your own host runs without payment; eligible public hosts offer free answers within a shared allowance; a paid city-host answer uses x402 and test tUSDG at 0.0001 per generated token, at most 192 tokens (0.0192 tUSDG), charged only for a complete answer. The public AI desk needs no account. Check current service availability in the desk; availability is not guaranteed.',
    enables: 'Ask a local model or manage a host you run. Host receipts and hypothetical euro cost scenarios remain separate.',
    needs: 'Reliable operating capacity and real customer demand before treating an earnings scenario as a business forecast.' },
  { id: 'budget', availability: 'Available on this site', topic: 'places', destination: { area: 'places', section: 'city-system' }, status: 'built', title: 'Where the money goes',
    how: 'Places shows Strausberg’s 2025/26 ordinance cash-outlay plan: administrative, investment and financing total €83,708,074 (2025) and €78,540,189 (2026), including investment €17,941,270 / €12,609,320. Actuals are not published in the reviewed snapshot; ordinance, inspection and information-access links are provided. Amendments are not tracked.',
    enables: 'Distinguish an adopted headline plan from money spent or an individual tax receipt.',
    needs: 'The complete city budget plan and verified line items before a spending breakdown can be shown.' },
  { id: 'scales', availability: 'Available on this site', topic: 'places', destination: { area: 'places', section: 'personal-map' }, status: 'built', title: 'Your street, neighbourhood and city',
    how: 'The private personal map now matches city-wide published signals against on-device home/work pins in a neighbourhood ring and approximate straight commute corridor. Places still links district → state → Germany → EU portals; those wider levels are not live feeds.',
    enables: 'Start with what may affect your neighbourhood and city without disclosing your exact home or work to the server.',
    needs: 'Reviewed coverage across more cities and district/state/world levels.' },
  { id: 'measurable', availability: 'Available on this site', topic: 'places', destination: { area: 'places', section: 'city-system' }, status: 'built', title: 'A measurable city',
    how: 'Places compares 251 s before with 235 s during Münster’s 2021 bus-priority trial on the same full route, sourced to an official GPS evaluation; nearby DWD weather and citizen PM readings remain separate context.',
    enables: 'Inspect a real historical before/during measurement without mistaking it for a proven lane effect or a calibrated city-wide sensor layer.',
    needs: 'Comparable longer-term or controlled observations to attribute benefits; verified environmental coverage and reviewed interpretation for broader city outcomes.' },
  { id: 'decisions', availability: 'Available on this site', topic: 'places', destination: { area: 'places', section: 'public-decisions' }, status: 'built', title: 'Council papers & meetings',
    how: 'Covered OParl cities show upcoming meetings and latest papers from the dated snapshot with date, published body identifier and official link. Agendas are not decisions. Strausberg offers ALLRIS calendar/search links only: no working public endpoint was confirmed; district access requires permission.',
    enables: 'Inspect council records at their official source without treating a paper or scheduled meeting as an adopted decision.',
    needs: 'Fresh published snapshots, verified vote/results and structured Strausberg coverage.' },
  { id: 'welcome', availability: 'Available on this site', topic: 'places', destination: { area: 'places', section: 'community-discovery' }, status: 'built', title: 'Get settled in Strausberg',
    how: 'Places links the public English-only Strausberg welcome guide: sourced first-month steps, events, groups and contacts without an account, labelled unofficial community guidance. No guide for other cities is offered yet.',
    enables: 'Find sourced local activities and contacts. Choosing a city is not residence proof.',
    needs: 'Published welcome guides for more cities.' },
  { id: 'bank-accounts', availability: 'Planned', topic: 'money', status: 'planned', title: 'Bank accounts in the same ledger',
    how: 'A future authorized bank-data connection could place cash accounts beside wallet holdings. No bank account, transaction feed or payment authority is connected today.',
    enables: 'A broader household view without treating test-network balances as bank money.',
    needs: 'An authorized banking provider, a defined data/consent contract and revocation before any real account connection.' },
  { id: 'rental-earnings', availability: 'Needs a local setup', topic: 'home', status: 'prototype', title: 'Rental earnings rehearsal',
    how: 'A rehearsal in a local setup, where the operator plays the test landlord, uses borrower-funded interest in test dollars. Pool cash and actual borrower interest are required to claim. It is not connected to a hosted Home tenancy and is not real income.',
    enables: 'Inspect a local test-lending rehearsal, not another deposit product on this site.' },
];

export type LedgerTopicId = 'identity' | 'home' | 'money' | 'devices' | 'places';
export type AdapterConnection = 'account' | 'eudi' | 'tenancy' | 'solana' | 'robinhood' | 'homeAssistant' | 'validator' | 'city' | 'local' | 'host' | 'future';
export type AdapterDirection = 'account' | 'read-only' | 'signed' | 'device-local' | 'illustration';
export type AdapterAction =
  | { kind: 'area'; area: Area; section?: SectionId; label: string }
  | { kind: 'idea'; idea: string; label: string }
  | { kind: 'share'; choice: 'borrow' | 'lend'; label: string }
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
  { id: 'account', topic: 'identity', name: 'Passkey & own wallets',
    source: 'Privy account and user-owned wallet records', environment: 'Privy development app · test networks', maturity: 'built',
    connection: 'account', direction: 'account', capabilities: ['roles'],
    action: { kind: 'area', area: 'me', section: 'account-settings', label: 'Account settings' },
    explain: {
      brings: 'One passkey sign-in and two wallets, one for Solana and one for Robinhood Chain, that only you can sign with. You approve every deposit or trade yourself.',
      reads: 'The server checks your sign-in token with Privy, then reads your Privy user and wallet records to confirm the wallets belong to you alone.',
      keeps: 'Privy manages passkey sign-in and embedded wallet keys. This app keeps account ids and wallet addresses on records you create. It does not keep wallet keys or a browser recovery record.',
      visibility: 'Only you see your settings. People you share an agreement with see your Privy id and wallet addresses. No landlord, arbitrator or server can sign for your wallets.',
      needs: 'A browser with passkey support on HTTPS or localhost. A second passkey on another device is recommended, not required.',
      disconnect: 'You can sign out and add another passkey. There is no account-deletion control yet.',
      effort: 'few minutes', reality: 'testnet_real',
      caveat: 'These are real wallets with real keys, but this app only uses them on test networks. Do not send real funds to them.',
    } },
  { id: 'eudi', topic: 'identity', name: 'EU identity wallet',
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
  { id: 'tenancy', topic: 'home', name: 'Home agreements and deposits',
    source: 'Account-bound agreements and Solana escrow observations', environment: 'Solana devnet · test USDC', maturity: 'built',
    connection: 'tenancy', direction: 'signed', capabilities: ['today-cockpit', 'rental-deposit'],
    action: { kind: 'area', area: 'home', section: 'home-tenancies', label: 'Open my home' },
    explain: {
      brings: 'An agreement between tenant, landlord and a neutral arbitrator, with the deposit held in a Solana test escrow and one guided next step from signing to move-out payout.',
      reads: 'Your agreements and listings in this app, and the escrow’s state on Solana devnet.',
      keeps: 'Listing and agreement details, both parties’ wallet addresses, acceptance digests, hashed invitations and up to 100 evidence notes, in this app’s database. Signed transaction bytes are kept on the server and never shown in the browser.',
      visibility: 'Only the parties to an agreement can read it, and they see each other’s Privy id, wallet and evidence notes. Open listings are visible to every signed-in person; only the landlord sees applicants. Chain state is public.',
      needs: 'A finished account, a counterpart and an arbitrator you invite by link, and test USDC. New tenancies use site-minted tUSDC; older Circle-USDC tenancies still need Circle’s devnet faucet. The operator must have set up the devnet escrow.',
      disconnect: 'A landlord can close a listing and an applicant can withdraw an application before a tenant is chosen. Either the landlord or the tenant can cancel a tenancy before the deposit is locked; your account, wallets and balances are kept. After the deposit is locked there is no cancel: a tenancy ends through move-out, settlement and payout, and chain records are permanent.',
      effort: 'needs a device or service', reality: 'testnet_real',
      caveat: 'Deposit terms, not rent or dates. Three real accounts are required. Cash tUSDC is not lent; this site separately pays labelled simulated yield (5 % a year by default) to the tenant, who owns the earnings. Test tokens have no value. Final deposit payouts are unchanged and go to each party’s own wallet through the app’s sponsor.',
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
    source: 'Your Robinhood Chain testnet wallet and mirrored mainnet token-price observations', environment: 'Test network · deployment-dependent valuation', maturity: 'built',
    connection: 'robinhood', direction: 'signed', capabilities: ['today-cockpit'],
    action: { kind: 'area', area: 'money', section: 'official-shares', label: 'Open Robinhood holdings' },
    explain: {
      brings: 'See test USD, Robinhood’s official faucet test TSLA and test ETH for fees. No fake stock or operator-priced buying desk.',
      reads: 'Confirmed Robinhood testnet balances and the same Robinhood TSLA token price from Chainlink RHTSLA/USD (mainnet), converted to the test token’s multiplier, used for collateral. Source round/time, copied time, stale status and weekend freshness-window labels are shown; Jupiter TSLAx only cross-checks it.',
      keeps: 'No holdings or wallet keys are stored here; signed operations retain recovery and receipt records.',
      visibility: 'Only you in this app; on-chain data is public. The test USD is this project’s own freely mintable token.',
      needs: 'A linked wallet: self-mint tUSDG with Get test dollars and use Robinhood’s official faucet for five test TSLA and test ETH. Price valuation needs a verified shared-market deployment.',
      disconnect: 'Nothing to unlink or sell in the app. Signing out leaves the test tokens where they are.',
      effort: 'needs a device or service', reality: 'testnet_real',
      caveat: 'Test dollars anyone can mint have no monetary value. The mirror is not a Chainlink contract. No Solana bridge or fabricated fallback valuation.',
    } },
  { id: 'share-finance', topic: 'money', name: 'Shared test-share loans & lending',
    source: 'SharedLendingPool and MirroredPriceFeed observations', environment: 'Test network · deployment required', maturity: 'prototype',
    connection: 'robinhood', direction: 'signed', capabilities: ['borrow-against-shares'],
    action: { kind: 'share', choice: 'borrow', label: 'Loan against shares' },
    secondaryAction: { kind: 'share', choice: 'lend', label: 'Lend test dollars' },
    explain: {
      brings: 'Pledge official faucet test TSLA, borrow/repay, or lend/unlend test dollars in one shared pool. Repaying the debt returns the same TSLA in kind; nothing is sold. This is separate from the Solana Home deposit and from the share-backed rental deposit.',
      reads: 'Wallet balances, mirrored token-price provenance (source round time and copy time, kept apart), the operator price job’s last run and reason if it skipped (also in /api/status), loan and lender positions, pool cash/utilization/current contract rates and suspension reasons. Unhealthy loans are read separately on demand in bounded registry pages.',
      keeps: 'Reviewed signing steps and transaction recovery records, not per-wallet market deployments. Submit decodes supported calldata, zero value and the signer’s owner/receiver.',
      visibility: 'Your wallet view is account-bound and never scans the borrower registry; chain positions are public. Unhealthy loans load separately on demand in bounded pages. No operator plays the lender or liquidator.',
      needs: 'Verified shared-market manifest with immutable issuer/implementation pins, official faucet TSLA, test ETH and wallet-signed actions. An operator price job must keep copying the mainnet round; its updater key can only push a price. Missing deployment is undeployed; stale pricing, including a stopped or skipping price job, blocks price-sensitive actions. TSLA pause, pool block, implementation change or collateral shortfall suspends the market.',
      disconnect: 'Repay the debt (a little more than owed closes it) and withdraw your collateral: the TSLA returns in kind, no sale and no price needed once debt is zero. Or withdraw lender value within available cash. Old per-wallet contracts/store keys remain unused without migration.',
      effort: 'needs a device or service', reality: 'testnet_real',
      caveat: 'Continuous 5 % nominal borrower interest (about 5.13 % effective annually, read from the contract) is shared pro rata, not injected yield, a projection or income. Cash limits and bad debt apply. Disclose 10,000 tUSDG burn-address seed shares and locked interest. A local setup needs no updater key.',
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
    source: 'Robinhood testnet unit/market and building staking contracts, verified buy/sell-back and building GPU receipts; physical effects remain estimates or scenarios', environment: 'Test tokens · fictional issuers', maturity: 'prototype',
    connection: 'robinhood', direction: 'signed', capabilities: ['local-investments', 'home-tokens'],
    action: { kind: 'area', area: 'money', section: 'local-investments', label: 'Open local stakes' },
    secondaryAction: { kind: 'scenario', label: 'Explore the city scenario' },
    explain: {
      brings: 'Buy or sell back fictional tHOME housing-example or tWORK workshop-example units at the fixed test price. Fictional test units, no value, no rights; this is not a funding offer.',
      reads: 'Your tUSDG, test ETH, wallet units, staked units and earned building test dollars on Robinhood testnet, checked against a committed contract manifest; verified building receipts.',
      keeps: 'Your exact stake, unstake, claim and desk order reviews, signed transaction bytes and receipt hashes before sending. Desk orders are capped at 100 fictional units; buys also at 100 tUSDG.',
      visibility: 'Personal transaction reviews are yours. Building GPU receipts are publicly readable; orders, balances, staked units and claims are public on the test chain. Issuers are fictional.',
      needs: 'One Robinhood wallet: use Get test dollars for tUSDG and Robinhood’s faucet for test ETH. The operator’s contracts must be deployed.',
      disconnect: 'Cancel an unsigned review, unstake your tHOME before selling, or sell back wallet tHOME/tWORK through the deployed desk at the fixed test price when it has enough tUSDG. Pending signed transactions must be verified first. Fictional test units, no value, no rights.',
      effort: 'needs a device or service', reality: 'testnet_simulated',
      caveat: 'No real company, cooperative, property right, resale value or city benefit is implied.',
    } },
  { id: 'homeAssistant', topic: 'devices', name: 'Home solar (Home Assistant)',
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
  { id: 'validator', topic: 'devices', name: 'Validator activity',
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
      brings: 'Ask an AI that runs on the host’s own graphics card: free at a public library desk, or paid at 0.0001 test tUSDG per generated token, at most 192 tokens (0.0192 tUSDG) and only for a complete answer.',
      reads: 'Your question (up to 2,000 characters) goes to the operator’s local model host. Paid mode also reads Robinhood testnet for your balance, allowance and receipts.',
      keeps: 'Your question and its answer stay in this app’s database only while needed to finish and deliver the answer, then are removed about 10 minutes later (the host can change that). Usage counts, timings and payment receipts stay. No question goes to a cloud model.',
      visibility: 'Paid answers are visible to your account, free ones only to that visitor session. While a question is kept, the operator can read it and its answer, and the model host sees each question in clear while it runs. Anyone can see the node’s status and total usage.',
      needs: 'The operator’s model host running and reachable, and the free desk switched on. Paid answers also need a Robinhood Chain wallet, at least 0.0192 test USD (tUSDG), the most one answer can cost, and a one-time approval that costs test ETH.',
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
  { id: 'city', topic: 'places', name: 'City knowledge & projects',
    source: 'Stadtstack, municipal publications and source-attributed city records', environment: 'Dated snapshot · eight pilot cities', maturity: 'partly built',
    connection: 'city', direction: 'read-only', capabilities: ['city-news-feed', 'regional-shared-topics', 'scales', 'decisions'],
    action: { kind: 'area', area: 'places', section: 'project-browser', label: 'Explore & follow projects' },
    explain: {
      brings: 'Adds source-attributed news/events where published, planning records, upcoming council meetings and latest papers where covered. Follow a project to compare dated publications; no adoption or complete coverage is inferred.',
      reads: 'Published city files from a dated snapshot, refreshed only when the collector runs. No hosted project-atlas connection is used. Places currently requires an account.',
      keeps: 'Your chosen city, in this app’s database. Follows, home and work pins, interests and visit baselines stay in this browser only.',
      visibility: 'The app’s operator sees your chosen city and which city and signal IDs you request. Map tiles pass through this app’s server: OpenFreeMap sees the server’s address and the map area requested, not your IP address, and never your saved pins.',
      needs: 'A city name. Data exists for eight pilot cities: Köln, Münster, Wuppertal, Castrop-Rauxel, Düsseldorf, Dresden, Freiburg and Strausberg.',
      disconnect: 'Unfollow a project, remove a pin, or pick another city. A chosen city cannot be cleared, and signing out does not clear this browser’s follows or pins.',
      effort: 'one tap', reality: 'read_only_live',
      caveat: 'A snapshot, not a complete inventory. “Not yet checked” means no human has reviewed the item.',
    } },
  { id: 'civic-outcomes', topic: 'places', name: 'Budgets & measured outcomes',
    source: 'Hand-researched cases citing published ordinances, project records and official evaluation reports', environment: 'Five accessible cases · two cities', maturity: 'partly built',
    connection: 'city', direction: 'read-only', capabilities: ['budget', 'measurable'],
    action: { kind: 'area', area: 'places', section: 'city-system', label: 'Inspect project evidence' },
    explain: {
      brings: 'For a few researched projects, shows what was planned, what was reported spent or delivered and what was measured, kept apart so a plan is not mistaken for a result.',
      reads: 'Nothing live. Five accessible hand-written cases: four in Strausberg and one in Münster, researched on 27 and 28 September 2026. A separate Rüdersdorf research case is not exposed because that city is outside the published coverage.',
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
      brings: 'Shows available DWD station weather and nearby community sensor readings separately from project outcomes. Missing readings remain unavailable, not estimated.',
      reads: 'The app server finds your city’s centre, then asks Bright Sky (German weather service data) and sensor.community for readings within 5 km. Results are cached for 10 minutes.',
      keeps: 'Nothing about you. Weather and sensor results are cached on the server by city.',
      visibility: 'The data services see your city name or centre coordinates from the server’s address, never your account or pins.',
      needs: 'A German city that OpenStreetMap can locate, and at least one outdoor sensor within 5 km for air quality.',
      disconnect: 'Nothing to disconnect. Choose another city to change the location.',
      effort: 'automatic', reality: 'read_only_live',
      caveat: 'Nearby readings are not calibrated city-wide pollution or project impact.',
    } },
  { id: 'community', topic: 'places', name: 'Community & newcomer welcome',
    source: 'OSM leisure places, researched official directories and a sourced public welcome guide', environment: 'Local discovery · Strausberg welcome guide', maturity: 'partly built',
    connection: 'city', direction: 'read-only', capabilities: ['welcome', 'roles'],
    action: { kind: 'area', area: 'places', section: 'community-discovery', label: 'Discover local activities' },
    explain: {
      brings: 'Lists available local sports places and Strausberg official directories, and links its public English-only welcome guide. Places require an account; the welcome guide does not.',
      reads: 'The app server asks public OpenStreetMap servers (Overpass) for sports facilities in your city that have no club or sport tag, cached for 24 hours. Official directory links exist for Strausberg only.',
      keeps: 'Nothing about you.',
      visibility: 'The OpenStreetMap servers receive your city name from the app server, not your identity or pins. Your interests stay on your device.',
      needs: 'A city that OpenStreetMap lists by that name.',
      disconnect: 'Nothing to disconnect.',
      effort: 'automatic', reality: 'read_only_live',
      caveat: 'A directory is not membership. No welcome voucher, registration or partner offer exists.',
    } },
];
