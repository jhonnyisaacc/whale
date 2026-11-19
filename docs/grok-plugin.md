# Use Whale as a Grok plugin

The wallet ships as a Grok plugin named `rocket`. The manifest sits in `.grok-plugin/plugin.json`. The MCP entry sits in `.mcp.json`. Skills sit under `skills/`.

## Tools

The `.mcp.json` entry runs `node scripts/mcp-server.mjs` over stdio. The launcher builds the wallet on its first start, so a fresh clone works. The server holds no keys and signs nothing.

| Tool | What it does | Broadcast |
| --- | --- | --- |
| `wallet_status` | Reads executor `GET /status` | No |
| `quote` | Quotes a swap, or skips when no provider key is set | No |
| `swap` | Dry-run swap through `run` | No |
| `bridge` | Fetches and ranks bridge routes | No |
| `balance` | Reads holdings for one chain and address | No |
| `transfer` | Dry-run transfer | No |

## Install

Start the executor. The plugin then starts MCP through `.mcp.json`. From a checkout, `pnpm run start:mcp` starts it after `pnpm run build`.

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:executor
```

`pnpm run start:cli` runs `node dist/src/cli.js` for the same command names. Set `EXECUTOR_URL` and `EXECUTOR_AUTH_TOKEN` so `wallet_status` can read the executor. The default URL in `.mcp.json` is `http://127.0.0.1:8788`.

Leave `WHALE_BROADCAST` unset. If `LISTING_TRADER_LIVE` is set, boot throws. If `WITHDRAW_ENABLED` is set, boot throws. `POST /withdraw` is absent.

## Security

The plugin adds no money path. `swap` and `transfer` stay dry-run inside the MCP server. A live executor still requires `WHALE_BROADCAST` set to `true`, plus Turnkey, screening, simulation, the spend reservation, and the signing policy. The agent never asks for a seed phrase or a key.
