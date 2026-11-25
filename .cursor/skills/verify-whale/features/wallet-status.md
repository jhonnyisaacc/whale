# Wallet status

Wallet status lets an agent read the executor's mode and limits before it tries to move value: whether it is live, whether the kill switch is on, the per-trade and daily USD caps, the slippage and leverage caps, and the enabled chains. It moves no money.

## Sub-features

- `status-read` returns the executor's public config, with `live` false in dry-run.
- `status-auth` refuses `/status` without the executor token.

## How to get to it (user POV)

- MCP tool `wallet_status` with `{}`. It reads `GET /status` on `EXECUTOR_URL` with `EXECUTOR_AUTH_TOKEN`.
- HTTP `GET /status` on the executor with `Authorization: Bearer <executor token>`.
- Hosted gateway MCP tool `wallet_status` over `POST /mcp`. This harness cannot reach it, because it needs Postgres, Google sign-in, and an agent key. Report it as skipped.
- The CLI has no status command.

## Driving it with whale-verify

Preconditions:

- The baseline from `README.md` holds.

- **Read over MCP.** Run `$W mcp wallet_status --label status-read-mcp | jq -c '{live, killSwitch, maxUsdPerTrade, dailyUsdCap, maxSlippageBps, maxLeverage, enabledChainKeys}'`. `live` is false, `killSwitch` is false, `maxUsdPerTrade` is 5, `dailyUsdCap` is 25, `maxSlippageBps` is 100, and `maxLeverage` is 3. `enabledChainKeys` includes `base`, `arbitrum`, `solana`, and `hypercore`, and lacks `ethereum` and `monad`. The evidence `network` is a single `GET` to `http://127.0.0.1:<run port>/status`.
- **Read over HTTP.** Run `$W http GET /status --label status-read-http | jq -c '{status, live: .body.live}'`. It prints `{"status":200,"live":false}`, and the body matches the MCP read.
- **Refuse without the token.** Run `$W http GET /status --no-auth --label status-auth-http`. It prints `{"status":401,"body":{"error":"unauthorized"}}`.
- **Proof.** Run `jq -c '{file: input_filename, live: .result.live, status: .status}' "$WHALE_VERIFY_EVIDENCE"/*-status-*.json`. The two read files show `live` false. The auth file shows status 401.

## Gotchas

- `wallet_status` returns the executor's reply as is. With a wrong token the tool still exits 0 and prints `{"error":"unauthorized"}`, so assert on `.live`, not on the exit code.
- With the executor down, the tool returns a tool error (exit 3) carrying the fetch failure.
- The run's executor always boots with the default caps, because launch passes it only provider keys and RPC URLs. Assert the defaults above. `--set` on an `mcp` call changes the MCP process, not the executor.
- `screening` is false in dry-run, because `TOKEN_SCREENING` defaults to the live flag.
