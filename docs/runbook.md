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
