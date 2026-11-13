# ADR 0003: A hosted control plane that holds no keys

## Status

Proposed on 2026-11-03. Accepted by the owner on 2026-11-04. Hosted live signing stays closed until a staging run passes. Every PR in the hosted stack keeps that gate.

## Context

Whale today is one operator's wallet. One executor holds one Turnkey API key for one hot wallet. One bearer token guards it, and env variables hold its policy. That is custody: whoever runs the executor can move the funds.

The product goal is a wallet that developers and bot operators connect to their agents over MCP or HTTP. A hosted service is the easy way in: sign in, create a wallet, paste a URL into an agent. A hosted service is also a target. This record decides how Whale hosts the product without holding the keys, and what each security level does and does not protect.

## Decision

### Two processes

The **gateway** is new and public. It serves the web app, accounts, sessions, agents, API keys, the OAuth authorization server, the MCP endpoint over Streamable HTTP, and the dashboard API. It holds no signing credential.

The **executor** stays private, as in ADR 0002. It quotes, screens, simulates, reserves spend, applies the signing policy, and asks the wallet's signer for a signature. The gateway reaches it over the private network with a service token. `RAILWAY_PUBLIC_DOMAIN` still refuses executor boot.

### Three signing levels, chosen per wallet

A wallet's level is fixed at creation. Moving to another level means a new address and a transfer, because the key is different.

| Level | Where the key lives | Who enforces the rules | What a full Whale compromise can do |
| --- | --- | --- | --- |
| `enclave` | A Turnkey sub-organization whose only root is the user's passkey | Turnkey's policy engine, then Whale's app policy | Sign what the Turnkey policy allows, one transaction at a time. Turnkey policies are stateless, so daily caps hold only while Whale is intact. |
| `self_hosted` | The user's machine, inside `whale-signer` (Rust) | The signer's local policy file, which Whale cannot edit | Ask. The signer refuses anything outside its local policy and keeps its own daily totals. |
| `smart_account` | The user's key owns an on-chain account. Whale holds a session key | The account's on-chain session module | Spend inside the session limits the chain enforces, including period caps. |

The dashboard states this table to the user when they choose. No level is called "unhackable".

#### `enclave`

The user's passkey is the sole root of their sub-organization. Turnkey's recommended frontend flow runs in the browser under the user's passkey session. It creates an API-only user for Whale and the policies for that user. Whale's credential is never root, so there is no window where Whale holds root without the user's consent. The backend flow, which adds Whale as a temporary root, is rejected.

The Turnkey policy carries what Turnkey can see:
- the chain;
- the router allowlist in `eth.tx.to`;
- the native value cap;
- the selector prefix;
- when an ABI is uploaded for the target, named arguments through `eth.tx.contract_call_args`, for example the recipient and amount of an ERC-20 `transfer`;
- the Solana program ids and native transfer recipients, as today.

Calldata nested inside a `bytes` argument, such as 0x `exec` wrapping Settler `execute`, is not documented as parseable. Swaps through those routers therefore rely on Whale's app policy for the recipient check. The dashboard says so on the enclave level. A user who needs that closed picks `self_hosted` or `smart_account`.

Whale's delegated credential is one P-256 API key per deployment. It lives only in executor env, and each sub-organization's policy bounds what it can do. A per-tenant key in a KMS is the follow-up, listed below.

#### `self_hosted`

`whale-signer` is a single Rust binary. It holds the EVM and Solana keys in an encrypted file, or the OS keychain where one exists. It reads a policy file in the same JSON shape Whale stores. It connects out to the gateway over HTTPS and long-polls for signing jobs, so the user opens no inbound port. Each job carries the unsigned transaction and the context Whale used. The signer decodes the transaction itself, checks its own policy and daily totals, and signs or refuses. Whale never sees the key. Shared JSON test vectors keep the app signing policy and the signer's decisions in step. `whale-signer` is the only local signer.

#### `smart_account`

The user's key owns the account. Whale holds a session key whose permissions an audited on-chain module enforces: allowed targets and selectors, spending limits per period, value limits, and expiry. Whale writes no account or module contract. The module choice needs its own record before code: ERC-7579 smart sessions on EVM, Squads spending limits on Solana. Until that record lands, the level is listed as unavailable.

### Identity

**Google sign-in opens the account. It does not move money.** The gateway runs the OpenID Connect authorization code flow with PKCE against Google. It verifies the ID token signature against Google's published keys with `node:crypto`, and checks `iss`, `aud`, `exp`, `nonce`, and `email_verified`. An account is keyed by the Google `sub`, not the email.

The session is a random 32-byte token in a `__Host-` cookie that is `HttpOnly`, `Secure`, and `SameSite=Lax`. Postgres stores only its SHA-256. It expires after 12 hours idle or 7 days in total. Mutating dashboard routes also require a matching `Origin`.

**The passkey owns the wallet.** It is created at wallet creation with Whale's domain as the relying party. For `enclave`, the attestation goes to Turnkey as the sub-organization root. Whale stores the credential id and public key, and verifies assertions with `node:crypto` (ES256 only) for these actions:
- widening a policy;
- approving a held operation;
- adding a withdraw address;
- enabling live mode on a wallet.

