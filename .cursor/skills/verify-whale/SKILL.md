---
name: verify-whale
description: Drive the Whale wallet the way an agent host does, through its stdio MCP server, its CLI, and its executor HTTP, in dry-run only, and capture proof of each call with a network log. Use after changing Whale to prove wallet_status, quote, swap, bridge, balance, or transfer still works end to end, or when asked to verify, smoke-test, or demo Whale behavior.
---

# Verify Whale

Whale is a multichain wallet that AI agents call. Dry-run is the default and this skill never leaves it. The surfaces are:

- **MCP over stdio (primary).** Every host manifest (`.mcp.json`, `mcp.json`, `.claude-plugin`, `.codex-plugin`, `.muse-plugin`) starts `node scripts/mcp-server.mjs`. That entry builds `dist/` when `src/` changed, then serves the tools in `src/mcp-server.ts` (`TOOLS`). Each tool parses into a `WalletCommand` and calls `run`.
- **CLI.** `node dist/src/cli.js quote | swap | bridge | balance | perp-positions | transfer` (`parseCommand` in `src/cli.ts`). It prints one JSON line.
- **Executor HTTP.** `dist/src/executor-server.js` serves `/health`, `/status` (bearer), `/execute`, and `/rebalance`. The MCP tool `wallet_status` reads its `/status`.
- **Not driven here.** The hosted gateway and dashboard (`src/gateway-server.ts`, `web/`) need Postgres, a Google OAuth client, and a signed-in account before an agent key exists. `features/README.md` lists them as unmapped.

## Rules

- Stay in dry-run. The helper builds each child's environment from an allowlist. It refuses `--set` for `WHALE_BROADCAST`, `WHALE_SIGNER_*`, `KEYSTORE_*`, `TURNKEY_API_*`, `TURNKEY_ORGANIZATION_ID`, `TURNKEY_PARENT_*`, `TURNKEY_DELEGATE_*`, `DATABASE_URL`, `WHALE_GATEWAY_URL`, `WHALE_API_KEY`, `HOSTED_*`, `EXECUTOR_*`, `AUTH_TOKEN`, `ADMIN_TOKEN`, and `NODE_OPTIONS`. Do not work around the refusal.
- Never ask for, set, or print a seed phrase or a private key. The recipes use public stand-in addresses such as `0x000000000000000000000000000000000000dEaD`, which no one holds a key for.
- Amounts are smallest-unit strings. 10 USDC is `10000000`.
- Use pnpm, never npm or yarn.

## Helpers

Run everything from the repository root. The helper needs Node 22.12 or later and has no dependencies.

```bash
W=.cursor/skills/verify-whale/scripts/whale-verify.mjs
```

| Command | What it does |
| --- | --- |
| `$W launch` | Installs, builds, and starts a run. Prints `export` lines for `WHALE_VERIFY_RUN` and `WHALE_VERIFY_EVIDENCE` on stdout. |
| `$W doctor` | A read-only health report as JSON. Exits 0 when the run is worth driving. |
| `$W mcp <tool> '<json args>' [--set NAME=VALUE]... [--label name]` | One MCP session through `scripts/mcp-server.mjs`: `initialize`, `notifications/initialized`, `tools/call`. Prints the tool result on stdout and the evidence path on stderr. Exits 0 on a result, 3 on a tool error (`isError`), and 2 when no reply arrives. |
| `$W cli [--set NAME=VALUE]... [--label name] -- <cli args>` | Runs `node dist/src/cli.js <cli args>` and exits with its code. |
| `$W http <METHOD> <route> ['<json body>'] [--no-auth] [--label name]` | Calls the run's executor with the run's token, or without it when `--no-auth` is given. |
| `$W cleanup` | Stops what the run started, removes its scratch state, and keeps its evidence. |

`--set` adds a variable to that one call only. Use it for a feature's preconditions, such as an owner address or an RPC URL.

`scripts/netlog.mjs` is preloaded with `node --import` into every MCP and CLI child. It logs each outbound request and passes it through unchanged. `scripts/harness.mjs` holds the run state, evidence writer, and process handling the commands share.

State lives under `WHALE_VERIFY_HOME`, which defaults to `~/.local/state/whale-verify`. `runs/<id>/` is scratch: the token (mode 0600), the frozen env, logs, and pids. `evidence/<id>/` is the proof.

## Launch

```bash
eval "$($W launch)"
```

Launch runs these steps in order:

1. It runs `pnpm install --frozen-lockfile` when `node_modules/.pnpm/lock.yaml` differs from `pnpm-lock.yaml`.
2. It starts the MCP host entry and lists its tools. That builds `dist/` with `tsc` and writes `dist/.mcp-stamp.json` when `src/` changed.
3. It starts `dist/src/executor-server.js` detached on a free port, with a random 32-byte token, no `DATABASE_URL`, and `WHALE_BROADCAST` unset.
4. It waits until `GET /status` with the token answers `live: false`.
5. It writes `01-launch.json` to the evidence directory.

Ready means stderr shows `whale-verify: ready: executor pid <pid> on 127.0.0.1:<port>, 10 MCP tools` and stdout shows the two `export` lines. These surfaces need no database, migrations, or seed data. Each feature passes its own preconditions with `--set`. A warm launch takes about a second. A rebuild of `dist/` adds about ten seconds.

