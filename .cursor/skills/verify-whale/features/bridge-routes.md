# Bridge routes

Bridge lets an agent ask how to move USDC or USDT from one enabled chain to an owner address on another. Whale asks LI.FI, Across, and Relay for routes, ranks them by fee, and returns a plan whose `broadcast` is false. It refuses a destination off the owner allowlist, a disabled or repeated chain, any asset but USDC or USDT, an amount over the bridge cap, or a source chain with no hot wallet address, and it refuses before any provider is called.

## Sub-features

- `bridge-rank` returns `plan.kind` `would_send` with the cheapest quote inside the fee cap, `quotes` sorted by `feeUsd`, and `plan.broadcast` false.
- `bridge-refuse-allowlist` refuses a destination missing from `OWNER_WITHDRAW_ADDRESSES`.
- `bridge-refuse-same-chain` refuses a destination on the source chain.
- `bridge-refuse-disabled` refuses a chain that is not enabled. Ethereum is off by default.
- `bridge-refuse-asset` refuses any asset but USDC or USDT.
- `bridge-refuse-cap` refuses an amount above `MAX_BRIDGE_USD`, which defaults to 25.
- `bridge-refuse-sender` refuses a source chain with no hot wallet address (`TURNKEY_EVM_ADDRESS` or `TURNKEY_SOLANA_ADDRESS`).
- `bridge-bad-amount` rejects an amount that is not a whole number in the smallest unit.

## How to get to it (user POV)

- MCP tool `bridge` with `{"fromChainKey", "destination": {"chainKey", "address"}, "asset", "amount"}`.
- CLI `bridge --from-chain <key> --to-chain <key> --asset USDC|USDT --amount <smallest unit> --to <address>`.
- The hosted gateway has no bridge tool, so there is nothing to skip.

## Driving it with whale-verify

Preconditions:

- The baseline from `README.md` holds.
- `S="--set OWNER_WITHDRAW_ADDRESSES=$D --set TURNKEY_EVM_ADDRESS=$D"` names `$D` as both the owner destination and the Base hot wallet. Both are public addresses only.
- `bridge_args() { printf '{"fromChainKey":"%s","destination":{"chainKey":"%s","address":"%s"},"asset":"%s","amount":"%s"}' "$@"; }` builds the MCP arguments from source chain, destination chain, destination address, asset, and amount.

- **Rank over MCP.** Ask for 10 USDC from Base to Arbitrum. Run `$W mcp bridge "$(bridge_args base arbitrum $D USDC 10000000)" $S --label bridge-rank-mcp | jq '{plan, fees: [.quotes[] | [.provider, .feeUsd]]}'`. `plan.kind` is `would_send`, `plan.broadcast` is `false`, `plan.quote` equals the first entry of `quotes`, and the fees ascend. The evidence `network` holds one request each to `https://li.quest`, `https://app.across.to`, and `https://api.relay.link`, and `sends` is `[]`.
- **Rank over the CLI.** Run `$W cli $S --label bridge-rank-cli -- bridge --from-chain base --to-chain arbitrum --asset USDC --amount 10000000 --to $D | jq '{plan, fees: [.quotes[] | [.provider, .feeUsd]]}'`. The exit code is 0 and the result has the same shape, hosts, and empty `sends`.
- **Off the allowlist.** Run `$W mcp bridge "$(bridge_args base arbitrum 0x000000000000000000000000000000000000bEEF USDC 10000000)" $S --label bridge-refuse-allowlist-mcp | jq -c .plan`. It prints `{"kind":"skip","reason":"the destination is not on the owner allowlist","quote":null}`.
- **Same chain.** Run `$W mcp bridge "$(bridge_args base base $D USDC 10000000)" $S --label bridge-refuse-same-chain-mcp | jq -r .plan.reason`. It prints `the source and destination chains are the same`.
- **Disabled chain.** Run `$W mcp bridge "$(bridge_args base ethereum $D USDC 10000000)" $S --label bridge-refuse-disabled-mcp | jq -r .plan.reason`. It prints `ethereum is not enabled`.
- **Wrong asset.** Run `$W mcp bridge "$(bridge_args base arbitrum $D WETH 1000000)" $S --label bridge-refuse-asset-mcp | jq -r .plan.reason`. It prints `bridge plans move USDC or USDT only, because the USD caps need a local price`.
- **Over the cap.** Run `$W mcp bridge "$(bridge_args base arbitrum $D USDC 30000000)" $S --label bridge-refuse-cap-mcp | jq -r .plan.reason`. It prints `30 USD is over the 25 USD bridge cap`.
- **No hot wallet.** Leave out the sender. Run `$W mcp bridge "$(bridge_args base arbitrum $D USDC 10000000)" --set OWNER_WITHDRAW_ADDRESSES=$D --label bridge-refuse-sender-mcp | jq -r .plan.reason`. It prints `no hot wallet address is configured for base`.
- **Bad amount over MCP.** Run `$W mcp bridge "$(bridge_args base arbitrum $D USDC 10.5)" $S --label bridge-bad-amount-mcp`. The exit code is 3 (a tool error), and stdout is a validation issue whose `path` is `["amount"]`.
- **Bad amount over the CLI.** Run `$W cli $S --label bridge-bad-amount-cli -- bridge --from-chain base --to-chain arbitrum --asset USDC --amount 10.5 --to $D`. The exit code is 1 and stderr reads `--amount must be a positive whole number in the asset's smallest unit`.
- **Proof.** Run `jq -c '{file: input_filename, sends: (.sends | length), hosts: ([.network[].origin] | unique), plan: ((.result | objects | .plan.kind) // null)}' "$WHALE_VERIFY_EVIDENCE"/*-bridge-*.json`. Every file shows `sends` 0. The two rank files show the three provider hosts and `would_send`. Every refusal and bad-amount file shows no hosts.

## Gotchas

- Fees and routes are live. Assert order and shape, not numbers.
- A provider slower than `BRIDGE_QUOTE_TIMEOUT_MS` (3000) is dropped without an error, so `quotes` can hold fewer than three. Name the missing provider in the report. With no quotes at all, `plan.kind` is `skip`.
- The plan keeps only quotes within `MAX_BRIDGE_FEE_BPS` (50) of the amount. Below about 2 USD every route can exceed it, which gives `skip` with `no bridge quote inside the fee cap and allowlist`. Use 10 USDC.
- LI.FI appears in the ranking even though live bridging skips LI.FI routes, as the repository README explains under "Still open". Ranking is quote-only.
- `amount` is the smallest unit. USDC and USDT have 6 decimals, so `10000000` is 10 USD.
- A refusal that shows any `network` entry is a bug. Whale must refuse before it asks a provider.
- Addresses are checked per chain. A Solana destination needs a Solana address, and a Solana source needs `TURNKEY_SOLANA_ADDRESS`.
