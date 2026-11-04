# Run Whale on one machine

Use this when you want the CLI, the MCP server, or the executor on a laptop. For Railway, use [Deploy Whale on Railway](deploy.md).

## What default boot does

Leave `WHALE_BROADCAST` unset. The process does not broadcast.

If `LISTING_TRADER_LIVE` is set to any value, boot throws `LISTING_TRADER_LIVE is closed`. If `WITHDRAW_ENABLED` is set to any value, boot throws `WITHDRAW_ENABLED is closed`. `POST /withdraw` is absent.

The scripts are `start:executor`, `start:cli`, and `start:mcp`. The MCP tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`.

## Create a keystore

The command prints the keystore path and the two public addresses. It does not print the keys.

```bash
export KEYSTORE_PASSPHRASE='a passphrase of at least 12 characters'
export KEYSTORE_PATH=wallet.keystore.json
pnpm run create-wallet
```

The file mode is `0600`. `*.keystore.json` is gitignored. Live mode refuses `KEYSTORE_PATH` and `KEYSTORE_PASSPHRASE`. The production signer is Turnkey. See [Load Turnkey](#load-turnkey).

## Build

```bash
pnpm run build
```

## Migrate the hosted schema

`DATABASE_URL=... pnpm run migrate` applies the numbered files in `migrations/` under an advisory lock. A second run prints `migrations: up to date`. It refuses to run when an applied file changed or when the database is ahead of the build. The executor tables still create themselves at boot.

## Dashboard

`web/` is a Vite and React app in the pnpm workspace. `pnpm run check` builds it. `pnpm --filter @whale/web run dev` serves it on `http://localhost:5173` and proxies the server routes to a gateway on port 8080. For local sign-in, start that gateway with `GATEWAY_PUBLIC_URL=http://localhost:5173` and register `http://localhost:5173/auth/google/callback` on the Google client.

The gateway serves `web/dist`:
- Each page goes out with `no-cache` and a CSP that allows only this origin, plus `https://api.turnkey.com` for the delegation step.
- Hashed assets cache for a year.
- Unknown paths under `/api/`, `/auth/`, `/oauth/`, `/mcp`, and `/.well-known/` stay JSON 404s.

The pages are:
- **Sign-in.**
- **Wallets:** create an enclave wallet.
- **Wallet:** enclave setup, deposit addresses, the policy editor with step-up and the pending widening, agents with one-time keys, freeze and unfreeze.
- **`/connect`:** the OAuth consent page. It names the client first and offers Google only after that.

## Start the gateway

The gateway is the public process from ADR 0003. `pnpm run start:gateway` applies migrations, then listens on `PORT` (default 8080). Docker runs it from the same image with `node dist/src/gateway-server.js`.

| Variable | Rule |
| --- | --- |
| `GATEWAY_PUBLIC_URL` | A bare origin. `https` outside `localhost`. Google redirects to `/auth/google/callback` on it. |
| `DATABASE_URL` | Required. The role needs DDL rights while migrations run at boot. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | A Google OAuth web client. Register the callback URL above as its only redirect URI. |
| `GATEWAY_SECRET` | At least 32 random bytes, base64url. It seals the short-lived login state. Rotating it cancels logins in flight, not sessions. |
| `GATEWAY_TRUST_PROXY_HOPS` | 0 to 3. Set 1 behind one proxy so rate limits see the client address. |

Boot refuses `TURNKEY_API_PRIVATE_KEY`, `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `WHALE_BROADCAST`, and `EXECUTOR_AUTH_TOKEN`, because the gateway holds no signing credential. `HOSTED_LIVE` throws until ADR 0003 is accepted.

Sessions are a `__Host-` cookie that is `HttpOnly`, `Secure`, and `SameSite=Lax`. Postgres keeps only the SHA-256 of the token. A session ends after 12 hours idle or 7 days. A `POST` to `/api/` or `/auth/` from another origin gets 403.

### Wallets and agents

`POST /api/wallets` with `{ "label", "level" }` creates a wallet in `pending` with the default policy: Base, Arbitrum, and Solana, swaps only, USD 50 per transaction, USD 100 a day, approval above USD 25, 100 bps slippage. Only `enclave` is offered. `self_hosted` and `smart_account` answer `level_unavailable` until their signers land. An account holds ten wallets.

`POST /api/wallets/:id/agents` with `{ "name", "limits" }` creates an agent and returns its API key once, as `whale_<id>_<secret>`. Postgres keeps the SHA-256 of the secret. The limits must sit inside the wallet policy. The limit that applies at send time is the intersection, because the policy can narrow later. `POST /api/agents/:id/rotate` replaces the key. `POST /api/agents/:id/revoke` stops the agent and every credential it holds.

### MCP over HTTP

`POST /mcp` speaks MCP Streamable HTTP with JSON replies and no server stream. An agent sends `Authorization: Bearer whale_...`. A missing or bad key gets 401 with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`. A request with a foreign `Origin` gets 403. Versions `2026-07-28`, `2025-11-25`, `2025-06-18`, and `2025-03-26` are accepted.

