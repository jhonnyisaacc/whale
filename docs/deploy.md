# Deploy the listing trader on Railway

Deploy two services from this directory. Do not point them at the Rocket research app. Leave live mode off until you have read [the threat model](threat-model.md) and loaded a key on purpose.

## Build

Railway's root directory is `wallet`. The Dockerfile pins `node:22-bookworm-slim` by digest and runs `npm ci --ignore-scripts`. The default command is `node dist/src/resolver-server.js`. `railway.json` checks `GET /health`. Do not add a public domain. Boot throws if `RAILWAY_PUBLIC_DOMAIN` is present. Call the services on the private network URL only.

`uuid` is overridden to `11.1.1`. `stream-json` is overridden to `3.7.0`. jayson still imports the old `StreamValues` path, so `scripts/patch-jayson-stream-json.mjs` runs after `npm ci` and points that require at the 3.7 stream adapters. The image does not install `@solana/web3.js` 3.

Create a second service from the same root and set its start command to:

```bash
node dist/src/executor-server.js
```

Give the resolver and the executor different `PORT` values if the platform does not inject one. Railway injects `PORT`.

## Data

Attach Postgres to the resolver. Copy `DATABASE_URL` to the executor as well when you later enable live mode. Use the private network URL. Both services read that variable. The resolver writes the watchlist. The executor writes the spend journal only in live mode.

Set `REFRESH_ENABLED=true` on the resolver. Leave it unset on a laptop if you do not want the coin-list fetch.

## Secrets

Set these as Railway variables, not in the repo. The resolver needs `RESOLVER_AUTH_TOKEN`, the executor needs `EXECUTOR_AUTH_TOKEN`, and the two must differ (16 characters or more each). The executor also needs `RESOLVER_AUTH_TOKEN` to call the resolver. Boot refuses the old shared `AUTH_TOKEN` name.

Turnkey, on the executor:

- `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`
- `TURNKEY_EVM_ADDRESS`, `TURNKEY_SOLANA_ADDRESS`, `TURNKEY_HYPERLIQUID_ADDRESS`
- `ROUTER_ALLOWLIST_JSON` as a map of chain id to router addresses, and, after the ceremony, `APPROVAL_CACHE_JSON`

The keystore is not the live signer. Live mode ignores any request to use it.

Provider keys, only where you want that quote:

- `ZEROX_API_KEY`, `JUPITER_API_KEY`, `LIFI_API_KEY`, `LIFI_INTEGRATOR`
- `ONEINCH_API_KEY` (1inch Business KYC or KYB is the vendor's requirement)
- `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE`
- `KYBERSWAP_CLIENT_ID`, `VELORA_PARTNER`
- `ACROSS_API_KEY`, `ACROSS_INTEGRATOR_ID`, `RELAY_API_KEY`, `DEBRIDGE_ACCESS_TOKEN`
- `GOPLUS_API_KEY`, `BLOCKAID_API_KEY` only if `TOKEN_SCREENING=true`
- `COINGECKO_API_KEY` on the resolver and the executor. The public API takes one contract per price call, so the executor makes one call per token holding and chain every `PRICE_REFRESH_MS`

Live mode requires `ZEROX_API_KEY`, `ZEROX_SETTLER_ALLOWLIST_JSON` (see the [runbook](runbook.md)), and a `KYBERSWAP_CLIENT_ID` of your own. Also set `RPC_URL_<chainId>`, `SOLANA_RPC_URL` (add fallbacks with `RPC_URLS_<chainId>` and `SOLANA_RPC_URLS`; in live mode every one must be `https` or a `railway.internal` host), and `MEV_RPC_URL_1=https://rpc.flashbots.net` if you want private Ethereum delivery. In live mode `RESOLVER_URL` and `NOTIFIER_WEBHOOK_URL` must be `https` or a `railway.internal` host. `WALLET_HOLDINGS_JSON` names the mints. Live mode reads the amounts from chain and skips the trade when that read fails. `OWNER_WITHDRAW_ADDRESSES` is required before `WITHDRAW_ENABLED=true`. Withdraw also needs `ADMIN_TOKEN`, separate from both service tokens. `NOTIFIER_WEBHOOK_URL` receives the public report and nothing else.

Do not set `LISTING_TRADER_LIVE`. Health should show `live: false`. The collector posts alerts to `/listing` with the bearer token.

## Live mode

Set `LISTING_TRADER_LIVE` to the exact string `true` only after Turnkey and `DATABASE_URL` are present. The process exits on boot if either is missing, if a service token is short or reused, or if a public domain variable is set. `KILL_SWITCH=true` stops new buys without deleting the key. Run one executor replica: `railway.json` sets `numReplicas: 1` and a 20 second draining window, and the executor takes a Postgres advisory lock at boot so a second replica refuses to start. The ceremony, rotation, and revocation steps are in the [runbook](runbook.md).
