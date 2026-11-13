# Whale

Multichain wallet for AI agents. EVM and Solana. Dry-run is the default. Live signing goes through Turnkey. The local keystore never signs live.

## Map

- `src/commands.ts` is the public command union. `src/domain.ts` holds the engine types. `src/chains.ts` holds the chain table. Neither domain nor chains imports a service.
- `src/cli.ts` and `src/mcp-server.ts` parse into a `WalletCommand` and call `run`.
- `src/config/` loads and guards config. `src/config.ts` is a barrel.
- `src/aggregators/` races and firms quotes. `src/aggregators.ts` is a barrel.
- `src/broadcast/` sends EVM, Solana, and Hypercore transactions. `src/broadcast.ts` is a barrel plus the route orchestrator.
- `src/executor/` holds withdraw and quote planning. `src/executor.ts` holds the execute state machine.
- `src/executor-server.ts` is the HTTP entry. There is no resolver.
- `src/signing-policy.ts` is the last check before any signature. A change here is a security change.
- `src/gateway-server.ts` and `src/gateway/` are the public process from ADR 0003: sign-in, sessions, and the dashboard API. It holds no signing credential and imports no signer, sender, or executor module.
- `signer/` is the self-hosted Rust signer. Crates are pinned with `=`, `Cargo.lock` is committed, and `vectors/` is regenerated with `node signer/vectors/generate.mjs`. A change to `signer/src/policy.rs` is a security change.
- `web/` is the dashboard: Vite and React, no UI or state library. The gateway serves `web/dist`. Passkey ceremonies and the Turnkey delegation step run in the browser under the user's passkey.
- `src/db/` runs the numbered SQL files in `migrations/`. A shipped migration never changes. Add the next number instead.

## Rules an agent cannot infer

- Keep every file at or under about 5,000 tokens. Split by feature. Keep the old import path as a barrel.
- Run `pnpm run check` before a PR. It runs the file-size ratchet, the import boundaries, the build, and the tests.
- Use pnpm, never npm or yarn. Install with `pnpm install --frozen-lockfile`. Do not weaken `pnpm-workspace.yaml`. `test/supply-chain.test.ts` pins it. A new dependency needs a reason in the PR.
- Never ask a user or an agent for a seed phrase or a private key. Never print one.
- Amounts cross boundaries in the smallest unit. A decimal string is a display value only.
- A live send needs screening, simulation, the spend reservation, and the signing policy. Do not add a path that skips one.
- Listing match and watchlist refresh do not belong here. A strategy calls `run` with a `WalletCommand`.

## Verify

`pnpm run check` in this directory. See `feature-map.md` for what each feature check proves.
