# 0013 GPU hosts connect outbound to the app

Status: Accepted (30 September 2026)

## Context

The public app's egress permits public HTTPS, not the owner's LAN. Exposing Ollama or Home Assistant, or joining every resident to an operator's VPN, is not a safe host registry. The owner approved the outbound connector in D3 of the roadmap, subject to review.

## Decision

An authenticated account whose verified EVM wallet is in `LOCAL_AI_HOST_OWNER_WALLETS` creates a ten-minute, single-use invitation in the app and chooses a verified payout wallet. The code is shown once and only its hash is stored. A zero-dependency Node connector generates an Ed25519 key locally and consumes that invitation with its public key; registration binds that key to the invitation's account and payout. Unauthenticated requests cannot create invitations or consume shared host capacity without a valid invitation. Every subsequent connector request signs method, path, millisecond timestamp, random nonce and SHA-256 of the exact body bytes; clock skew and replay are rejected. Short body-read deadlines and malformed-header prechecks bound unauthenticated holds. Revocation disables that key immediately.

The connector long-polls over HTTPS (at most 25 seconds), reports heartbeats, and answers only its assigned jobs. Each host has one lease, reserved before a request starts or consumes quota; busy requests remain resumable. Abandoned polls release their waiter without claiming work. A bounded text-only `/api/chat` request names an advertised model and whitelisted options, with no tools, images, browsing or shell. The app never fetches a host-supplied URL. The owner's default wake mode is a tokenless UDP Wake-on-LAN magic packet sent locally; optional Home Assistant requires HTTPS unless a loudly named trusted-LAN plaintext opt-in is set, with a dedicated non-admin user's token retained only on the connector. The direct configured Ollama path remains available in local mode.

A quote binds the chosen host, model, payout and question scope. Routing prefers the requester's own available host: their own compute has no x402 authorization, payout or payment receipt. Third-party routing requires an explicitly public question and uses the existing exact 0.01 test tUSDG x402/Permit2 flow, settled only after a complete answer. Expired, incomplete and failed jobs cost nothing. Clearing a visitor session cancels its connector jobs, interrupts the requests and purges both text fields before reporting success; revocation fences later answer persistence. A host that already received a question cannot be made to forget it.

## Consequences

- The host reads questions in clear. The desk must disclose this and offer own-host-only versus public city-host routing. No confidential question should be sent to an untrusted host.
- LAN HTTP Ollama is an explicit trust boundary: anyone able to observe or alter that traffic can read questions or forge a complete answer, just like a malicious host. Completion-gated payment cannot prove the model or authenticate that plaintext transport. Use authenticated TLS or a trusted LAN; the tokenless owner wake default avoids sending a Home Assistant bearer credential over it.
- Public status reveals active host availability and a caller-relative `own` flag, never account DIDs, pending registrations or revoked hosts.
- Nothing proves which model ran, whether the reported timings are truthful, or whether the host keeps a copy. Signatures prove possession of a paired key, not trustworthy inference.
- Pairing is an operator invitation for the contest, not residence proof. Third-party real-money service needs legal review; only test networks are supported.
- SQLite and long polling target one app replica. A multi-replica release needs a shared durable queue and coordinated leases before scaling.
- HTTPS terminates at the app ingress; the cluster never initiates a connection into the home network. Connector software and its local configuration remain a trust boundary requiring security review.
