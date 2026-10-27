# Deploy Whale on Railway

Deploy one executor from this repository. Leave `WHALE_BROADCAST` unset until you have read [Threat model](threat-model.md) and loaded a Turnkey key on purpose.

## Build

The Railway root is the repository root. The Dockerfile pins `node:22-bookworm-slim` by digest and runs `npm ci --ignore-scripts`. The Dockerfile command is `node dist/src/executor-server.js`. That is the same file `npm run start:executor` runs. `railway.json` checks `GET /health`. Do not add a public domain. Boot throws if `RAILWAY_PUBLIC_DOMAIN` is present. Call the executor on the private network URL.

`npm run start:cli` and `npm run start:mcp` run on a laptop. The container command stays `node dist/src/executor-server.js`. The MCP tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`.

`uuid` is overridden to `11.1.1`. `stream-json` is overridden to `3.7.0`. jayson still imports the old `StreamValues` path, so `scripts/patch-jayson-stream-json.mjs` runs after `npm ci` and points that require at the 3.7 stream adapters. The image does not install `@solana/web3.js` 3.

Railway injects `PORT`.

## Data

Attach Postgres when you later enable live mode. Use the private network URL. The executor writes the spend journal only in live mode. When `DATABASE_URL` is set, the executor takes a Postgres advisory lock at boot, so a second replica refuses to start.

## Secrets

Keep these out of the repo. Set them as Railway variables. The executor needs `EXECUTOR_AUTH_TOKEN` of 16 characters or more. Boot refuses the old shared `AUTH_TOKEN` name.

Set these Turnkey variables on the executor.

- `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`
- `TURNKEY_EVM_ADDRESS`, `TURNKEY_SOLANA_ADDRESS`, `TURNKEY_HYPERLIQUID_ADDRESS`
- `ROUTER_ALLOWLIST_JSON` as a map of chain id to router addresses, and `APPROVAL_CACHE_JSON` after the router approval in the [runbook](runbook.md)

Live mode refuses `KEYSTORE_PATH` and `KEYSTORE_PASSPHRASE`.

Set a provider key only for a quote source you want.

- `ZEROX_API_KEY`, `JUPITER_API_KEY`, `LIFI_API_KEY`, `LIFI_INTEGRATOR`
- `ONEINCH_API_KEY` (1inch Business KYC or KYB is the vendor's requirement)
- `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE`
- `KYBERSWAP_CLIENT_ID`, `VELORA_PARTNER`
- `ACROSS_API_KEY`, `ACROSS_INTEGRATOR_ID`, `RELAY_API_KEY`, `DEBRIDGE_ACCESS_TOKEN`
- `GOPLUS_API_KEY`, `BLOCKAID_API_KEY` only if `TOKEN_SCREENING=true`
- `COINGECKO_API_KEY` on the executor. The public API takes one contract per price call, so the executor makes one call per token holding and chain every `PRICE_REFRESH_MS`

Live mode requires `ZEROX_API_KEY`, `ZEROX_SETTLER_ALLOWLIST_JSON` (see the [runbook](runbook.md)), and a `KYBERSWAP_CLIENT_ID` of your own. Also set `RPC_URL_<chainId>` and `SOLANA_RPC_URL`. Add fallbacks with `RPC_URLS_<chainId>` and `SOLANA_RPC_URLS`. In live mode every RPC URL must be `https` or a `railway.internal` host. Set `MEV_RPC_URL_1=https://rpc.flashbots.net` if you want private Ethereum delivery. In live mode `NOTIFIER_WEBHOOK_URL` must be `https` or a `railway.internal` host. `WALLET_HOLDINGS_JSON` names the mints. Live mode reads the amounts from chain and skips the trade when that read fails. `NOTIFIER_WEBHOOK_URL` receives the public report and nothing else.

Default boot leaves `WHALE_BROADCAST` unset. `GET /health` returns `{"ok":true}`. `GET /status` shows `live` false. If `LISTING_TRADER_LIVE` is set, boot throws. If `WITHDRAW_ENABLED` is set, boot throws. `POST /withdraw` is absent.

## Live mode

Set `WHALE_BROADCAST` to the exact string `true` only after Turnkey and `DATABASE_URL` are present. The process exits on boot if either is missing, if a service token is short or reused, or if a public domain variable is set. `KILL_SWITCH=true` stops new buys without deleting the key. Run one executor replica. `railway.json` sets `numReplicas: 1` and a 20 second draining window. Turnkey setup is in the [runbook](runbook.md). Revocation is in the [threat model](threat-model.md).