The tools are `wallet_status`, `deposit_address`, `balance`, `quote`, `swap`, and `transfer`. Before anything leaves the gateway, a tool must stay inside the agent's chains and actions, the wallet's slippage cap, its token list, and, for a transfer, its destination list. A refusal is an audit event. `swap` and `transfer` are plans: the executor answers with the route a swap would take, or the transfer it would send, and signs nothing.

To enable quotes, set `HOSTED_EXECUTOR_URL` (the executor's private address) and `HOSTED_SERVICE_TOKEN` on the gateway, and the same `HOSTED_SERVICE_TOKEN` on the executor. The token must be at least 32 characters and must differ from `EXECUTOR_AUTH_TOKEN`. The executor accepts it on `POST /hosted/commands` only.

### OAuth for MCP clients

A client that only knows the URL `https://<gateway>/mcp` gets the 401 challenge, reads `/.well-known/oauth-protected-resource/mcp`, then `/.well-known/oauth-authorization-server`. The issuer is the bare origin.

A client registers in one of two ways:
- By its metadata document URL as `client_id`. The gateway fetches it over https only, from a host that resolves only to public addresses, with no redirects, 64 KiB at most, and caches it for an hour. The document's `client_id` must equal its URL.
- Through `POST /oauth/register`, which the MCP spec now marks deprecated.

Redirect URIs must be https, a loopback `http` address, or an app scheme such as `cursor://`.

`GET /oauth/authorize` checks the client and the exact redirect URI before anything can go back to the client. It requires PKCE `S256` and the `resource` `https://<gateway>/mcp`. It then sends the browser to `/connect?request=<id>`. That page reads `GET /oauth/requests/:id`, shows the client name and the redirect host, warns on localhost, and signs the user in with Google if needed. The user picks a wallet and the agent limits and calls `POST /api/oauth/requests/:id/approve`, which creates the agent and a five-minute single-use code. The redirect carries `code`, `state`, and `iss`.

`POST /oauth/token` with form fields covers two grants:
- The authorization code grant returns a one-hour access token `wat_...`, bound to the MCP resource, and a 30-day refresh token `wrt_...`.
- A refresh rotates both tokens.

A replayed code, or a refresh token presented after rotation, revokes every OAuth token of that agent. `POST /oauth/revoke` revokes one token. The tokens are stored as SHA-256 only.

### Passkeys

`POST /api/passkeys/options` returns creation options for an ES256 passkey, with this origin's host as the relying party and user verification required. `POST /api/passkeys` with `{ credential, label }` verifies the response in `node:crypto`, with no WebAuthn library. The check covers the challenge (single use, five minutes), the origin, the relying-party hash, user presence and verification, and the credential id. Whale stores the public key and the counter.

A sensitive action asks for a step-up. `POST /api/passkeys/step-up` with `{ action }` returns a challenge bound to the SHA-256 of that action. The route that performs the action recomputes the hash and calls `verifyStepUp`, so an assertion approves that one action once. A counter that does not move forward is refused, unless the authenticator never counts, which is the case for synced passkeys.

### Enclave wallets

An enclave wallet takes three steps. Each step reads or writes Turnkey, and none gives Whale root.

1. `POST /api/wallets/:id/enclave/options`, then `POST /api/wallets/:id/enclave` with `{ credential, label }`. The gateway verifies the new passkey, then creates a Turnkey sub-organization:
   - The only root user is `owner`, holding that passkey, with a quorum of one.
   - Email, SMS, and OTP sign-in are disabled, so the passkey is the only way in.
   - One HD wallet holds an EVM account and a Solana account.

   The addresses are stored and the wallet stays `pending`.
2. The browser, signed with the user's passkey, adds the delegate user and the policies that `GET /api/wallets/:id/enclave/delegation` returns. The delegate holds the executor's API key (`TURNKEY_DELEGATE_API_PUBLIC_KEY`). The policies are `turnkeyPolicyDocument` scoped to that user, the sub-organization's wallet, and the EVM chains in the wallet policy.
3. `POST /api/wallets/:id/enclave/confirm`. The gateway reads the sub-organization and activates the wallet only if all of these hold: the owner is the sole root and holds the registered passkey; exactly one user holds Whale's key, is not root, and holds nothing else; and the allow policies are exactly the rendered ones. Otherwise it answers `delegation_not_safe` with the problems, and writes an audit event.

The gateway needs these variables:
- `TURNKEY_PARENT_ORGANIZATION_ID`, `TURNKEY_PARENT_API_PUBLIC_KEY`, and `TURNKEY_PARENT_API_PRIVATE_KEY`. The parent key creates sub-organizations and can read them. It cannot sign inside one, because the sub-organization's only root is the user's passkey.
- `TURNKEY_DELEGATE_API_PUBLIC_KEY`, and the same `ROUTER_ALLOWLIST_JSON` and `MAX_NATIVE_VALUE_WEI` the executor uses.

Without these variables the enclave routes answer `enclave_unavailable`.

### Policy changes and freezing

`PUT /api/wallets/:id/policy` takes `{ baseVersion, document, assertion? }`. A stale `baseVersion` answers 409.

- **Narrowing** applies at once and supersedes any widening still waiting.
- **Widening** without an assertion answers 428. The client asks `POST /api/passkeys/step-up` for `{ kind: "policy.widen", walletId, baseVersion, document }`, signs it, and sends the assertion. The change then waits 24 hours, and `DELETE /api/wallets/:id/policy/pending` cancels it.

Each gateway sweeps due changes once a minute. A change applies only on the version it was approved against. Otherwise it is marked superseded.

Two routes freeze, with no passkey needed:
- `POST /api/wallets/:id/freeze` stops every agent of that wallet at once.
- `POST /api/account/freeze` freezes every wallet of the account. The account itself stays usable, so the owner can still sign in and unfreeze.

`POST /api/wallets/:id/unfreeze` needs a step-up for `{ kind: "wallet.unfreeze", walletId }`.

An enclave wallet's Turnkey policy can drift from its wallet policy after a change. `GET /api/wallets/:id/enclave/delegation` reports `inSync` and the ids of every policy that names Whale's delegate. The dashboard then uses the owner's passkey to delete those policies (`DELETE_POLICIES`) and create the freshly rendered set. `POST /api/wallets/:id/enclave/resync` reads Turnkey back and records `wallet.delegation_resynced` only when the state is exactly right. Until then, Turnkey keeps the old rules: a chain added in the app stays refused, and a chain removed in the app is still refused by the app policy.

### Approvals and activity

A hosted `swap` is priced from its quote: net output plus fee and gas.
- Above the agent's effective per-transaction cap, it is refused, even if approved.
- Above the wallet's `approvalAboveUsd`, or when it cannot be priced, it returns `approval_required` with an approval id, and the agent calls again later with the same `idempotencyKey`.

A `transfer` asks for approval whenever the wallet has a threshold, because it has no quote to price it.

The owner sees pending approvals at `GET /api/approvals?status=pending`:
- Approving needs a passkey step-up for `{ kind: "approval.approve", approvalId, command }`.
- Denying needs none.
- An approval lasts an hour and is spent by one retry of the exact command. The same `idempotencyKey` with a different command is refused.

`GET /api/activity` lists the account's audit events, newest first, 50 at a time with `before=<id>`. Refusals are listed with everything else.

### Webhooks and backup passkeys

`POST /api/webhooks` with `{ url, format, events }` registers up to five endpoints per account, and returns a signing secret `whsec_...` once. It is stored sealed under `GATEWAY_SECRET`, so rotating that secret breaks existing webhooks.

The URL rules: https on port 443, a host name, and no credentials. Each delivery resolves the host itself, refuses private, loopback, link-local, and mapped addresses, connects to the address it checked, follows no redirects, and times out after 5 s.

What a delivery carries:
- **`whale` format:** the audit event as JSON. `Whale-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` and `Whale-Event-Id` are the headers.
- **`slack` format:** `{ "text": ... }`.

A delivery is queued in the same statement that writes its audit event. Each gateway sends due deliveries every 15 s. A non-2xx answer retries after 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours, then gives up. A webhook disables itself after 50 consecutive failures. `POST /api/webhooks/:id/test` pings one endpoint.

Settings adds a backup passkey on Whale. For every enclave wallet, the current passkey then approves adding the new one to the Turnkey owner, through `CREATE_AUTHENTICATORS_V2`.

### Self-hosted signers

A `self_hosted` wallet starts `pending`. The dashboard asks for a passkey step-up, `{ kind: "signer.register", walletId }`, and then `POST /api/wallets/:id/signer/code` returns a ten-minute code. A passkey is required because whoever registers decides the wallet's deposit addresses. On the user's machine, `whale-signer connect` posts both addresses and both proofs to `POST /signer/v1/register`.

The gateway accepts the registration only if all of these hold:
- The code is unused, unexpired, and for this wallet. It is spent on the first try, right or wrong.
- The EIP-191 signature recovers the EVM address.
- The ed25519 signature verifies under the Solana address.

It then stores the addresses, activates the wallet, and returns a signer token `wsig_...` once.

`whale-signer serve` long-polls `GET /signer/v1/jobs?wait=25` with that token and answers on `POST /signer/v1/jobs/:id/result`:
- A job is leased for 60 seconds. An unanswered lease goes back to the queue.
- A frozen wallet's signer still authenticates but gets no work.
- A revoked signer gets 401.

Nothing creates signing jobs while hosted live is closed. `enqueueJob` is what the live path will call.

## Start the executor

`EXECUTOR_AUTH_TOKEN` is required and must be at least 16 characters.

```bash
export PORT=8788
export EXECUTOR_AUTH_TOKEN='a token of at least 16 characters'
pnpm run start:executor
```

`GET /health` returns `{"ok":true}`. `GET /status` with that bearer returns the public config, including `live`. With `WHALE_BROADCAST` unset, `live` is false.

## Use the CLI

`pnpm run start:cli` runs `node dist/src/cli.js`.

```bash
pnpm run start:cli quote --sell-chain base --sell-address 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --sell-symbol USDC --sell-decimals 6 --buy-chain base --buy-address 0x4200000000000000000000000000000000000006 --buy-symbol WETH --buy-decimals 18 --sell-amount 1 --slippage-bps 50
```

`swap`, `balance`, and `transfer` are the other commands. A dry-run swap reports `nothing was broadcast`. `bridge` on the CLI exits before a fetch. The error says bridge quotes are not fetched yet.

## Start MCP

`pnpm run start:mcp` speaks stdio. The tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`.

`wallet_status` reads `GET /status` on `EXECUTOR_URL`. The default in `.mcp.json` is `http://127.0.0.1:8788`. Set `EXECUTOR_AUTH_TOKEN` to the executor token. `swap` and `transfer` stay dry-run in this server.

## Load Turnkey

Do this when you intend to broadcast. Do not paste keys into chat.

1. In Turnkey, create an organization and a wallet with an Ethereum account and a Solana account.
2. Create an API user that can sign and nothing else. Store the private key in `TURNKEY_API_PRIVATE_KEY`. Set `TURNKEY_API_PUBLIC_KEY` and `TURNKEY_ORGANIZATION_ID`.
3. Copy the addresses into `TURNKEY_EVM_ADDRESS` and `TURNKEY_SOLANA_ADDRESS`.
4. Approve each router once with the root quorum, then set `APPROVAL_CACHE_JSON` to those allowances. Set `ZEROX_SETTLER_ALLOWLIST_JSON` before live mode. Read the current taker-submitted Settler from the 0x deployer `0x00000000000004533Fe15556B1E086BB1A72cEae` with `ownerOf(2)`, and keep the previous one from `prev(2)` during a rotation.
5. Set `WHALE_BROADCAST` to the exact string `true` only after `DATABASE_URL` is set. Boot throws `live mode requires Turnkey` when the signer is missing. Boot throws `live mode requires DATABASE_URL so the daily cap survives restart` when the database URL is missing.

`pnpm test` does not call an exchange and does not broadcast. For the kill switch and for revocation, read [Threat model](threat-model.md).
