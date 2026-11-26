---
name: whale-wallet
description: Call the Whale wallet. Quote, dry-run swap, rank a bridge, read a balance, read or trade Hyperliquid perps, or dry-run a transfer. Use when an agent needs to move or inspect value across EVM, Solana, and Hyperliquid.
---

# Whale wallet

Whale is a multichain wallet. The MCP tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, `perp`, `perp_positions`, `transfer`, `bitcoin_wallet`, and `send_bitcoin`. Prefer the MCP tools. The CLI is `node dist/src/cli.js` (`quote`, `swap`, `bridge`, `balance`, `perp-positions`, and `transfer`).

## Rules

- Call `wallet_status` before a command that can move value. Say the mode and the caps.
- `swap` is dry-run. It broadcasts nothing.
- `bridge` fetches routes from LI.FI, Across, and Relay and ranks them by fee. The destination must be an owner address on an enabled chain. The plan sets `broadcast` to false.
- `transfer` dry-run returns `would_send` and broadcasts nothing. Live transfer is skipped. Local signing is not wired for live sends.
- Amounts are smallest-unit strings.
- `perp_positions` reads the Hyperliquid perp account and moves nothing. Its numbers are Hyperliquid's decimal strings, not smallest units. A short has side `short`. Funding paid is positive. An open order has `kind` `limit` or `trigger`. A trigger order fires at `triggerPx` when `triggerCondition` holds. With `isPositionTpsl` true it closes the whole position, and its size is `entire position`. A trailing stop that waits for activation has `triggerPx` null. A stop that has fired and still rests is a `limit`. An order Whale cannot read is in `unreadableOrders`, so do not treat `openOrders` as complete while that list is not empty.
- `perp` places an immediate-or-cancel Hyperliquid perp order sized from `notionalUsd` (in USD, not smallest units) and needs whale-signer. It trades on the account whale-signer's key signs for, and reads the position in `coin` from `HYPERLIQUID_ACCOUNT_ADDRESS` or whale-signer's EVM address, skipping when unreadable. When that address is another account, a dry run included, it refuses unless the key is an approved agent of it. With no position it sets 1x isolated leverage first. With a position open, the order runs at that position's margin mode and leverage, cross included. It takes no leverage argument. A dry run does not check `HYPERCORE_SELL_LIMITS`, and a live sell is refused unless `HYPERCORE_SELL_LIMITS` sets `hypercore:perp:<asset>:sold`.
- Never ask for a seed phrase, a private key, a passphrase, or a Turnkey secret. Never print one.
- A quote is not a fill. Wait for a landed transaction hash before saying value moved.

## Out of scope

Listing alerts, watchlists, and snipers are not wallet commands. They call Whale. They do not live in this package.
