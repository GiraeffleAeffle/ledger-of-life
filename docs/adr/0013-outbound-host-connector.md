# 0013 GPU hosts connect outbound to the app

Status: Accepted (30 September 2026)

## Context

The public app's egress permits public HTTPS, not the owner's LAN. Exposing Ollama or Home Assistant, or joining every resident to an operator's VPN, is not a safe host registry. The owner approved the outbound connector in D3 of the roadmap, subject to review.

## Decision

An authenticated account whose verified EVM wallet is in `LOCAL_AI_HOST_OWNER_WALLETS` creates a ten-minute, single-use invitation in the app and chooses a verified payout wallet. The code is shown once and only its hash is stored. A zero-dependency Node connector generates an Ed25519 key locally and consumes that invitation with its public key; registration binds that key to the invitation's account and payout. Unauthenticated requests cannot create invitations or consume shared host capacity without a valid invitation. Every subsequent connector request signs method, path, millisecond timestamp, random nonce and SHA-256 of the exact body bytes; clock skew and replay are rejected. Short body-read deadlines and malformed-header prechecks bound unauthenticated holds. Revocation disables that key immediately.

The connector long-polls over HTTPS (at most 25 seconds), reports heartbeats, and answers only its assigned jobs. Each host has one lease, reserved before a request starts or consumes quota; busy requests remain resumable. Abandoned polls release their waiter without claiming work. A bounded text-only `/api/chat` request names an advertised model and whitelisted options, with no tools, images, browsing or shell. The app never fetches a host-supplied URL. The owner's default wake mode is a tokenless UDP Wake-on-LAN magic packet sent locally; optional Home Assistant requires HTTPS unless a loudly named trusted-LAN plaintext opt-in is set, with a dedicated non-admin user's token retained only on the connector. The direct configured Ollama path remains available in local mode.

Pickup remains 30 seconds; the total job lifetime is 240 seconds for wake, readiness, explicit cold-model preload and generation. Generation is capped at 90 seconds or the remaining lifetime, whichever is shorter. Updated connectors must honor the existing `expiresAt` throughout those stages. The job envelope stays `{id, model, messages, options, expiresAt}`. The app returns saved resumable running requests promptly and the client polls using existing authorization; no new signature or authorization is introduced. Ingress remains at least 120 seconds rather than holding a request open for the whole job.

A quote binds the chosen host, model, payout and question scope. Routing prefers the requester's own available host: their own compute has no x402 authorization, payout or payment receipt. Paid third-party routing requires an explicitly public question and uses an x402/Permit2 payment (amended on 1 October 2026, see below: per output token, not a flat 0.01), settled only after a complete answer. Expired, incomplete and failed jobs cost nothing. Clearing a visitor session cancels its connector jobs, interrupts the requests and purges both text fields before reporting success; revocation fences later answer persistence. A host that already received a question cannot be made to forget it.

Public city AI is available to anyone; residence is not checked. A public release may set `LOCAL_AI_LIBRARY_ENABLED=1`, enabling both connector and direct free library mode. Free access uses a revocable visitor session with three attempts per visitor and 30 shared attempts per UTC day. Free connector jobs require explicit `publicQuestion` consent and route only to hosts whose owner enabled `freePublicAnswers` (default `false`) in owner settings. They have no payment, payout or paid receipt. Paid third-party complete answers retain the exact 0.01 test tUSDG flow; own-host compute is unchanged. This decision does not claim the new behavior has been released or a real sleeping-GPU wake proven.

## Consequences

- The host reads questions in clear. The desk must disclose this and offer own-host-only versus public city-host routing. No confidential question should be sent to an untrusted host.
- LAN HTTP Ollama is an explicit trust boundary: anyone able to observe or alter that traffic can read questions or forge a complete answer, just like a malicious host. Completion-gated payment cannot prove the model or authenticate that plaintext transport. Use authenticated TLS or a trusted LAN; the tokenless owner wake default avoids sending a Home Assistant bearer credential over it.
- Public status reveals active host availability and a caller-relative `own` flag, never account DIDs, pending registrations or revoked hosts.
- Nothing proves which model ran, whether the reported timings are truthful, or whether the host keeps a copy. Signatures prove possession of a paired key, not trustworthy inference.
- Pairing is an operator invitation for the contest, not residence proof. Third-party real-money service needs legal review; only test networks are supported.
- SQLite and long polling target one app replica. A multi-replica release needs a shared durable queue and coordinated leases before scaling.
- HTTPS terminates at the app ingress; the cluster never initiates a connection into the home network. Connector software and its local configuration remain a trust boundary requiring security review.

## Amendment (1 October 2026): price per output token

The flat 0.01 test tUSDG per answer in this decision is superseded. A paid city-host answer uses x402 v2 `upto`/Permit2 at 100 atomic tUSDG (0.0001 tUSDG) per output token, with a signed maximum of 192 tokens (0.0192 tUSDG), and is charged only for a complete answer (`src/domain/ai-pricing.ts`). Own-host and free public answers stay unpaid. The 30 September flat-price payment is historical; no per-token `upto` settlement has been observed yet. `scripts/prove-ai-answer.mjs` reads a request id or settlement transaction from the public RPC to record one.
