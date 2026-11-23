---
name: whale-wallet
description: Call the Whale wallet. Quote, dry-run swap, rank a bridge, read a balance, read Hyperliquid perp positions, or dry-run a transfer. Use when an agent needs to move or inspect value across EVM and Solana.
---

# Whale wallet

Whale is a multichain wallet. The commands are `quote`, `swap`, `bridge`, `balance`, `perp_positions`, and `transfer`. Prefer the MCP tools. The CLI is `node dist/src/cli.js`.

## Rules

- Call `wallet_status` before a command that can move value. Say the mode and the caps.
- `swap` is dry-run. It broadcasts nothing.
- `bridge` fetches routes from LI.FI, Across, and Relay and ranks them by fee. The destination must be an owner address on an enabled chain. The plan sets `broadcast` to false.
- `transfer` dry-run returns `would_send` and broadcasts nothing. Live transfer is skipped. Local signing is not wired for live sends.
- Amounts are smallest-unit strings.
- `perp_positions` reads the Hyperliquid perp account and moves nothing. Its numbers are Hyperliquid's decimal strings, not smallest units. A short has side `short`. Funding paid is positive. An open order has `kind` `limit` or `trigger`. A trigger order fires at `triggerPx` when `triggerCondition` holds. With `isPositionTpsl` true it closes the whole position, and its size is `entire position`. A stop that has fired and still rests is a `limit`. An order Whale cannot read is in `unreadableOrders`, so do not treat `openOrders` as complete while that list is not empty.
- Never ask for a seed phrase, a private key, a passphrase, or a Turnkey secret. Never print one.
- A quote is not a fill. Wait for a landed transaction hash before saying value moved.

## Out of scope

Listing alerts, watchlists, and snipers are not wallet commands. They call Whale. They do not live in this package.
