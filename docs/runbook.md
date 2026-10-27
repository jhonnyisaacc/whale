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
npm run create-wallet
```

The file mode is `0600`. `*.keystore.json` is gitignored. Live mode refuses `KEYSTORE_PATH` and `KEYSTORE_PASSPHRASE`. The production signer is Turnkey. See [Load Turnkey](#load-turnkey).

## Build

```bash
npm run build
```

## Start the executor

`EXECUTOR_AUTH_TOKEN` is required and must be at least 16 characters.

```bash
export PORT=8788
export EXECUTOR_AUTH_TOKEN='a token of at least 16 characters'
npm run start:executor
```

`GET /health` returns `{"ok":true}`. `GET /status` with that bearer returns the public config, including `live`. With `WHALE_BROADCAST` unset, `live` is false.

## Use the CLI

`npm run start:cli` runs `node dist/src/cli.js`.

```bash
npm run start:cli -- quote --sell-chain base --sell-address 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --sell-symbol USDC --sell-decimals 6 --buy-chain base --buy-address 0x4200000000000000000000000000000000000006 --buy-symbol WETH --buy-decimals 18 --sell-amount 1 --slippage-bps 50
```

`swap`, `balance`, and `transfer` are the other commands. A dry-run swap reports `nothing was broadcast`. `bridge` on the CLI exits before a fetch. The error says bridge quotes are not fetched yet.

## Start MCP

`npm run start:mcp` speaks stdio. The tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`.

`wallet_status` reads `GET /status` on `EXECUTOR_URL`. The default in `.mcp.json` is `http://127.0.0.1:8788`. Set `EXECUTOR_AUTH_TOKEN` to the executor token. `swap` and `transfer` stay dry-run in this server.

## Load Turnkey

Do this when you intend to broadcast. Do not paste keys into chat.

1. In Turnkey, create an organization and a wallet with an Ethereum account and a Solana account.
2. Create an API user that can sign and nothing else. Store the private key in `TURNKEY_API_PRIVATE_KEY`. Set `TURNKEY_API_PUBLIC_KEY` and `TURNKEY_ORGANIZATION_ID`.
3. Copy the addresses into `TURNKEY_EVM_ADDRESS` and `TURNKEY_SOLANA_ADDRESS`.
4. Approve each router once with the root quorum, then set `APPROVAL_CACHE_JSON` to those allowances. Set `ZEROX_SETTLER_ALLOWLIST_JSON` before live mode. Read the current taker-submitted Settler from the 0x deployer `0x00000000000004533Fe15556B1E086BB1A72cEae` with `ownerOf(2)`, and keep the previous one from `prev(2)` during a rotation.
5. Set `WHALE_BROADCAST` to the exact string `true` only after `DATABASE_URL` is set. Boot throws `live mode requires Turnkey` when the signer is missing. Boot throws `live mode requires DATABASE_URL so the daily cap survives restart` when the database URL is missing.

`npm test` does not call an exchange and does not broadcast. For the kill switch and for revocation, read [Threat model](threat-model.md).
