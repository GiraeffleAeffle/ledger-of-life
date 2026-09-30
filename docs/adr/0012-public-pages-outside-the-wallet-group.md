# 0012 Public pages live outside the wallet route group

Status: Accepted (29 September 2026)

## Context

The wallet SDK (Privy and WalletConnect) contacts its providers as soon as it mounts. It was mounted in the root layout, so every page sent a visitor's address and headers to two third parties, including a page written for someone with no account. Measuring the new welcome page in a browser showed `auth.privy.io` and `explorer-api.walletconnect.com` on an anonymous visit, which contradicts what that page tells its reader.

## Decision

The root layout holds only the shell (fonts and styles). The wallet provider lives in the `(wallet)` route group (`app/(wallet)/layout.tsx`), which holds the workspace, the library desk and the design lab. Public pages such as `/welcome/<city>` sit outside it and load nothing from a third party.

## Consequences

- A public page cannot load the wallet SDK by accident. Putting a page under `(wallet)` is a visible decision.
- Checked in a production build: `/welcome/strausberg` makes 15 requests, all to its own origin (one document, three stylesheets, nine scripts, two fonts) and sets no cookies. `/` and `/library` still contact Privy and WalletConnect, which they need.
- A public page must not import a component that calls `useRentalWallet`, which throws without the provider.
- Not covered: third parties inside the workspace, such as the map tiles from OpenFreeMap. This record is about public pages.
