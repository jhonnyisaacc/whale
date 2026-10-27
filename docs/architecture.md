# How a command reaches a signature

An agent quotes, swaps, reads a balance, or transfers through one command shape. The CLI and the MCP server both parse that shape and call `run`. The HTTP process is the executor. This tree has no resolver process. Listing match and watchlist refresh stay in Rocket, which calls in later through a dry-run client.

## Dry-run by default

Default boot leaves `WHALE_BROADCAST` unset, so `config.live` is false. A dry-run swap returns a report that says nothing was broadcast and does not call the send path. The local keystore can decrypt for a dry-run. Live mode refuses raw key material, including `KEYSTORE_PATH`.

Set `WHALE_BROADCAST` to the exact string `true` only when Turnkey and `DATABASE_URL` are loaded. Boot then throws `live mode requires Turnkey` if the signer is missing.

`LISTING_TRADER_LIVE` and `WITHDRAW_ENABLED` throw when set. `POST /withdraw` is absent. The registered routes are `GET /health`, `GET /status`, `GET /provider-health`, `POST /execute`, and `POST /rebalance`. `POST /rebalance` plans a bridge and sets `broadcast` to false.

## Scripts and tools

`start:executor` runs `node dist/src/executor-server.js`. The Dockerfile command is that same file. The Railway root is the repository root. `start:cli` runs `node dist/src/cli.js`. `start:mcp` runs `node dist/src/mcp-server.js` on stdio.

The MCP tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`. `wallet_status` reads executor `GET /status`. `quote` returns a route, or skips when no provider key is present. `swap` and `transfer` stay dry-run in the MCP server. `bridge` on the CLI exits before a fetch. The MCP `bridge` tool ranks quotes the caller already supplied and does not broadcast.

## Live signing

`src/signing-policy.ts` is the last check before a signature. A live send needs screening, simulation, the spend reservation, and that policy. `src/aggregators/` races quotes. `src/executor.ts` is the swap state machine. `src/broadcast/` sends a signed transaction only after a caller has already chosen live mode. See [Fees and route choice](fees.md), [ADR 0001](adr/0001-turnkey-signer.md), and [ADR 0002](adr/0002-service-boundaries.md).