Launch copies quote keys and RPC URLs from your shell into the run and freezes them for its life: `ZEROX_API_KEY`, `JUPITER_API_KEY`, `LIFI_API_KEY`, `ONEINCH_API_KEY`, `OKX_API_*`, `KYBERSWAP_CLIENT_ID`, `ACROSS_*`, `RELAY_API_KEY`, `COINGECKO_API_KEY`, `HYPERLIQUID_API_URL`, `HYPERLIQUID_ACCOUNT_ADDRESS`, `SOLANA_RPC_URL(S)`, and `RPC_URL(S)_<chainId>`. Export them before you launch. Evidence records their names, never their values.

## Doctor

Run `$W doctor` first, and again whenever anything looks off. It takes under a second and changes nothing. Save it with `$W doctor > "$WHALE_VERIFY_EVIDENCE/doctor.json"`.

| Check | Passes when |
| --- | --- |
| `executor-process` | The recorded pid runs this checkout's `dist/src/executor-server.js`. |
| `executor-health` | `GET /health` answers `{"ok":true}`. |
| `executor-ours-and-dry-run` | `GET /status` with the run token answers 200 with `service` `executor`, `live` false, and `killSwitch` false. |
| `executor-auth` | `GET /status` without the token answers 401. |
| `build-current` | The MCP build stamp is newer than every file in `src/`, and the executor started from the current `dist/`. |
| `env-dry-run` | The run env has no broadcast, signer, gateway, or database setting. |
| `mcp-tools` | `dist/src/mcp-server.js` lists `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`, and writes only JSON to stdout. |

If any check fails, run `$W cleanup` and launch again. A tool in `mcp-tools.detail.tools` that no feature file names needs a feature file.

## Drive

Read `features/README.md`, then follow the recipe in the matching feature file. Each `mcp` call is a fresh server process that exits after its reply. Each `cli` call is one CLI process. Pipe stdout into `jq` for assertions. For example:

```bash
D=0x000000000000000000000000000000000000dEaD
$W mcp bridge '{"fromChainKey":"base","destination":{"chainKey":"arbitrum","address":"'$D'"},"asset":"USDC","amount":"10000000"}' \
  --set OWNER_WITHDRAW_ADDRESSES=$D --set TURNKEY_EVM_ADDRESS=$D --label bridge-rank-mcp | jq '.plan'
```

## Evidence

Every `mcp`, `cli`, and `http` call writes `$WHALE_VERIFY_EVIDENCE/NN-<label>.json`. Each file holds these fields:

- The entry point and the exact tool arguments or CLI argv.
- The env names. Values appear only for public settings (addresses, chain lists, caps), RPC URLs appear as origins, and keys appear as `<set>`.
- The whole JSON-RPC exchange, or stdout, stderr, and the exit code.
- The parsed `result`.
- `network`: one entry per outbound request, with origin, method, path (long segments redacted, query dropped), and JSON-RPC method names.
- `sends`: the entries that would move value. These are `eth_sendRawTransaction`, `eth_sendTransaction`, `sendTransaction`, `sendBundle`, a Hyperliquid `/exchange` post, any Jito block engine call, and an Esplora `POST /tx`.

Hold every proof to these standards:

- Drive the user path: an MCP tool through `scripts/mcp-server.mjs`, or the CLI. Do not call `run()` from a script or test.
- Keep the evidence of every sub-feature, refusals included. Label each call `<sub-feature>-<entry>`, such as `bridge-rank-cli`.
- A dry-run proof shows `sends` empty and `network` naming only the hosts the feature needs. A refusal proof shows `network` empty. Dry-run does reach the network here (bridge providers and RPC reads), so check `network` before you call anything offline.
- The providers and RPCs are real. If one is down, report it. Do not substitute a fake.
- Report an entry point you could not reach as skipped, with the reason. Never count it as verified through another path.

## Cleanup

```bash
$W cleanup
```

Cleanup does these things for the run in `WHALE_VERIFY_RUN`:

- It stops the executor and any MCP or CLI child the run left running. It works by recorded pid and checks `ps` for the expected script first. It never kills by name.
- It copies `executor.log`, `warm.log`, and `install.log` into the evidence directory with the token scrubbed.
- It confirms the port is closed.
- It deletes `runs/<id>/` and prints the evidence file list.

It is safe to run twice. Run it after a failed launch or drive too, before you retry. The evidence stays in `evidence/<id>/` until you delete it. `dist/` and `node_modules/` are the repository's normal gitignored build output and stay.

## Isolation

- Runs can sit side by side. Each has its own port, token, scratch directory, and evidence directory, and each MCP or CLI process lives for one call.
- The helper never passes `WHALE_SIGNER_KEYSTORE`, so no run binds whale-signer's loopback port 8790.
- Runs share `dist/` and `node_modules/` in the checkout. Do not edit `src/` or run `pnpm run build` while another run drives the same checkout. `build-current` catches it afterwards.
- The executor listens on `0.0.0.0`, as it does in production. The random token guards it.
- Never drive an executor or MCP server this run did not launch, such as one a person started with `pnpm run start:executor` on port 8788.

## Keeping it current

Keep `features/` in step with `TOOLS` in `src/mcp-server.ts` and `parseCommand` in `src/cli.ts`. Use `/maintain-verification-skill` when the app changes.
