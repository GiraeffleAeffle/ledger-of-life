# 0013 GPU hosts connect outbound to the app

Status: Accepted (30 September 2026)

## Context

The public app's egress permits public HTTPS, not the owner's LAN. Exposing Ollama or Home Assistant, or joining every resident to an operator's VPN, is not a safe host registry. The owner approved the outbound connector in D3 of the roadmap, subject to review.

## Decision

A zero-dependency Node connector generates an Ed25519 key locally and requests a ten-minute, single-use pairing code. An authenticated account whose verified EVM wallet is in `LOCAL_AI_HOST_OWNER_WALLETS` approves it and selects a verified payout wallet. The server stores only the public key. Every subsequent connector request signs the method, path, millisecond timestamp, random nonce and SHA-256 of the exact body bytes; clock skew and replay are rejected. Revocation disables that key immediately.

The connector long-polls over HTTPS (at most 25 seconds), reports heartbeats, and answers only its assigned jobs. Each host has one lease. A bounded text-only `/api/chat` request names an advertised model and whitelisted options, with no tools, images, browsing or shell. The app never fetches a host-supplied URL. Optional Home Assistant wake credentials and the private key remain on the connector device. The direct configured Ollama path remains available in local mode.

A quote binds the chosen host, model and payout wallet. Routing prefers the requester's own available host; third-party routing requires an explicitly public question. Exactly 0.01 test tUSDG uses the existing x402/Permit2 flow, with settlement only after a complete answer. Expired, incomplete and failed jobs cost nothing. Question retention applies to queued jobs as well as request records.

## Consequences

- The host reads questions in clear. The desk must disclose this and offer own-host-only versus public city-host routing. No confidential question should be sent to an untrusted host.
- Nothing proves which model ran, whether the reported timings are truthful, or whether the host keeps a copy. Signatures prove possession of a paired key, not trustworthy inference.
- Pairing is an operator invitation for the contest, not residence proof. Third-party real-money service needs legal review; only test networks are supported.
- SQLite and long polling target one app replica. A multi-replica release needs a shared durable queue and coordinated leases before scaling.
- HTTPS terminates at the app ingress; the cluster never initiates a connection into the home network. Connector software and its local configuration remain a trust boundary requiring security review.
