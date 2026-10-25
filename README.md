# Whale

Whale is a multichain wallet for AI agents. Grok, Claude, Hermes, and other hosts can quote, swap, bridge, check a balance, and transfer through one command shape. Strategies such as a listing sniper stay outside the wallet and call in.

Fast swaps and bridges across EVM and Solana are the product. Signing stays on the lowest-latency path that the policy allows. Dry-run is the default. This package does not broadcast a mainnet transaction on its own.

## Architecture

The public shape is `WalletCommand` in `src/commands.ts`. An `Asset` names a chain, a chain key, an address, a symbol, and decimals. Amounts at the boundary are smallest-unit strings.

`run(command)` dispatches five commands.

| Command | Result |
| --- | --- |
| `quote` | A route quote, or `skipped` when no provider is injected. |
| `swap` | A dry-run execution report. Nothing is broadcast. |
| `bridge` | A rebalance plan. `broadcast` stays false. |
| `balance` | Holdings for one chain and address. |
| `transfer` | `would_send` in dry-run. Live is `skipped`. |

Under that boundary the existing engines stay. `src/aggregators/` races quotes. `src/routing.ts` plans hops. `src/executor.ts` is the swap state machine. `src/broadcast/` sends a signed transaction when a caller has already chosen live mode inside the engine. `src/signing-policy.ts` is the last check before a signature. `src/chains.ts` is the chain table.

A swap command builds an internal swap intent and, when an executor is injected, calls that engine. Quote and swap with no injected provider return `skipped` and do not touch the network.

The layout follows the Binah rules at <https://github.com/jhonnyisaacc/binah> (rules v4.6, 2026-10-20). Binah's host blueprint is a React and Hono app, so this tree does not copy that folder layout. It keeps the rules that fit a Node wallet. One product directory, one folder per feature, a typed contract, a short `AGENTS.md`, a `feature-map.md`, a file-size ratchet, import boundaries, and one check command.

## How an agent calls Whale

MCP. `npm run start:mcp` speaks stdio. The tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`. Each tool parses its arguments into a `WalletCommand`. Host manifests live in `.grok-plugin`, `.claude-plugin`, `.codex-plugin`, and `.muse-plugin`. The skill is `skills/whale-wallet/SKILL.md`.

CLI. After `npm run build`, `node dist/src/cli.js quote` takes `--sell-chain`, `--sell-address`, `--sell-symbol`, `--buy-chain`, `--buy-address`, `--buy-symbol`, `--sell-amount`, and `--slippage-bps`. `swap`, `balance`, and `transfer` are the other commands. `bridge` is refused on the CLI until a quote can be fetched.

HTTP. `npm run start:executor` serves `/health`, `/status`, `/execute`, `/rebalance`, and `/withdraw`. `/execute` with the executor token forces dry-run. A strategy bearer can ask the engine to run under that strategy's cap. This service does not accept listing alerts.

## Not in this tree

Listing match, watchlist refresh, and the receive-then-buy flow stay in Rocket. Rocket calls Whale later through a dry-run client. See <https://github.com/jhonnyisaacc/rocket>.

## Check

```bash
npm run check
```

That runs the file-size ratchet, the import boundaries, the TypeScript build, and the unit tests. Tests use fakes. They do not acquire market data and they do not broadcast.

## Still open

Real bridge support. `planRebalance` ranks quotes the caller already supplied. It does not request a quote from LI.FI, Across, Relay, or deBridge, and it does not broadcast. The TODO is in `src/commands.ts`.

Local signing for live transfers. The keystore can decrypt for a dry-run. `loadManagedSigner` refuses raw keys when the process is live and requires Turnkey. A live `transfer` command returns `skipped`. The TODO is in `src/commands.ts`.