Recovery is part of creation. The user registers a second passkey, or opts into Turnkey email login as a recovery credential and accepts that trade-off. Turnkey cannot restore a lost credential, and neither can Whale.

### Agents

An **agent** is one connection, such as "Claude Desktop" or "bot on VPS". It belongs to one wallet. Its limits are a subset of the wallet policy: chains, actions, a per-transaction USD cap, a daily USD cap, and an approval threshold. An agent is revoked on its own, without touching the wallet or other agents.

An agent authenticates in one of two ways:
- **API key** for servers and stdio clients. The format is `whale_<12 hex id>_<43 base64url secret>`. Postgres stores the id and the SHA-256 of the secret. The dashboard shows the secret once.
- **OAuth** for MCP clients that open a browser. The gateway is the authorization server for the 2026-07-28 MCP authorization revision:
  - Protected Resource Metadata (RFC 9728) and authorization server metadata (RFC 8414), with a path-free issuer.
  - Client registration by Client ID Metadata Document first, with fetch guards against SSRF. Dynamic Client Registration is kept for older clients. The spec marks it deprecated.
  - PKCE `S256` only. A required `resource` (RFC 8707). Access tokens bound to the MCP URL as audience.
  - Opaque access tokens that live one hour. Rotating refresh tokens that live 30 days.
  - A consent page that shows the client name and the redirect host, warns on `localhost`, and asks for the wallet and the agent limits before any redirect to Google.

  An unknown user signs in with Google during that flow, so "connect from the MCP client" also creates the account. No MCP tool creates accounts.

The MCP endpoint is `POST /mcp` with JSON responses. It checks `Origin`, accepts only `Authorization: Bearer`, and never forwards the agent's token to a vendor. Its tools are the existing six, scoped to the agent's wallet, plus `account_status`, `deposit_address`, and `request_approval`.

### Policies

A wallet policy is data, parsed with Zod:
- enabled chains and allowed actions;
- token allow and deny lists;
- withdraw and transfer destinations;
- per-transaction and daily USD caps;
- maximum slippage;
- the approval threshold.

Narrowing applies at once. Widening needs a passkey assertion, waits 24 hours, and notifies the user, who can cancel. A change that touches the Turnkey policy is signed in the browser under the user's passkey, because Whale cannot edit it.

The existing order is kept for every hosted send: screening, the spend reservation, simulation, the app signing policy, then the signer. Spend reservations are keyed by wallet and day. Kill switches exist at deployment, account, wallet, and agent scope, and any one of them stops a send.

### Data

Postgres holds:
- accounts, identities, sessions and passkeys;
- wallets and their addresses;
- agents and agent credentials;
- OAuth clients, codes and refresh tokens;
- policies and pending policy changes;
- approvals, audit events, webhooks and their deliveries.

`spend_journal`, `signed_tx`, and `control_flags` gain wallet scope. Schema changes are numbered SQL migrations, applied under an advisory lock and recorded in `schema_migrations`. Integration tests run against a real Postgres in CI.

### Web

The dashboard is a Vite and React single-page app in a `web/` pnpm workspace package. It is served as static files by the gateway under a strict Content Security Policy with no inline script and no third-party origin except Google sign-in and Turnkey. It has no UI library and no client-side state library. The same supply-chain rules apply to the workspace.

## Consequences

- Every stored credential is a 256-bit random token hashed with SHA-256: sessions, API keys, OAuth codes and tokens. None is a human password, so SHA-256 is the right hash. The CodeQL slow-hash query stays on, so a real password hash is still flagged. Each alert it raises on a random token is dismissed in code scanning with this reason. A human password would need its own record first.

- A gateway compromise can read account data and act as any agent, inside each wallet's policy and the level's guarantee above. It cannot read a key.
- An executor compromise holds Whale's delegated Turnkey key. That reaches every `enclave` wallet's per-transaction policy and Whale's `smart_account` session keys, inside the limits the chain enforces. It reaches no `self_hosted` key and no `smart_account` owner key.
- Turnkey policies count against a per-organization limit (5 on the non-enterprise plans). Policies are therefore written per sub-organization, not in the parent.
- The executor becomes multi-tenant. Its per-request context is the wallet, its signer, its policy, and its caps. Single-operator env config remains for the existing deployment.

## Not decided here

- The smart-account module, on EVM and on Solana.
- A per-tenant delegated key in a KMS.
- Billing.
- Whether hosted live opens per wallet or per account after review.

## Build order

Each step is a stacked pull request, and each one keeps hosted live closed:
1. Migrations and the tenant schema.
2. The gateway with Google sign-in.
3. Agents and API keys.
4. MCP over HTTP.
5. The OAuth authorization server.
6. `enclave` wallets and passkeys.
7. Policies and kill switches.
8. The web dashboard.
9. Activity, approvals, and webhooks.
10. Live fee data and payment intents.
11. `whale-signer`.
12. The smart-account record.
