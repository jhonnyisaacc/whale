# Balance

Balance lets an agent read holdings for one chain and address: the native coin on an EVM chain, and SOL plus every SPL token on Solana. It moves no money and prices nothing.

## Sub-features

- `balance-evm` reads the native balance through `RPC_URL_<chainId>`.
- `balance-solana` reads SOL and SPL token holdings through `SOLANA_RPC_URL`.
- `balance-no-rpc` returns no holdings and the reason `RPC_URL_<chainId> is unset`.
- `balance-unknown-chain` returns no holdings and the reason `unknown chain <key>`.

## How to get to it (user POV)

- MCP tool `balance` with `{"chainKey", "address"}`.
- CLI `balance --chain <key> --address <address>`.
- Hosted gateway MCP tool `balance`. This harness cannot reach it, because it needs Postgres, Google sign-in, and an agent key. Report it as skipped.

## Driving it with whale-verify

Preconditions:

- The baseline from `README.md` holds.
- The public RPCs `https://mainnet.base.org`, `https://arb1.arbitrum.io/rpc`, and `https://api.mainnet-beta.solana.com` are reachable.

- **EVM over MCP.** Run `$W mcp balance "{\"chainKey\":\"base\",\"address\":\"$D\"}" --set RPC_URL_8453=https://mainnet.base.org --label balance-evm-mcp | jq -c '.holdings[0]'`. There is one holding with `symbol` `ETH`, `native` true, `decimals` 18, `chainKey` `base`, `usd` 0, and `amount` above 0. `network` holds `eth_chainId` and `eth_getBalance` to `https://mainnet.base.org`, and `sends` is `[]`.
- **EVM over the CLI.** Run `$W cli --set RPC_URL_42161=https://arb1.arbitrum.io/rpc --label balance-evm-cli -- balance --chain arbitrum --address $D | jq -c '.holdings[0]'`. The exit code is 0, with one `ETH` holding on `arbitrum`.
- **Solana over MCP.** Read the wrapped-SOL mint account, which holds SOL and SPL tokens. Run `$W mcp balance '{"chainKey":"solana","address":"So11111111111111111111111111111111111111112"}' --set SOLANA_RPC_URL=https://api.mainnet-beta.solana.com --label balance-solana-mcp | jq -c '[.holdings[] | {symbol, native, raw, decimals}] | .[0:3]'`. The first holding is `SOL` with `native` true, `decimals` 9, and a `raw` lamport string. Each later holding has a mint address as `symbol`, `native` false, and a `raw` string. `network` holds one `getBalance` and two `getTokenAccountsByOwner` calls.
- **No RPC.** Run `$W mcp balance "{\"chainKey\":\"base\",\"address\":\"$D\"}" --label balance-no-rpc-mcp`. It prints `{"kind":"balance","holdings":[],"reason":"RPC_URL_8453 is unset"}`, and `network` is `[]`.
- **Unknown chain.** Run `$W mcp balance "{\"chainKey\":\"nochain\",\"address\":\"$D\"}" --label balance-unknown-chain-mcp | jq -r .reason`. It prints `unknown chain nochain`.
- **Proof.** Run `jq -c '{file: input_filename, count: (.result.holdings | length), reason: .result.reason, rpc: [.network[].rpc[]?], sends: (.sends | length)}' "$WHALE_VERIFY_EVIDENCE"/*-balance-*.json`. The reads show read-only RPC methods and `sends` 0. The reason files show no RPC calls.

## Gotchas

- The balance read uses only `RPC_URL_<chainId>` or `SOLANA_RPC_URL`. It ignores the chain table's default RPC and the `RPC_URLS_` lists, so pass one with `--set`.
- If you exported `RPC_URL_8453` before launch, the no-RPC recipe reads a balance instead. Run it on a chain you did not export, such as `linea` with `RPC_URL_59144`.
- EVM reads cover the native coin only, not ERC-20 tokens. Only Solana rows carry `raw`.
- `amount` is a display number. `raw` is the smallest unit. `usd` is always 0.
- The public Solana RPC rate-limits. A refused read gives the reason `the solana RPC did not return a balance`. Retry, or export your own `SOLANA_RPC_URL` before launch.
- The burn address keeps receiving coins. Assert shape and a positive amount, not a number.
