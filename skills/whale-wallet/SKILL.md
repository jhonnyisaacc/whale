---
name: whale-wallet
description: Call the Whale wallet. Quote, dry-run swap, rank a bridge, read a balance, or dry-run a transfer. Use when an agent needs to move or inspect value across EVM and Solana.
---

# Whale wallet

Whale is a multichain wallet. The commands are `quote`, `swap`, `bridge`, `balance`, and `transfer`. Prefer the MCP tools. The CLI is `node dist/src/cli.js`.

## Rules

- Call `wallet_status` before a command that can move value. Say the mode and the caps.
- `swap` is dry-run. It broadcasts nothing.
- `bridge` only ranks quotes you already have. The plan sets `broadcast` to false.
- `transfer` dry-run returns `would_send` and broadcasts nothing. Live transfer is skipped. Local signing is not wired for live sends.
- Amounts are smallest-unit strings.
- Never ask for a seed phrase, a private key, a passphrase, or a Turnkey secret. Never print one.
- A quote is not a fill. Wait for a landed transaction hash before saying value moved.

## Out of scope

Listing alerts, watchlists, and snipers are not wallet commands. They call Whale. They do not live in this package.
