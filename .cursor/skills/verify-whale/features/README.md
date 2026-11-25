# Whale verification map

This directory is the maintained source for verifying what an agent can do with Whale. Read this index before you drive anything, then use the matching feature file as the recipe. `../SKILL.md` covers launch, doctor, evidence, and cleanup.

## Baseline preconditions

- A run is launched with `eval "$($W launch)"` from the repository root, where `W=.cursor/skills/verify-whale/scripts/whale-verify.mjs`.
- `$W doctor` exits 0.
- These shell variables are set. The address is a public burn address that no one holds a key for. The assets are Base and Arbitrum USDC and Base WETH in the MCP `Asset` shape.

```bash
D=0x000000000000000000000000000000000000dEaD
BASE_USDC='{"chain":{"kind":"evm","chainId":8453},"chainKey":"base","address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","symbol":"USDC","decimals":6}'
BASE_WETH='{"chain":{"kind":"evm","chainId":8453},"chainKey":"base","address":"0x4200000000000000000000000000000000000006","symbol":"WETH","decimals":18}'
ARB_USDC='{"chain":{"kind":"evm","chainId":42161},"chainKey":"arbitrum","address":"0xaf88d065e77c8cC2239327C5EDb3A432268e5831","symbol":"USDC","decimals":6}'
```

- Never drive an executor or MCP server that this run did not launch.

## Driving conventions

- Start every recipe from the baseline. Preconditions a feature needs beyond it are passed per call with `--set`, never exported into the run.
- Run MCP tools with `$W mcp <tool> '<json>'`, CLI commands with `$W cli -- <args>`, and executor routes with `$W http <METHOD> <route>`.
- Treat every command as literal. Keep chain keys, symbols, and smallest-unit amounts unchanged.
- Label every call `<sub-feature>-<entry>`, where the entry is `mcp`, `cli`, or `http`.
- Assert on stdout with `jq`. Read stderr for the evidence path.

## Proof and skip reporting

- Each sub-feature's proof is its evidence file: the call, the result, and `network`.
- A dry-run proof shows `sends: []`. A refusal proof shows `network: []`, because Whale refuses before it calls anyone.
- Live providers and RPCs change their numbers on every call. Assert shape, order, and reason strings, not fees or balances.
- Report an entry point you could not reach as skipped, with the attempted command and the unmet precondition. The hosted gateway is always skipped by this harness.
- Do not report a sub-feature as verified through a different entry point than the one its label names.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point, including ones this harness cannot reach.
3. `Driving it with whale-verify` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and its observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation detail out of the map unless it changes what a run observes.

## Features

- [Wallet status](./wallet-status.md) covers the executor's mode, caps, and enabled chains over MCP and HTTP, and token refusal.
- [Bridge routes](./bridge-routes.md) covers ranked LI.FI, Across, and Relay routes with `broadcast: false` over MCP and the CLI, six refusals, and the smallest-unit amount check.
- [Swap and quote](./swap-and-quote.md) covers dry-run swaps and quotes over MCP and the CLI, their guards, and how each entry treats `live`.
- [Balance](./balance.md) covers native EVM and Solana SPL holdings over MCP and the CLI, and the unset-RPC and unknown-chain reasons.
- [Transfer](./transfer.md) covers dry-run `would_send` over MCP and the CLI, and the live transfer that skips without whale-signer.

## Not yet mapped

These are user-facing, and no feature file covers them yet. Add one before you claim them as verified.

- `perp_positions` over MCP and `perp-positions` over the CLI read a Hyperliquid account. They need `HYPERLIQUID_ACCOUNT_ADDRESS` exported before launch.
- `perp` over MCP needs whale-signer even in dry-run, so this harness gets `skipped`.
- `bitcoin_wallet` and `send_bitcoin` need `BITCOIN_NETWORK` and a whale-signer keystore.
- Executor `POST /execute` and `POST /rebalance` are the strategy entry points. They take engine shapes (`SwapIntent`, quotes), not a `WalletCommand`.
- The hosted gateway (MCP over HTTP, OAuth, passkeys, approvals, webhooks) and the `web/` dashboard need Postgres, a Google OAuth client, and a browser with a passkey.
- The self-hosted Rust signer in `signer/` is proved by `cargo test --locked`, not by this harness.
