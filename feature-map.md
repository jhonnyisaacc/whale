# Feature map

Each row names a feature and the check that proves it. Add a row when a feature moves.

| Feature | Check |
| --- | --- |
| Quote, swap, bridge, balance, and transfer share one command union | `pnpm test`. `test/commands.test.ts` covers the dispatcher. |
| A dry-run swap does not broadcast, and a quote with no provider skips | `pnpm test`. The command and executor tests cover it. |
| Bridge ranking refuses an empty allowlist and does not broadcast | `pnpm test`. The command and controls tests cover it. |
| Live send is screened, simulated, reserved, and policy checked | `pnpm test`. The send-path and security-review tests cover it. |
| Withdraw needs the admin token, the allowlist, and the per-call cap | `pnpm test`. The custody and controls tests cover it. |
| Installs wait a week, keep publisher trust, run no dependency scripts, and pin every version and action | `pnpm test`. `test/supply-chain.test.ts` covers it. |
| No file grows past the agent budget | `node scripts/check-file-size.mjs` |
| Layers keep their import rules | `node scripts/check-boundaries.mjs` |
| Migrations apply once under a lock, refuse a changed file, and the tenant schema refuses cross-account links | `pnpm test` with `TEST_DATABASE_URL`. `test/migrate.test.ts` and `test/tenancy-pg.test.ts` cover it. CI runs Postgres. |
| Google sign-in verifies the ID token, keys the account by subject, and opens a hashed, expiring session; cross-origin posts get 403 | `pnpm test`. `test/gateway-auth.test.ts`, and `test/gateway-pg.test.ts` with `TEST_DATABASE_URL`. `pnpm run smoke` boots the gateway. |
