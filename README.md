# Whale

Whale is a multichain wallet for AI agents. Grok, Claude, Hermes, and other hosts can quote, swap, bridge, check a balance, and transfer through one command shape. Strategies such as a listing sniper stay outside the wallet and call in.

Fast swaps and bridges across EVM and Solana are the product. Signing stays on the lowest-latency path that the policy allows. Dry-run is the default. This package does not broadcast a mainnet transaction on its own.

## Architecture

The public shape is `WalletCommand` in `src/commands.ts`. An `Asset` names a chain, a chain key, an address, a symbol, and decimals. Amounts at the boundary are smallest-unit strings.

`run(command)` dispatches five commands.

| Command | Result |
| --- | --- |
| `quote` | A route quote, or `skipped` when no provider is injected. |
| `swap` | `would_swap` with the best signable route a dry run quotes, or `skipped` with the reason. Nothing is signed or broadcast. With whale-signer, `mode: "live"` and `notionalUsd` run the live path below. |
| `bridge` | Routes fetched from LI.FI, Across, and Relay, ranked by fee, and a plan. `broadcast` stays false. |
| `balance` | Holdings for one chain and address. |
| `transfer` | `would_send` in dry-run. With whale-signer, `mode: "live"` runs the live path below. Without it, live is `skipped`. |

Under that boundary the existing engines stay. `src/aggregators/` races quotes. `src/routing.ts` plans hops. `src/executor.ts` is the swap state machine. `src/broadcast/` sends a signed transaction when a caller has already chosen live mode inside the engine. `src/signing-policy.ts` is the last check before a signature. `src/chains.ts` is the chain table.

A swap command builds an internal swap intent and, when an executor is injected, calls that engine. Quote and swap with no injected provider return `skipped` and do not touch the network.

The layout follows the Binah rules at <https://github.com/jhonnyisaacc/binah> (rules v4.6, 2026-10-20). Binah's host blueprint is a React and Hono app, so this tree does not copy that folder layout. It keeps the rules that fit a Node wallet. One product directory, one folder per feature, a typed contract, a short `AGENTS.md`, a `feature-map.md`, a file-size ratchet, import boundaries, and one check command.

## How an agent calls Whale

MCP. `pnpm run start:mcp` speaks stdio. The tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`. Each tool parses its arguments into a `WalletCommand`. Host manifests live in `.grok-plugin`, `.claude-plugin`, `.codex-plugin`, `.muse-plugin`, and the root `plugin.json` for Hermes. Each starts `scripts/mcp-server.mjs`, which builds a fresh clone on its first start, so an install straight from GitHub lists the tools. The skill is `skills/whale-wallet/SKILL.md`.

CLI. After `pnpm run build`, `node dist/src/cli.js quote` takes `--sell-chain`, `--sell-address`, `--sell-symbol`, `--buy-chain`, `--buy-address`, `--buy-symbol`, `--sell-amount`, and `--slippage-bps`. `swap`, `bridge`, `balance`, and `transfer` are the other commands. `bridge` takes `--from-chain`, `--to-chain`, `--asset` (USDC or USDT), `--amount` in the smallest unit, and `--to`.

HTTP. `pnpm run start:executor` serves `/health`, `/status`, `/execute`, `/rebalance`, and `/withdraw`. `/execute` with the executor token forces dry-run. A strategy bearer can ask the engine to run under that strategy's cap. This service does not accept listing alerts.

## Not in this tree

Listing match, watchlist refresh, and the receive-then-buy flow stay in Rocket. Rocket calls Whale later through a dry-run client. See <https://github.com/jhonnyisaacc/rocket>.

## Check

```bash
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` runs the file-size ratchet, the import boundaries, the TypeScript build, and the unit tests. It needs Node 22.12 or later. Corepack picks the pnpm version pinned in `package.json`. Tests use fakes. They do not acquire market data and they do not broadcast. Set `TEST_DATABASE_URL` to a Postgres you can drop schemas in to run the database tests too. CI does. Each run uses its own schema.

## Still open

Live bridging. `bridge` fetches and ranks routes but never signs or sends one. deBridge is not called, because its fixed fee is charged in the native coin outside the quote and this path has no native price.

Host manifests do not forward `WHALE_SIGNER_KEYSTORE` or the cap and allowlist variables a local live send reads. Set them in the environment that starts `mcp-server.js`.

## Local live sends with whale-signer

Set `WHALE_SIGNER_KEYSTORE` to a whale-signer keystore and the stdio MCP server listens on `127.0.0.1:8790` (`WHALE_SIGNER_PORT`) for `whale-signer serve`. The token is the `.token` file beside the keystore, the one `serve` reads. A live `swap` or `transfer` then runs these steps in order:
1. Whale builds the transaction. A swap goes through the executor in live mode: screening, liquidity, the per-trade and daily USD caps, the firm quote, and the minimum output. A transfer must pay an `OWNER_WITHDRAW_ADDRESSES` entry inside the same USD caps.
2. Whale simulates it and applies its app signing policy.
3. Whale hands the job to whale-signer. Its refusal is a tool error that names the job and the signer's reasons. Whale verifies every signature against the keystore's address.
4. With `WHALE_BROADCAST` unset, the result is `signed` with the job id and hash. The signed bytes are not returned and nothing is sent.

The daily USD total for local sends lives in the MCP process and starts at zero when it restarts. whale-signer's own ledger is the limit that survives a restart.
