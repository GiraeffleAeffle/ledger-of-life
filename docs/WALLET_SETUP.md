# Passkeys and personal wallet setup

Updated 1 October 2026. Account access is passkey-only ([ADR 0014](adr/0014-passkey-only-test-accounts.md)). No email login, backup-email enrollment or second-session recovery proof remains in the application. Nothing here has monetary value.

## What is implemented

`WalletProvider` and `useRentalWallet()` in `src/wallets/` expose passkey signup/login, additional passkey enrollment through Privy's `useLinkWithPasskey`, removal of an old linked email through `useUnlinkEmail`, explicit creation of EVM and Solana embedded wallets, and user-visible signature requests. Email removal is offered only when the account already has a passkey. With no `NEXT_PUBLIC_PRIVY_APP_ID`, the app shows an honest setup-pending state. It does not create an anonymous wallet or simulate a successful login.

Wallet creation follows account security setup. Privy's automatic wallet creation does not run for direct passkey hooks, so the onboarding button explicitly creates missing wallets. It never replaces an existing linked wallet. Both wallets must use Privy's current user-owned embedded-wallet model; imported or delegated wallets are excluded from this first flow.

The server's `verifyPrivyToken()` checks the SDK-verified JWT and fetches current user, wallet and owner records. It returns only the verified subject and wallet identities, plus login-method status. A linked address supplied in an HTTP body or an application role inside a JWT is not trusted. Owner quorums must contain only that user, with no extra authorization keys, nested quorums, additional signers or attached automations. Application tenancy and dispute roles are assigned in the application database.

Signing is separated from submission:

- EVM transaction signing accepts only Robinhood mainnet/testnet requests for the selected wallet. This is a signature primitive, not Safe/ERC-4337 sponsorship.
- `signEvmTypedData()` reconstructs only the `RentalEscrow` version `1` / `EscrowAction` schema used by the bounded escrow relay. It binds the operation to the signer, chain, escrow, exact action, nonce and deadline. The sponsor can submit that signature to `executeSigned`; it receives no general portfolio signing authority.
- Solana signing requires the tenant to be a required signer and the declared fee payer to be a separate sponsor. The transaction's message must remain unchanged after signing. Sponsorship must already be included before quoting/signing; this helper does not rewrite Jupiter or sponsor signatures.

The module never calls server wallet-signing endpoints, attaches session signers, requests offline delegation, or submits financial transactions. Do not enable those controls as a setup shortcut.

## Provider activation

The existing development app has passkey login and the separate **Enable passkeys for sign up** setting enabled. The client requests only `passkey`; additional passkeys are linked to the same account, not used to create replacement wallets. Historical accounts may still have emails in Privy; Me offers their removal without displaying the address elsewhere.

We recommend linking a second passkey on another device, but it does not gate any tenancy action. Losing every passkey means losing this test account. There is no email-based recovery path.

Remaining setup:

1. Use the existing development app and preserve the technical repository name while the brand is undecided. In Authentication → Login methods → Passkeys, enable both passkeys and the separate **Enable passkeys for sign up** option. A production plan has not been activated.
2. Ensure the published origin is in the Privy app or app client's allowed origins. The current hosted app uses the app-level `https://ledger.stadtstack.eu` origin without a separate app client. Confirm relying-party/domain behavior on a real device; a credential enrolled at the local origin may not work on a different hostname.
3. Keep user-owned embedded Ethereum and Solana wallets with TEE, without server/session/additional signers or wallet automations. The application explicitly requests each missing wallet after passkey setup.
4. Set `PRIVY_APP_SECRET` in each additional development or deployment environment. Never put a server secret in a `NEXT_PUBLIC_` variable, public repository, URL or screenshot.
5. Restart local development or rebuild a deployment after configuration changes. Prove real passkey access and an optional second-device passkey before relying on the account.

```dotenv
NEXT_PUBLIC_PRIVY_APP_ID=
# Optional app client id (public), for a build whose allowed origins differ from the app's defaults.
NEXT_PUBLIC_PRIVY_CLIENT_ID=
PRIVY_APP_SECRET=
# Optional PEM public verification key; literal \n escapes are supported.
PRIVY_VERIFICATION_KEY=
```

The SDK currently uses public Robinhood and Solana RPCs for wallet connection/signing. Server finance adapters own their separate configured RPCs, transaction simulation, sponsor policy and submission. Do not place a private paid RPC key in these public wallet defaults.

## Trading provider handoff

The user signed in to Jupiter and created an organization and project team named `rental-deposit-dev`. A replacement API key is set as `JUPITER_API_KEY` in the user's ignored local configuration. Its portal permissions were narrowed to `/swap/v2/order` alone and verified after reload. Price-only requests through the app succeeded with that key; they did not request transactions or prove an executable trade. No 0x account or RWA grant is configured. The provider links and access conditions below were checked on 22 September 2026.

