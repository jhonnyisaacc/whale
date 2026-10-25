# Feature map

Each row names a feature and the check that proves it. Add a row when a feature moves.

| Feature | Check |
| --- | --- |
| Quote, swap, bridge, balance, and transfer share one command union | `npm test`. `test/commands.test.ts` covers the dispatcher. |
| A dry-run swap does not broadcast, and a quote with no provider skips | `npm test`. The command and executor tests cover it. |
| Bridge ranking refuses an empty allowlist and does not broadcast | `npm test`. The command and controls tests cover it. |
| Live send is screened, simulated, reserved, and policy checked | `npm test`. The send-path and security-review tests cover it. |
| Withdraw needs the admin token, the allowlist, and the per-call cap | `npm test`. The custody and controls tests cover it. |
| No file grows past the agent budget | `node scripts/check-file-size.mjs` |
| Layers keep their import rules | `node scripts/check-boundaries.mjs` |
