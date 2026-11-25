# Swap and quote

Quote asks Whale's aggregator race for a route. A dry-run swap first checks that both sides are on one enabled chain and that the slippage is within the cap. It then quotes the best signable route and returns `would_swap`, or returns `skipped` with the reason. Nothing is signed or broadcast.

## Sub-features

- `quote-skip` returns `skipped` with `no quote provider` when no quote key is set.
- `quote-quoted` returns `quoted` with a route when a quote key is set.
- `swap-no-provider` returns `skipped` with `no quote provider` when no quote key is set.
- `swap-would-swap` returns `would_swap` with a signable route when a quote key is set.
- `swap-guard-slippage` refuses slippage above `MAX_SLIPPAGE_BPS`, which defaults to 100.
- `swap-guard-cross-chain` refuses a swap whose sell and buy chains differ.
- `swap-guard-disabled` refuses a chain in `DISABLED_CHAINS`.
- `swap-live-mcp` shows that an MCP swap with `mode` `live` and no whale-signer runs as a dry run.
- `swap-live-cli` shows that a CLI `swap --live` with `WHALE_BROADCAST` unset returns a skipped live report.

## How to get to it (user POV)

- MCP tools `quote` and `swap`.
- CLI `quote` and `swap`, with `--sell-*`, `--buy-*`, `--sell-amount`, and `--slippage-bps`. `swap` also needs `--idempotency-key`.
- Hosted gateway MCP tools `quote` and `swap`. This harness cannot reach them, because they need Postgres, Google sign-in, and an agent key. Report them as skipped.

## Driving it with whale-verify

Preconditions:

- The baseline from `README.md` holds.
- `quote-quoted` and `swap-would-swap` need one of `ZEROX_API_KEY`, `JUPITER_API_KEY`, `LIFI_API_KEY`, `ONEINCH_API_KEY`, or `OKX_API_KEY` exported before launch. Without one, report those two as skipped with `no quote key`, and drive `quote-skip` and `swap-no-provider` instead.
- `CLI_PAIR="--sell-chain base --sell-address 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --sell-symbol USDC --sell-decimals 6 --buy-chain base --buy-address 0x4200000000000000000000000000000000000006 --buy-symbol WETH --buy-decimals 18 --sell-amount 1000000 --slippage-bps 50"`.

- **Swap with no key over MCP.** Sell 1 USDC for WETH on Base. Run `$W mcp swap "{\"idempotencyKey\":\"verify-swap-1\",\"sell\":$BASE_USDC,\"buy\":$BASE_WETH,\"sellAmount\":\"1000000\",\"slippageBps\":50}" --label swap-no-provider-mcp`. It prints `{"kind":"swap","status":"skipped","quote":null,"reason":"no quote provider"}`, and `network` is `[]`.
- **Swap with a key over MCP.** Run the same command with `--label swap-would-swap-mcp`. `status` is `would_swap`, `quote.chainKey` is `base`, `quote.signable` is not false, `quote.buyAmount` is a positive whole-number string, and `reason` starts with `dry-run:`. `network` names only quote-provider hosts, and `sends` is `[]`.
- **Swap over the CLI.** Run `$W cli --label swap-no-provider-cli -- swap --idempotency-key verify-swap-2 $CLI_PAIR`. The exit code is 0, with the same result as the MCP call for the same keys. With a key, label it `swap-would-swap-cli`.
- **Slippage cap.** Run `$W mcp swap "{\"idempotencyKey\":\"verify-swap-3\",\"sell\":$BASE_USDC,\"buy\":$BASE_WETH,\"sellAmount\":\"1000000\",\"slippageBps\":500}" --label swap-guard-slippage-mcp | jq -r .reason`. It prints `slippage exceeds 100 bps`.
- **Cross chain.** Run `$W mcp swap "{\"idempotencyKey\":\"verify-swap-4\",\"sell\":$BASE_USDC,\"buy\":$ARB_USDC,\"sellAmount\":\"1000000\",\"slippageBps\":50}" --label swap-guard-cross-chain-mcp | jq -r .reason`. It prints `a swap sells and buys on one chain. use bridge to move between base and arbitrum`.
- **Disabled chain.** Run `$W mcp swap "{\"idempotencyKey\":\"verify-swap-5\",\"sell\":$BASE_USDC,\"buy\":$BASE_WETH,\"sellAmount\":\"1000000\",\"slippageBps\":50}" --set DISABLED_CHAINS=base --label swap-guard-disabled-mcp | jq -r .reason`. It prints `chain base is disabled`.
- **Live over MCP.** Run `$W mcp swap "{\"idempotencyKey\":\"verify-swap-6\",\"sell\":$BASE_USDC,\"buy\":$BASE_WETH,\"sellAmount\":\"1000000\",\"slippageBps\":50,\"mode\":\"live\",\"notionalUsd\":1}" --label swap-live-mcp`. The result has `status` and no `report`, exactly like the dry-run call. With no key it is `skipped` with `no quote provider`.
- **Live over the CLI.** Run `$W cli --label swap-live-cli -- swap --idempotency-key verify-swap-7 $CLI_PAIR --live --notional-usd 1 | jq -c .report`. `mode` is `live`, `decision` is `skipped`, and `reason` is `WHALE_BROADCAST is unset, so this live swap was skipped`.
- **Quote over MCP.** Run `$W mcp quote "{\"sell\":$BASE_USDC,\"buy\":$BASE_WETH,\"sellAmount\":\"1000000\",\"taker\":null,\"slippageBps\":50}" --label quote-skip-mcp`. With no key it prints `{"kind":"quote","status":"skipped","quote":null,"reason":"no quote provider"}`. With a key, label it `quote-quoted-mcp`; `status` is `quoted` and `quote.buyAmount` is positive.
- **Quote over the CLI.** Run `$W cli --label quote-skip-cli -- quote $CLI_PAIR`. The exit code is 0, with the same result as the MCP quote.
- **Proof.** Run `jq -c '{file: input_filename, status: (.result.status // .result.report.decision), reason: (.result.reason // .result.report.reason), sends: (.sends | length), hosts: ([.network[].origin] | unique)}' "$WHALE_VERIFY_EVIDENCE"/*-swap-*.json "$WHALE_VERIFY_EVIDENCE"/*-quote-*.json`. Every file shows `sends` 0. Guard and no-key files show no hosts.

## Gotchas

- Whale asks no aggregator until one of the five quote keys is set, even though KyberSwap and Velora need no key. Without a key, every quote and swap stops at `no quote provider` before any network call.
- The seeding run had no quote key, so `swap-would-swap` and `quote-quoted` are unproven. The first run with a key should confirm their hosts and result shape and correct this file.
- An MCP `swap` with `mode` `live` and no whale-signer runs as a dry run and returns a dry-run result. Do not report that as a refused live swap.
- A CLI `swap --live` with `WHALE_BROADCAST=true` would post to the executor's `/execute`. The helper refuses `WHALE_BROADCAST`, so that path stays out of reach.
- The race has a 500 ms total deadline (`QUOTE_DEADLINE_MS`) and 350 ms per provider. A slow network gives `no quote` rather than an error. Retry once before you report it.
- `sellAmount` is the smallest unit, so `1000000` is 1 USDC. The idempotency key is not recorded in dry-run. Use a fresh one per call so the evidence reads clearly.