Jupiter's current account entry point is [Developer Portal](https://developers.jup.ag/portal). The current Free plan is $0 with one request per second. Keep any usable key as server-only `JUPITER_API_KEY`; the current app uses `/swap/v2/order`. Jupiter also documents keyless requests at 0.5 requests per second, which support the existing limited price check. An account and indicative quote do not establish instrument eligibility or prove an order filled. [Jupiter setup](https://developers.jup.ag/docs/portal/setup), [pricing](https://developers.jup.ag/pricing).

For 0x, open [Log in](https://dashboard.0x.org/login) or [Create an account](https://dashboard.0x.org/create-account). The public signup form asks for first name, last name and work email. Complete personal account verification, then create a project team and app with the required API products. The app's API Keys view provides the key; keep it in server-only `ZEROX_API_KEY`. Do not add a paid plan or use a key belonging to a different project. [0x account and app setup](https://docs.0x.org/docs/introduction/quickstart/getting-started).

Robinhood stock-token access requires an additional 0x RWA opt-in. The provider's article, updated 21 September, says requests are currently processed for legal entities and individual requests are paused. It directs eligible teams to request access through `support@0xproject.com`; no outreach or business assertions were submitted for this project. `ZEROX_RWA_ENABLED=1` must represent an actual provider grant, not a local workaround. A standard API key alone does not remove this access gate. [Current 0x RWA access requirements](https://help.0x.org/articles/5420296643-xstocks-support-on-0x).

## Parent application integration

Wrap the interactive application with `WalletProvider`; show `WalletAccessPanel` in account onboarding. Use `useRentalWallet().getAccessToken()` for the Authorization bearer token on protected same-origin API requests. The backend calls `verifyPrivyToken(token)` and looks up the subject's role membership in the database. No cookie, URL parameter or demo role selector substitutes for that check.

`verifyPrivyToken()` returns:

```ts
{
  subject: string;
  sessionId: string;
  expiresAt: number; // Unix seconds
  wallets: Array<{ id: string; address: string; chainType: 'ethereum' | 'solana' }>;
  passkeyCount: number;
}
```

It throws `IdentityError` with `unauthenticated`, `identity_unavailable` or `wallet_not_user_owned`. Handle unavailable identity as unavailable; do not silently fall back to demo or anonymous authorization.

`requireWalletAccess(store, verifiedIdentity, walletId)` in `src/server/wallet-access.ts` requires a provider-verified passkey and the selected sole-owned wallet. It writes no recovery record and issues no browser cookie. Agreement readiness also needs only a verified passkey; existing party, wallet, amount, signature and deployment checks remain unchanged.

The obsolete `/api/identity` recovery endpoints and signing challenges have been removed. Store initialization removes old `identity-recovery:*` and `identity-browser:*` records and legacy connector source-rate fields. SQLite secure deletion plus a WAL checkpoint reclaims their old bytes.

The client signing methods do not replace server validation of operation membership, immutable tenancy network/asset, quote expiry, amounts, allowed recipients, nonce or signatures. A complete connected money flow still requires finance adapter simulation, sponsored submission and durable reconciliation.

## Acceptance still to run with provider access

1. Create an account using only a passkey, then create both wallets and run the tenancy journey. Confirm server-fetched wallet ownership.
2. Link another passkey from a second device and sign in to the same account. This is optional backup access, not a tenancy requirement.
3. Cancel signup, wallet creation and a signing request. Verify useful retry UI and no financial submission. Retry partial wallet creation without duplicating the existing wallet.
4. Inspect a real Robinhood escrow action and a Solana sponsored transaction. Confirm visible wallet approval, signature binding and rejection of changed amount, chain, escrow, signer, sponsor or expired request.
5. Run the whole declared flow with zero native user gas balance, including account creation, and show actual sponsor costs. These wallet hooks alone do not prove the fee budget or complete deposit/investment path.

Local automated tests verify real ES256 access-token validation, owner restrictions, network-aware identity, canonical recovery binding, sponsored Solana transaction structure and EIP-712 signature binding. They use generated test keys and protocol fixtures, with no provider account or real funds.

## Primary references

- [Privy passkeys](https://docs.privy.io/authentication/user-authentication/login-methods/passkey)
- [Account linking](https://docs.privy.io/user-management/users/linking-accounts)
- [Automatic wallet creation restrictions](https://docs.privy.io/basics/react/advanced/automatic-wallet-creation)
- [Access-token verification](https://docs.privy.io/authentication/user-authentication/access-tokens)
- [EVM sign-only requests](https://docs.privy.io/wallets/using-wallets/ethereum/sign-a-transaction)
- [Solana sign-only requests](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction)
- [Robinhood network configuration](https://docs.robinhood.com/chain/connecting/)

The pinned Node SDK `0.35.0` has `client.utils().auth().verifyAccessToken(token: string)` and returns snake-case claim fields. The live documentation example used an object argument when inspected; the implementation is type-checked against the installed SDK.
