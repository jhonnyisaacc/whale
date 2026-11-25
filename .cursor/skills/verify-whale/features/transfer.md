# Transfer

Transfer lets an agent plan sending an asset to an owner address. In dry-run it returns `would_send` and sends nothing. A live transfer needs whale-signer, which this harness never configures, so live returns `skipped` with the reason.

## Sub-features

- `transfer-would-send` returns `would_send` with the amount and destination in its reason, and makes no network call.
- `transfer-live-skipped` returns `skipped` for an MCP transfer with `mode` `live` when whale-signer is absent.

## How to get to it (user POV)

- MCP tool `transfer` with `{"idempotencyKey", "asset", "to", "amount", "mode"}`. `mode` defaults to `dry_run`.
- CLI `transfer --idempotency-key <key> --asset-chain <key> --asset-address <address> --asset-symbol <symbol> [--asset-decimals <n>] --to <address> --amount <smallest unit>`. The CLI is always dry-run.
- Hosted gateway MCP tool `transfer`. This harness cannot reach it, because it needs Postgres, Google sign-in, and an agent key. Report it as skipped.

## Driving it with whale-verify

Preconditions:

- The baseline from `README.md` holds.

- **Dry-run over MCP.** Plan 1 USDC on Base to `$D`. Run `$W mcp transfer "{\"idempotencyKey\":\"verify-transfer-1\",\"asset\":$BASE_USDC,\"to\":\"$D\",\"amount\":\"1000000\"}" --label transfer-would-send-mcp`. It prints `{"kind":"transfer","status":"would_send","reason":"dry-run transfer of 1000000 to 0x000000000000000000000000000000000000dEaD. nothing was broadcast"}`, and `network` is `[]`.
- **Dry-run over the CLI.** Run `$W cli --label transfer-would-send-cli -- transfer --idempotency-key verify-transfer-2 --asset-chain base --asset-address 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --asset-symbol USDC --asset-decimals 6 --to $D --amount 1000000`. The exit code is 0 and stdout is the same `would_send` result.
- **Live without whale-signer.** Run `$W mcp transfer "{\"idempotencyKey\":\"verify-transfer-3\",\"asset\":$BASE_USDC,\"to\":\"$D\",\"amount\":\"1000000\",\"mode\":\"live\"}" --label transfer-live-skipped-mcp | jq -c '{status, reason}'`. It prints `{"status":"skipped","reason":"a live transfer needs whale-signer. set WHALE_SIGNER_KEYSTORE and run whale-signer serve"}`, and `network` is `[]`.
- **Proof.** Run `jq -c '{file: input_filename, status: .result.status, network: (.network | length)}' "$WHALE_VERIFY_EVIDENCE"/*-transfer-*.json`. Every file shows `network` 0.

## Gotchas

- A dry-run transfer checks neither `OWNER_WITHDRAW_ADDRESSES`, nor the asset, nor the amount. Any `to` gets `would_send`. The allowlist and the USD caps apply only on the live path, so `would_send` does not prove a destination is allowed.
- Dry-run makes no network call at all. Any `network` entry in a transfer file is a bug.
- The reason echoes the amount in the smallest unit, not in USDC.
